#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema, } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from 'child_process';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createTwoFilesPatch } from 'diff';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Command line argument parsing（提前到日志模块之前，因为日志模块需要 args 解析 --log-dir）
const args = process.argv.slice(2);

// === 日志模块 ===
// 每次启动生成独立日志文件，便于排查瞬时无响应问题
// 日志目录默认 ~/.wsl-rwx-7/logs/，可用 --log-dir= 覆盖
// 文件名格式：wsl-rwx-7-YYYYMMDD-HHmmss-sss.log
// 注意：MCP 协议用 stdout 传输 JSON-RPC，日志只写文件 + stderr，绝不污染 stdout
function getLogDir(): string {
  const logDirArg = args.find(arg => arg.startsWith('--log-dir='));
  const logDir = logDirArg ? logDirArg.split('=')[1] : path.join(os.homedir(), '.wsl-rwx-7', 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (e) {
    // 创建失败则降级到临时目录
    const fallback = path.join(os.tmpdir(), 'wsl-rwx-7-logs');
    try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
    return fallback;
  }
  return logDir;
}

function formatTimestamp(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

const LOG_DIR = getLogDir();
const SESSION_START = new Date();
const LOG_FILE = path.join(LOG_DIR, `wsl-rwx-7-${formatTimestamp(SESSION_START)}.log`);
const SESSION_ID = LOG_FILE.slice(-28, -4); // 用于进程内标识

let logStream: fs.WriteStream | null = null;
try {
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
} catch (e) {
  // 极端情况：连文件都创建不了，退化到只 stderr
}

function log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', msg: string, data?: unknown): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [${SESSION_ID}] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`;
  // 写文件
  try { logStream?.write(line); } catch {}
  // 写 stderr（不污染 stdout）
  process.stderr.write(line);
}

// 进程退出钩子：确保日志落盘
process.on('exit', () => {
  log('INFO', 'process exit', { pid: process.pid, uptime: process.uptime() });
  try { logStream?.end(); } catch {}
});
process.on('SIGINT', () => {
  log('WARN', 'received SIGINT', { pid: process.pid });
  try { logStream?.end(); } catch {}
  process.exit(130);
});
process.on('SIGTERM', () => {
  log('WARN', 'received SIGTERM', { pid: process.pid });
  try { logStream?.end(); } catch {}
  process.exit(143);
});
process.on('uncaughtException', (err) => {
  log('ERROR', 'uncaughtException', { name: err.name, message: err.message, stack: err.stack });
  try { logStream?.end(); } catch {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log('ERROR', 'unhandledRejection', { reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : String(reason) });
});

log('INFO', 'session started', { pid: process.pid, logFile: LOG_FILE, args: process.argv.slice(2) });

// 脚本中使用的类型接口定义
interface WslDistribution {
  name: string;
  state: string;
  version: string;
  isDefault: boolean;
}

interface WslFileStats {
  size: number;
  birthtime: Date;
  mtime: Date;
  atime: Date;
  mode: number;
  isDirectory: () => boolean;
  isFile: () => boolean;
}

interface FileEntry {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
}

interface TreeEntry {
  name: string;
  type: 'file' | 'directory';
  children?: TreeEntry[];
}

interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

interface EditOperationType {
  oldText: string;
  newText: string;
}

// Command line argument parsing（续）
const distroArg = args.find(arg => arg.startsWith('--distro='));
let allowedDistro: string | null = distroArg ? distroArg.split('=')[1] : null;
const pathArgs = args.filter(arg => !arg.startsWith('--'));

// === 新增：命令执行相关配置参数 ===
const forbiddenCommandsArg = args.find(arg => arg.startsWith('--forbidden-commands='));
const forbiddenCommands: string[] = forbiddenCommandsArg
  ? forbiddenCommandsArg.split('=')[1].split(',').map(c => c.trim().toLowerCase()).filter(Boolean)
  : ['rm -rf /', 'rm -rf /*', 'mkfs', 'dd if=', 'dd of=/dev/', 'shutdown', 'reboot', 'systemctl', 'sudo', ':(){'];

const execTimeoutArg = args.find(arg => arg.startsWith('--exec-timeout='));
const execTimeoutMs: number = execTimeoutArg ? parseInt(execTimeoutArg.split('=')[1], 10) : 30000;

const maxOutputArg = args.find(arg => arg.startsWith('--max-output='));
const maxOutputBytes: number = maxOutputArg ? parseInt(maxOutputArg.split('=')[1], 10) : 1024 * 1024;

if (pathArgs.length === 0) {
  console.error("Usage: wsl-rwx-7 [--distro=name] [--exec-timeout=ms] [--max-output=bytes] <allowed-directory> [additional-directories...]");
  process.exit(1);
}

// 路径工具函数，遵循 Linux 路径约定
function normalizePath(p: string): string {
  // Windows 反斜杠转 Linux 正斜杠
  p = p.replace(/\\/g, '/');
  // 合并连续斜杠
  p = p.replace(/\/+/g, '/');
  // 处理 . 和 ..
  const parts = p.split('/');
  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '.')
      continue;
    if (part === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..') {
        result.pop();
      }
      else {
        result.push('..');
      }
    }
    else if (part !== '') {
      result.push(part);
    }
  }
  let normalized = result.join('/');
  if (p.startsWith('/'))
    normalized = '/' + normalized;
  if (p.endsWith('/') && normalized !== '/')
    normalized += '/';
  return normalized || '.';
}

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    // WSL 中用 $HOME 获取家目录
    return `$HOME${filepath.slice(1)}`;
  }
  return filepath;
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

function resolve(...paths: string[]): string {
  let resolvedPath = '';
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    if (isAbsolute(path)) {
      resolvedPath = path;
    }
    else {
      if (!resolvedPath)
        resolvedPath = process.cwd().replace(/\\/g, '/');
      resolvedPath = `${resolvedPath}/${path}`;
    }
  }
  return normalizePath(resolvedPath);
}

function dirname(p: string): string {
  const normalized = normalizePath(p);
  if (normalized === '/')
    return '/';
  if (!normalized.includes('/'))
    return '.';
  const lastSlashIndex = normalized.lastIndexOf('/');
  if (lastSlashIndex === 0)
    return '/';
  if (lastSlashIndex === -1)
    return '.';
  return normalized.slice(0, lastSlashIndex);
}

function join(...paths: string[]): string {
  return normalizePath(paths.join('/'));
}

function isUtf16(str:string) {
  return str.indexOf('\0') !== -1;
}

function processOutput(output:string) {
  let lines;
  
  if (isUtf16(output)) {
    // UTF-16 编码
    const buffer = Buffer.from(output);
    const text = buffer.toString('utf16le');
    lines = text.trim().split('\n').slice(1);
  } else {
    // UTF-8 编码
    lines = output.toString().trim().split('\n').slice(1);
  }
  
  // 清除残留的回车符
  return lines.map(line => line.replace(/\r/g, '').trim());
}

/**
 * 执行 Windows 侧命令（不经过 bash），用于 wsl.exe 自身的子命令如 --list。
 */
function runWindowsCommand(exe: string, args: string[], timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '', stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error(`Command timed out: ${exe} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.on('error', (err: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      reject(new Error(`Failed to spawn ${exe}: ${err.message}`));
    });
    child.on('close', (code: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${exe} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

// 列出 WSL 发行版
async function listWslDistributions(): Promise<WslDistribution[]> {
  try {
    const stdout = await runWindowsCommand('wsl', ['--list', '--verbose']);
    const lines = processOutput(stdout);

    return lines.map(line => {
      const isDefault = line.trim().startsWith('*');
      const parts = line.trim().replace(/^\*\s*/, '').split(/\s+/);
      return {
        name: parts[0],
        state: parts[1],
        version: parts[2],
        isDefault
      };
    });
  } catch (error) {
    console.error("获取 WSL 发行版列表失败:", error);
    return [];
  }
}

// 检查可用发行版并确定默认发行版
async function setupWslDistribution(): Promise<string> {
  const distributions = await listWslDistributions();

  if (distributions.length === 0) {
    console.error("系统上未找到任何 WSL 发行版。");
    process.exit(1);
  }

  // 未指定发行版时使用默认发行版
  if (!allowedDistro) {
    const defaultDistro = distributions.find(d => d.isDefault);
    if (defaultDistro) {
        allowedDistro = defaultDistro.name;
    } else {
        // 没有标记默认发行版时使用第一个
        allowedDistro = distributions[0].name;
    }
  } else {
    // 检查指定的发行版是否存在
    const exists = distributions.some(d => d.name.toLowerCase() === allowedDistro!.toLowerCase());
    if (!exists) {
      console.error(`WSL 发行版 '${allowedDistro}' 不存在。可用发行版：`);
      distributions.forEach(d => console.error(`- ${d.name}`));
      process.exit(1);
    }
  }

  console.error(`使用 WSL 发行版：${allowedDistro}`);
  return allowedDistro!;
}

let allowedDirectories: string[] = [];

// 初始化 WSL 发行版并等待配置完成
async function initializeWslAndDirectories(): Promise<void> {
  try {
    await setupWslDistribution();

    allowedDirectories = pathArgs.map(dir => normalizePath(resolve(expandHome(dir))));

    await validateDirectories();
  } catch (error) {
    console.error("Erreur lors de l'initialisation:", error);
    process.exit(1);
  }
}

/**
 * bash 单引号字符串转义。
 * 在 bash 中，单引号内所有字符都是字面量（$、`、\、" 均不解释），
 * 唯一无法直接包含的是单引号本身。用 '\'' 模式：
 *   关闭单引号 → 转义单引号 → 重新打开单引号
 * 这是 bash 中唯一安全的字符串包裹方式。
 */
function escapeBashSingleQuoted(s: string): string {
  return s.replace(/'/g, "'\\''");
}

interface WslExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * 通过 bash -ls 执行 bash 脚本，脚本内容经由 stdin 传入。
 *
 * -l (login shell)：加载 /etc/profile、~/.profile 等，使用户在 ~/.profile
 *   中定义的环境变量（如 GOROOT、PATH 等）在命令执行时可用。
 * -s：从 stdin 读取脚本。
 *
 * 这是从 Windows 调用 WSL 最安全的方式：
 *   Windows CreateProcess → wsl.exe → bash -ls（从 stdin 读脚本）
 *
 * 脚本完全不经过 Windows 命令行参数解析，因此不存在多层 shell 转义问题。
 * Windows 层只看到固定参数 ['wsl', '-d', distro, 'bash', '-ls']。
 */
function wslBashScript(
  script: string,
  options: { timeoutMs?: number } = {}
): Promise<WslExecResult> {
  const { timeoutMs = execTimeoutMs } = options;
  const distroArgs = allowedDistro ? ['-d', allowedDistro] : [];
  const args = [...distroArgs, 'bash', '-ls'];

  return new Promise((resolve, reject) => {
    const child = spawn('wsl', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to spawn wsl.exe: ${err.message}`));
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ stdout, stderr, code: code ?? 0 });
    });

    child.stdin.write(script, 'utf8');
    child.stdin.end();
  });
}

/**
 * 在 WSL 中执行单条命令（通过 bash -s）。
 * 非零退出码会抛出异常，异常信息包含 stderr。
 */
async function execWslCommand(command: string): Promise<string> {
  const { stdout, stderr, code } = await wslBashScript(command + '\n');
  if (code !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
    throw new Error(`WSL command failed: ${detail}`);
  }
  return stdout.trim();
}

/**
 * 在 WSL 中执行管道命令链（通过 bash -s）。
 * 每个元素用 | 连接，整体作为 bash 脚本执行。
 */
async function execWslPipeline(commands: string[]): Promise<string> {
  if (commands.length === 0) {
    throw new Error("No commands provided");
  }
  const script = commands.join(' | ') + '\n';
  const { stdout, stderr, code } = await wslBashScript(script);
  if (code !== 0) {
    throw new Error(`WSL pipeline failed: ${stderr.trim() || `exit code ${code}`}`);
  }
  return stdout.trim();
}

// 将 Windows 路径转换为 WSL 路径
// 注意：只做路径归一化，不做 shell 转义。
// 所有调用方必须用 escapeBashSingleQuoted(toWslPath(p)) 包裹后再嵌入 bash 脚本。
function toWslPath(windowsPath: string): string {
  return normalizePath(windowsPath);
}

// 通过 WSL 进行文件操作的工具函数
async function wslStat(filePath: string): Promise<WslFileStats> {
  const wslPath = toWslPath(filePath);
  const safePath = escapeBashSingleQuoted(wslPath);
  try {
    const result = await execWslCommand(`stat -c '%s %Y %X %W %a %F' '${safePath}'`);
    const [size, mtime, atime, birthtime, permissions, type] = result.split(' ');
    return {
      size: parseInt(size),
      birthtime: new Date(parseInt(birthtime) * 1000),
      mtime: new Date(parseInt(mtime) * 1000),
      atime: new Date(parseInt(atime) * 1000),
      mode: parseInt(permissions, 8),
      isDirectory: () => type.includes('directory'),
      isFile: () => type.includes('regular file')
    };
  } catch (error: any) {
    throw new Error(`Failed to stat ${filePath}: ${error.message}`);
  }
}

async function wslReaddir(dirPath: string): Promise<FileEntry[]> {
  const wslPath = toWslPath(dirPath);
  const safePath = escapeBashSingleQuoted(wslPath);
  try {
    // ls -la 过滤掉 . 和 ..（tail -n +3 从第 3 行开始）
    const result = await execWslCommand(
      `ls -la '${safePath}' | tail -n +3`
    );
    if (!result)
      return [];

    return result.split('\n').map(line => {
      // 典型格式："drwxr-xr-x 2 user group 4096 Jan 1 12:34 dirname"
      const parts = line.trim().split(/\s+/);
      // 名称可能含空格，取第 9 列之后的所有内容
      const name = parts.slice(8).join(' ');
      const isDir = line.startsWith('d');

      return {
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir
      };
    }).filter(entry => entry.name !== '.' && entry.name !== '..');
  } catch (error: any) {
    throw new Error(`Failed to read directory ${dirPath}: ${error.message}`);
  }
}

async function wslReadFile(filePath: string, encoding: string = 'utf-8'): Promise<string> {
  const wslPath = toWslPath(filePath);
  const safePath = escapeBashSingleQuoted(wslPath);
  try {
    return await execWslCommand(`cat '${safePath}'`);
  } catch (error: any) {
    throw new Error(`Failed to read file ${filePath}: ${error.message}`);
  }
}

async function wslWriteFile(filePath: string, content: string): Promise<void> {
  const wslPath = toWslPath(filePath);
  const escapedPath = escapeBashSingleQuoted(wslPath);

  // 使用 heredoc 写入文件：
  //   cat > 'path' <<'DELIM'
  //   content
  //   DELIM
  //
  // 优势：
  // 1. 内容通过 bash -s 的 stdin（脚本）传入，完全不经过 Windows 命令行参数
  // 2. <<'DELIM' 带引号，bash 不展开内容中的 $、`、\ 等特殊字符
  // 3. 分隔符随机生成，确保不在内容中，避免 heredoc 提前结束
  // 4. 无 base64 编码开销，无行长度限制

  let delimiter = 'MCP_EOF_' + Math.random().toString(36).slice(2, 12);
  while (content.includes(delimiter)) {
    delimiter += Math.random().toString(36).slice(2, 6);
  }

  const script = `cat > '${escapedPath}' <<'${delimiter}'\n${content}\n${delimiter}\n`;

  try {
    const { stderr, code } = await wslBashScript(script);
    if (code !== 0) {
      throw new Error(stderr.trim() || `exit code ${code}`);
    }
  } catch (error: any) {
    throw new Error(`Failed to write to ${filePath}: ${error.message}`);
  }
}

async function wslMkdir(dirPath: string): Promise<void> {
  const wslPath = toWslPath(dirPath);
  const safePath = escapeBashSingleQuoted(wslPath);
  try {
    await execWslCommand(`mkdir -p '${safePath}'`);
  } catch (error: any) {
    throw new Error(`Failed to create directory ${dirPath}: ${error.message}`);
  }
}

async function wslRename(oldPath: string, newPath: string): Promise<void> {
  const wslOldPath = toWslPath(oldPath);
  const wslNewPath = toWslPath(newPath);
  const safeOld = escapeBashSingleQuoted(wslOldPath);
  const safeNew = escapeBashSingleQuoted(wslNewPath);
  try {
    await execWslCommand(`mv '${safeOld}' '${safeNew}'`);
  } catch (error: any) {
    throw new Error(`Failed to move ${oldPath} to ${newPath}: ${error.message}`);
  }
}

async function wslRealpath(filePath: string): Promise<string> {
  const wslPath = toWslPath(filePath);
  const safePath = escapeBashSingleQuoted(wslPath);
  try {
    return await execWslCommand(`realpath '${safePath}'`);
  } catch (error: any) {
    throw new Error(`Failed to resolve realpath for ${filePath}: ${error.message}`);
  }
}

// Validate that all directories exist and are accessible
async function validateDirectories(): Promise<void> {
  for (const dir of pathArgs) {
    try {
      const expandedDir = expandHome(dir);
      const stats = await wslStat(expandedDir);
      if (!stats.isDirectory()) {
        console.error(`Error: ${dir} is not a directory`);
        process.exit(1);
      }
    }
    catch (error) {
      console.error(`Error accessing directory ${dir}:`, error);
      process.exit(1);
    }
  }
}


// Security utilities
async function validatePath(requestedPath: string): Promise<string> {
  const expandedPath = expandHome(requestedPath);
  const absolute = isAbsolute(expandedPath)
    ? resolve(expandedPath)
    : resolve(process.cwd().replace(/\\/g, '/'), expandedPath);

  const normalizedRequested = normalizePath(absolute);

  // Check if path is within allowed directories
  const isAllowed = allowedDirectories.some(dir => normalizedRequested.startsWith(dir));
  if (!isAllowed) {
    throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(', ')}`);
  }

  // Handle symlinks by checking their real path
  try {
    const realPath = await wslRealpath(absolute);
    const normalizedReal = normalizePath(realPath);
    const isRealPathAllowed = allowedDirectories.some(dir => normalizedReal.startsWith(dir));
    if (!isRealPathAllowed) {
      throw new Error("Access denied - symlink target outside allowed directories");
    }
    return realPath;
  }
  catch (error) {
    // For paths that don't exist yet (e.g. mkdir -p a/b/c), walk up to find
    // the nearest existing ancestor and verify it's within allowed directories.
    let current = absolute;
    let parent = dirname(current);
    while (parent !== current) {
      try {
        const realParentPath = await wslRealpath(parent);
        const normalizedParent = normalizePath(realParentPath);
        const isParentAllowed = allowedDirectories.some(dir => normalizedParent.startsWith(dir));
        if (!isParentAllowed) {
          throw new Error("Access denied - ancestor directory outside allowed directories");
        }
        return absolute;
      } catch {
        current = parent;
        parent = dirname(current);
      }
    }
    throw new Error(`No existing ancestor directory found for: ${absolute}`);
  }
}

// Schema definitions
const ReadFileArgsSchema = z.object({
  path: z.string(),
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()),
});

const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const EditOperation = z.object({
  oldText: z.string().describe('Text to search for - must match exactly'),
  newText: z.string().describe('Text to replace with')
});

const EditFileArgsSchema = z.object({
  path: z.string(),
  edits: z.array(EditOperation),
  dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
});

const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([])
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

const ListWslDistrosArgsSchema = z.object({});

const ReadFileByPartsArgsSchema = z.object({
  path: z.string(),
  part_number: z.number().int().positive().describe('Part number to read (1, 2, 3, etc.)')
});

const SearchInFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  caseInsensitive: z.boolean().default(false).describe('Case insensitive search'),
  isRegex: z.boolean().default(false).describe('Treat pattern as regular expression'),
  includePatterns: z.array(z.string()).optional().default([]).describe('File patterns to include (e.g., *.js, *.ts)'),
  excludePatterns: z.array(z.string()).optional().default([]).describe('File patterns to exclude'),
  maxResults: z.number().int().positive().default(1000).describe('Maximum number of results to return'),
  contextLines: z.number().int().min(0).default(0).describe('Number of context lines before and after match')
});

// === 新增工具 Schema ===

// 命令执行（受白名单目录约束的 cwd + 危险命令过滤 + 超时 + 输出截断）
const ExecCommandArgsSchema = z.object({
  command: z.string().describe('Shell command to execute inside WSL (bash -lc). Pipelines and redirections are supported.'),
  cwd: z.string().optional().describe('Working directory inside WSL; must be within allowed directories. If omitted, uses the WSL default home.'),
  timeout: z.number().int().positive().max(300000).optional().describe('Per-call timeout in ms (default uses --exec-timeout, max 300000)')
});

// 删除文件或目录（递归）
const DeleteFileArgsSchema = z.object({
  path: z.string().describe('File or directory to delete. Directories are removed recursively.')
});

// 复制文件或目录
const CopyFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
  overwrite: z.boolean().default(false).describe('Overwrite destination if it exists')
});

// 路径转换 Windows <-> WSL
const ConvertPathArgsSchema = z.object({
  path: z.string().describe('Path to convert (Windows style like C:\\Users\\foo or WSL style like /home/user/foo)'),
  direction: z.enum(['auto', 'toWsl', 'toWindows']).default('auto').describe('auto: detect by drive letter (C:\\) or leading /')
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// Server setup
const server = new Server({
  name: "wsl-rwx-7",
  version: "1.0.0",
}, {
  capabilities: {
    tools: {},
  },
});

// Tool implementations
async function getFileStats(filePath: string): Promise<FileInfo> {
  const stats = await wslStat(filePath);
  return {
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    permissions: stats.mode.toString(8).slice(-3),
  };
}

async function searchFilesByName(
  rootPath: string,
  pattern: string,
  excludePatterns: string[] = []
): Promise<string[]> {
  const wslRootPath = toWslPath(rootPath);
  const safeRoot = escapeBashSingleQuoted(wslRootPath);
  const safePattern = escapeBashSingleQuoted(pattern);
  // find + grep 管道
  const command = [`find '${safeRoot}' -type f`];

  if (pattern) {
    command.push(`(grep -i '${safePattern}' || true)`);
  }

  if (excludePatterns && excludePatterns.length > 0) {
     for (const ex of excludePatterns) {
      const excluded = escapeBashSingleQuoted(ex.replace(/\*/g, ".*"));
      command.push(`(grep -v '${excluded}' || true)`);
    }
  }

  try {
    const result = await execWslPipeline(command);
    return result ? result.split("\n").filter(line => line.trim() !== "") : [];
  }
  catch (error: any) {
    throw error;
  }
}

async function searchInFiles(
  rootPath: string,
  pattern: string,
  options: {
    caseInsensitive?: boolean;
    isRegex?: boolean;
    includePatterns?: string[];
    excludePatterns?: string[];
    maxResults?: number;
    contextLines?: number;
  } = {}
): Promise<string> {
  const wslRootPath = toWslPath(rootPath);
  const safeRoot = escapeBashSingleQuoted(wslRootPath);
  
  // 构建 grep 命令
  const grepOptions: string[] = [];

  // 基础选项
  grepOptions.push('-n'); // 行号
  grepOptions.push('-H'); // 始终显示文件名
  grepOptions.push('-r'); // 递归

  // 条件选项
  if (options.caseInsensitive) {
    grepOptions.push('-i');
  }

  if (options.isRegex) {
    grepOptions.push('-E'); // 扩展正则
  } else {
    grepOptions.push('-F'); // 固定字符串
  }

  // 上下文行数
  if (options.contextLines && options.contextLines > 0) {
    grepOptions.push(`-C${options.contextLines}`);
  }

  // 限制结果数
  if (options.maxResults) {
    grepOptions.push(`-m${Math.ceil(options.maxResults / 10)}`); // 每文件近似上限
  }

  // 包含模式
  if (options.includePatterns && options.includePatterns.length > 0) {
    for (const pattern of options.includePatterns) {
      grepOptions.push(`--include=${pattern}`);
    }
  }

  // 排除模式
  if (options.excludePatterns && options.excludePatterns.length > 0) {
    for (const pattern of options.excludePatterns) {
      grepOptions.push(`--exclude=${pattern}`);
    }
  }

  // 排除常见无需搜索的目录
  grepOptions.push('--exclude-dir=.git');
  grepOptions.push('--exclude-dir=node_modules');
  grepOptions.push('--exclude-dir=.svn');
  grepOptions.push('--exclude-dir=.hg');

  try {
    // pattern 用 base64 编码以避免转义问题，通过 stdin 传给 grep -f -
    const base64Pattern = Buffer.from(pattern).toString('base64');

    const grepCommand = `echo '${base64Pattern}' | base64 -d | grep ${grepOptions.join(' ')} -f - '${safeRoot}' 2>&1 || true`;
    const result = await execWslCommand(grepCommand);
    
    if (!result.trim()) {
      return "No matches found.";
    }
    
    // 过滤 grep 常见错误信息
    const lines = result.trim().split('\n').filter(line => {
      return !line.includes('grep: ') && 
             !line.includes('Is a directory') &&
             !line.includes('Permission denied') &&
             !line.includes('No such file or directory');
    });
    
    if (lines.length === 0) {
      return "No matches found.";
    }
    
    // 必要时限制结果数量
    if (options.maxResults && lines.length > options.maxResults) {
      const truncated = lines.slice(0, options.maxResults);
      truncated.push(`\n... (${lines.length - options.maxResults} more results omitted)`);
      return truncated.join('\n');
    }
    
    return lines.join('\n');
  } catch (error: any) {
    throw new Error(`Failed to search in files: ${error.message}`);
  }
}

async function readFileByParts(filePath: string, partNumber: number): Promise<string> {
  const wslPath = toWslPath(filePath);
  const safePath = escapeBashSingleQuoted(wslPath);
  const PART_SIZE = 95000;
  const MAX_BACKTRACK = 300;
  
  try {
    const fileSizeStr = await execWslCommand(`wc -c < '${safePath}'`);
    const fileSize = parseInt(fileSizeStr.trim());
    
    const theoreticalStart = (partNumber - 1) * PART_SIZE;
    
    if (theoreticalStart >= fileSize) {
      throw new Error(`File has only ${fileSize.toLocaleString()} characters. Part ${partNumber} does not exist.`);
    }
    
    let actualStart = theoreticalStart;
    
    if (partNumber === 1) {
      const content = await execWslCommand(`head -c ${PART_SIZE} '${safePath}'`);
      return content;
    }
    
    if (partNumber > 1) {
      const searchStart = Math.max(0, theoreticalStart - MAX_BACKTRACK);
      const searchLength = theoreticalStart - searchStart;
      
      if (searchLength > 0) {
        const searchContent = await execWslCommand(
          `tail -c +${searchStart + 1} '${safePath}' | head -c ${searchLength}`
        );
        
        const lastNewlineIndex = searchContent.lastIndexOf('\n');
        
        if (lastNewlineIndex !== -1) {
          actualStart = searchStart + lastNewlineIndex + 1;
        }
      }
    }
    
    let content = await execWslCommand(
      `tail -c +${actualStart + 1} '${safePath}' | head -c ${PART_SIZE}`
    );
    
    // 非首部分时，尝试在完整行边界结束
    if (partNumber > 1 && content.length === PART_SIZE) {
      const endSearchStart = actualStart + PART_SIZE;
      
      if (endSearchStart < fileSize) {
        const remainingChars = Math.min(MAX_BACKTRACK, fileSize - endSearchStart);
        
        if (remainingChars > 0) {
          const endSearchContent = await execWslCommand(
            `tail -c +${endSearchStart + 1} '${safePath}' | head -c ${remainingChars}`
          );
          
          const firstNewlineIndex = endSearchContent.indexOf('\n');
          
          if (firstNewlineIndex !== -1) {
            content += endSearchContent.substring(0, firstNewlineIndex + 1);
          }
        }
      }
    }
    
    return content;
  } catch (error: any) {
    if (error.message.includes('File has only')) {
      throw error;
    }
    throw new Error(`Failed to read file part ${partNumber} of ${filePath}: ${error.message}`);
  }
}

// file editing and diffing utilities
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function createUnifiedDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
  // Ensure consistent line endings for diff
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);

  return createTwoFilesPatch(filepath, filepath, normalizedOriginal, normalizedNew, 'original', 'modified');
}

async function applyFileEdits(
  filePath: string,
  edits: EditOperationType[],
  dryRun: boolean = false
): Promise<string> {
  // Read file content and normalize line endings
  const content = normalizeLineEndings(await wslReadFile(filePath, 'utf-8'));

  // Apply edits sequentially
  let modifiedContent = content;
  for (const edit of edits) {
    const normalizedOld = normalizeLineEndings(edit.oldText);
    const normalizedNew = normalizeLineEndings(edit.newText);

    // If exact match exists, use it
    if (modifiedContent.includes(normalizedOld)) {
      modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
      continue;
    }

    // Otherwise, try line-by-line matching with flexibility for whitespace
    const oldLines = normalizedOld.split('\n');
    const contentLines = modifiedContent.split('\n');
    let matchFound = false;

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const potentialMatch = contentLines.slice(i, i + oldLines.length);

      // Compare lines with normalized whitespace
      const isMatch = oldLines.every((oldLine: string, j: number) => {
        const contentLine = potentialMatch[j];
        return oldLine.trim() === contentLine.trim();
      });

      if (isMatch) {
        // Preserve original indentation of first line
        const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
        const newLines = normalizedNew.split('\n').map((line: string, j: number) => {
          if (j === 0)
            return originalIndent + line.trimStart();
          // For subsequent lines, try to preserve relative indentation
          const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
          const newIndent = line.match(/^\s*/)?.[0] || '';
          if (oldIndent && newIndent) {
            const relativeIndent = newIndent.length - oldIndent.length;
            return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
          }
          return line;
        });

        contentLines.splice(i, oldLines.length, ...newLines);
        modifiedContent = contentLines.join('\n');
        matchFound = true;
        break;
      }
    }

    if (!matchFound) {
      throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
    }
  }

  // Create unified diff
  const diff = createUnifiedDiff(content, modifiedContent, filePath);

  // 用合适数量的反引号包裹 diff 输出
  let numBackticks = 3;
  while (diff.includes('`'.repeat(numBackticks))) {
    numBackticks++;
  }
  const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;

  if (!dryRun) {
    await wslWriteFile(filePath, modifiedContent);
  }

  return formattedDiff;
}

// === 新增工具实现函数 ===

/**
 * 安全执行 WSL 命令：危险命令过滤 + 超时 + 输出截断 + cwd 白名单校验
 *
 * 命令通过 bash -s 的 stdin 传入，完全不经过 Windows 命令行参数解析。
 * cwd 用 bash 单引号转义后嵌入脚本，确保路径含空格/特殊字符时安全。
 */
async function execWslCommandSafe(
  command: string,
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> {
  const { cwd, timeoutMs = execTimeoutMs } = options;

  // 1. 危险命令过滤（仅作 best-effort 提示，非真正安全边界）
  const normalizedCmd = command.toLowerCase();
  for (const forbidden of forbiddenCommands) {
    if (normalizedCmd.includes(forbidden)) {
      throw new Error(`Blocked: command matches forbidden pattern "${forbidden}".`);
    }
  }

  // 2. 构造 bash 脚本（通过 stdin 传给 bash -s）
  let script = '';
  if (cwd) {
    const safeCwd = escapeBashSingleQuoted(toWslPath(cwd));
    script += `cd '${safeCwd}' || exit 1\n`;
  }
  script += command + '\n';

  // 3. 执行并处理输出截断
  const { stdout, stderr, code } = await wslBashScript(script, { timeoutMs });

  let truncated = false;
  let trimmedStdout = stdout;
  if (Buffer.byteLength(trimmedStdout, 'utf8') > maxOutputBytes) {
    trimmedStdout = Buffer.from(trimmedStdout, 'utf8').subarray(0, maxOutputBytes).toString('utf8');
    truncated = true;
  }
  let trimmedStderr = stderr;
  const stderrLimit = Math.floor(maxOutputBytes / 2);
  if (Buffer.byteLength(trimmedStderr, 'utf8') > stderrLimit) {
    trimmedStderr = Buffer.from(trimmedStderr, 'utf8').subarray(0, stderrLimit).toString('utf8');
    truncated = true;
  }

  return { stdout: trimmedStdout, stderr: trimmedStderr, exitCode: code, truncated };
}

/**
 * 删除文件或目录（递归）
 * 注意：调用方必须先通过 validatePath 校验白名单
 */
async function wslDelete(targetPath: string): Promise<void> {
  const wslPath = toWslPath(targetPath);
  const safePath = escapeBashSingleQuoted(wslPath);
  try {
    await execWslCommand(`rm -rf '${safePath}'`);
  } catch (error: any) {
    throw new Error(`Failed to delete ${targetPath}: ${error.message}`);
  }
}

/**
 * 复制文件或目录
 * 不覆盖模式下先 test -e 检查目标是否存在，再 cp。
 * （cp -n 在目标存在时退出码仍为 0，无法据此判断，故用 test -e。）
 */
async function wslCopy(sourcePath: string, destPath: string, overwrite: boolean = false): Promise<void> {
  const wslSrc = toWslPath(sourcePath);
  const wslDest = toWslPath(destPath);
  const safeSrc = escapeBashSingleQuoted(wslSrc);
  const safeDest = escapeBashSingleQuoted(wslDest);
  try {
    if (!overwrite) {
      // 目标存在则报错
      const { code } = await wslBashScript(`test -e '${safeDest}'\n`);
      if (code === 0) {
        throw new Error(`Destination exists: ${destPath} (use overwrite=true to replace)`);
      }
    }
    await execWslCommand(`cp -rf '${safeSrc}' '${safeDest}'`);
  } catch (error: any) {
    if (error.message.startsWith('Destination exists')) throw error;
    throw new Error(`Failed to copy ${sourcePath} to ${destPath}: ${error.message}`);
  }
}

/**
 * 路径转换：Windows <-> WSL（使用 wslpath 工具）
 */
async function wslConvertPath(
  inputPath: string,
  direction: 'auto' | 'toWsl' | 'toWindows' = 'auto'
): Promise<{ wslPath: string; windowsPath: string }> {
  let dir: 'toWsl' | 'toWindows';
  if (direction === 'auto') {
    // 以盘符开头 (C:\) 视为 Windows；以 / 开头视为 WSL
    const isWindows = /^[a-zA-Z]:[\\/]/.test(inputPath);
    dir = isWindows ? 'toWsl' : 'toWindows';
  } else {
    dir = direction;
  }

  // wslpath 通过 bash -s 调用，路径用单引号转义
  const safeInput = escapeBashSingleQuoted(inputPath);

  if (dir === 'toWsl') {
    const { stdout, code, stderr } = await wslBashScript(`wslpath -u '${safeInput}'\n`);
    if (code !== 0) throw new Error(`wslpath failed: ${stderr.trim()}`);
    return { wslPath: stdout.trim(), windowsPath: inputPath };
  } else {
    const { stdout, code, stderr } = await wslBashScript(`wslpath -w '${safeInput}'\n`);
    if (code !== 0) throw new Error(`wslpath failed: ${stderr.trim()}`);
    return { wslPath: inputPath, windowsPath: stdout.trim() };
  }
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log('INFO', 'list_tools requested');
  return {
    tools: [
      {
        name: "read_file",
        description: "WSL: Read the complete contents of a file from the file system. " +
          "Handles various text encodings and provides detailed error messages " +
          "if the file cannot be read. Use this tool when you need to examine " +
          "the contents of a single file. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ReadFileArgsSchema) as ToolInput,
      },
      {
        name: "read_file_by_parts",
        description: "WSL: Read a file in parts of approximately 95,000 characters. " +
          "Use this for large files that cannot be read in one go. " +
          "Part 1 reads the first 95,000 characters. " +
          "Subsequent parts start at boundaries that respect line breaks when possible. " +
          "If a requested part number exceeds the file size, an error is returned with the actual file size.",
        inputSchema: zodToJsonSchema(ReadFileByPartsArgsSchema) as ToolInput,
      },
      {
        name: "read_multiple_files",
        description: "WSL: Read the contents of multiple files in batch. This is more " +
          "efficient than reading files one by one when you need to analyze " +
          "or compare multiple files. Each file's content is returned with its " +
          "path as a reference. Failed reads for individual files won't stop " +
          "the entire operation. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema) as ToolInput,
      },
      {
        name: "write_file",
        description: "WSL: Create a new file or completely overwrite an existing file with new content. " +
          "Use with caution as it will overwrite existing files without warning. " +
          "Handles text content with proper encoding. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(WriteFileArgsSchema) as ToolInput,
      },
      {
        name: "edit_file",
        description: "WSL: Make line-based edits to a text file. Each edit replaces exact line sequences " +
          "with new content. Returns a git-style diff showing the changes made. " +
          "Only works within allowed directories.",
        inputSchema: zodToJsonSchema(EditFileArgsSchema) as ToolInput,
      },
      {
        name: "create_directory",
        description: "WSL: Create a new directory (mkdir -p) or ensure a directory exists. Can create multiple " +
          "nested directories in one operation. If the directory already exists, " +
          "this operation will succeed silently. Perfect for setting up directory " +
          "structures for projects or ensuring required paths exist. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "list_directory",
        description: "WSL: Get a detailed listing (ls-like) of all files and directories in a specified path. " +
          "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
          "prefixes. This tool is essential for understanding directory structure and " +
          "finding specific files within a directory. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ListDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "directory_tree",
        description: "WSL: Get a recursive tree view of files and directories as a JSON structure. " +
          "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
          "Files have no children array, while directories always have a children array (which may be empty). " +
          "The output is formatted with 2-space indentation for readability. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(DirectoryTreeArgsSchema) as ToolInput,
      },
      {
        name: "move_file",
        description: "WSL: Move (mv) or rename files and directories. Can move files between directories " +
          "and rename them in a single operation. If the destination exists, the " +
          "operation will fail. Works across different directories and can be used " +
          "for simple renaming within the same directory. Both source and destination must be within allowed directories.",
        inputSchema: zodToJsonSchema(MoveFileArgsSchema) as ToolInput,
      },
      {
        name: "search_files_by_name",
        description: "WSL: Recursively search for files and directories matching a pattern. " +
          "Searches through all subdirectories from the starting path. The search " +
          "is case-insensitive and matches partial names. Returns full paths to all " +
          "matching items. Great for finding files when you don't know their exact location. " +
          "Only searches within allowed directories.",
        inputSchema: zodToJsonSchema(SearchFilesArgsSchema) as ToolInput,
      },
      {
        name: "search_in_files",
        description: "WSL: Search (grep-like) for text patterns within files recursively. " +
          "Supports plain text and regular expression searches. Can filter by file patterns, " +
          "exclude certain files/directories, limit results, and show context lines. " +
          "Returns matching lines with file paths and line numbers. " +
          "Automatically excludes common directories like .git and node_modules. " +
          "Only searches within allowed directories.",
        inputSchema: zodToJsonSchema(SearchInFilesArgsSchema) as ToolInput,
      },
      {
        name: "get_file_info",
        description: "WSL: Retrieve detailed metadata (stat-like) about a file or directory. Returns comprehensive " +
          "information including size, creation time, last modified time, permissions, " +
          "and type. This tool is perfect for understanding file characteristics " +
          "without reading the actual content. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(GetFileInfoArgsSchema) as ToolInput,
      },
      {
        name: "list_allowed_directories",
        description: "WSL: Returns the list of whitelisted directories that this server is allowed to access. " +
          "Use this to understand which directories are available before trying to access files.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        } as ToolInput,
      },
      {
        name: "list_wsl_distributions",
        description: "Lists all available WSL distributions and shows which one is currently being used.",
        inputSchema: zodToJsonSchema(ListWslDistrosArgsSchema) as ToolInput,
      },
      {
        name: "exec_command",
        description: "Execute a shell command inside WSL via `bash -s` (script passed through stdin). " +
          "Supports pipelines, redirections, and all bash syntax. " +
          "SECURITY NOTE: the command string is NOT sandboxed — it can access any part of the WSL filesystem, " +
          "not just the allowed directories. The allowed-directories whitelist constrains `cwd` only. " +
          "A best-effort blocklist rejects obviously destructive patterns (rm -rf /, mkfs, dd to block devices, " +
          "shutdown/reboot, systemctl, sudo, fork bombs) but this is NOT a security boundary — do not rely on it. " +
          "Output is truncated to --max-output (default 1MB). Per-call timeout via `timeout` (default 30s, max 300s). " +
          "Returns stdout, stderr, exit code and a truncated flag. Non-zero exit codes are NOT treated as errors so callers can inspect output.",
        inputSchema: zodToJsonSchema(ExecCommandArgsSchema) as ToolInput,
      },
      {
        name: "delete_file",
        description: "WSL: Delete a file or directory (recursive). Both path and parent are validated against allowed directories. " +
          "Use with caution: directories are removed recursively with rm -rf.",
        inputSchema: zodToJsonSchema(DeleteFileArgsSchema) as ToolInput,
      },
      {
        name: "copy_file",
        description: "WSL: Copy (cp) a file or directory to a new location. By default refuses to overwrite existing destination; " +
          "set overwrite=true to replace. Source and destination must both be within allowed directories.",
        inputSchema: zodToJsonSchema(CopyFileArgsSchema) as ToolInput,
      },
      {
        name: "convert_path",
        description: "Convert paths between Windows and WSL formats using the wslpath tool. " +
          "auto: detect direction by drive letter (C:\\) or leading slash. " +
          "Returns both wslPath and windowsPath for convenience.",
        inputSchema: zodToJsonSchema(ConvertPathArgsSchema) as ToolInput,
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const callStart = Date.now();
  // 记录参数摘要（避免完整路径/内容泄露，只记前 200 字符）
  const argsSummary = args ? JSON.stringify(args).slice(0, 200) : '(none)';
  log('INFO', `tool call start: ${name}`, { args: argsSummary });
  try {
    switch (name) {
      case "read_file": {
        const parsed = ReadFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const content = await wslReadFile(validPath);
        return {
          content: [{ type: "text", text: content }],
        };
      }
      case "read_file_by_parts": {
        const parsed = ReadFileByPartsArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_file_by_parts: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const content = await readFileByParts(validPath, parsed.data.part_number);
        
        return {
          content: [{ 
            type: "text", 
            text: content
          }],
        };
      }
      case "read_multiple_files": {
        const parsed = ReadMultipleFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_multiple_files: ${parsed.error}`);
        }
        const results = await Promise.all(parsed.data.paths.map(async (filePath: string) => {
          try {
            const validPath = await validatePath(filePath);
            const content = await wslReadFile(validPath);
            return `${filePath}:\n${content}\n`;
          }
          catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return `${filePath}: Error - ${errorMessage}`;
          }
        }));
        return {
          content: [{ type: "text", text: results.join("\n---\n") }],
        };
      }
      case "write_file": {
        const parsed = WriteFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for write_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await wslWriteFile(validPath, parsed.data.content);
        return {
          content: [{ type: "text", text: `Successfully wrote to ${parsed.data.path}` }],
        };
      }
      case "edit_file": {
        const parsed = EditFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for edit_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const result = await applyFileEdits(validPath, parsed.data.edits, parsed.data.dryRun);
        return {
          content: [{ type: "text", text: result }],
        };
      }
      case "create_directory": {
        const parsed = CreateDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for create_directory: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await wslMkdir(validPath);
        return {
          content: [{ type: "text", text: `Successfully created directory ${parsed.data.path}` }],
        };
      }
      case "list_directory": {
        const parsed = ListDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for list_directory: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const entries = await wslReaddir(validPath);
        const formatted = entries
          .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
          .join("\n");
        return {
          content: [{ type: "text", text: formatted }],
        };
      }
      case "directory_tree": {
        const parsed = DirectoryTreeArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for directory_tree: ${parsed.error}`);
        }
        
        const validPath = await validatePath(parsed.data.path);
        const wslPath = toWslPath(validPath);
        const safePath = escapeBashSingleQuoted(wslPath);
        
        // find 获取所有文件和目录
        // %y = type (d=directory, f=file), %P = 相对路径
        try {
          const findResult = await execWslCommand(
            `find '${safePath}' -printf '%y %P\\n' | sort`
          );

          if (!findResult.trim()) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify([], null, 2)
              }],
            };
          }
          
          // 解析 find 输出并重建目录树
          const lines = findResult.trim().split('\n');
          const tree: TreeEntry[] = [];
          const pathMap = new Map<string, TreeEntry>();

          // 第一行是根目录自身（空路径），跳过
          const startIndex = lines[0].trim() === 'd ' ? 1 : 0;

          for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i].trim();
            const [type, ...pathParts] = line.split(' ');
            const relativePath = pathParts.join(' ');

            if (!relativePath) continue;

            const parts = relativePath.split('/');
            const name = parts[parts.length - 1];
            const parentPath = parts.slice(0, -1).join('/');

            const entry: TreeEntry = {
              name,
              type: type === 'd' ? 'directory' : 'file'
            };

            if (type === 'd') {
              entry.children = [];
            }

            pathMap.set(relativePath, entry);

            if (parentPath) {
              // 挂到父节点下
              const parent = pathMap.get(parentPath);
              if (parent && parent.children) {
                parent.children.push(entry);
              }
            } else {
              // 顶级条目
              tree.push(entry);
            }
          }
          
          return {
            content: [{
              type: "text",
              text: JSON.stringify(tree, null, 2)
            }],
          };
        } catch (error: any) {
          throw new Error(`Failed to get directory tree for ${parsed.data.path}: ${error.message}`);
        }
      }
      case "move_file": {
        const parsed = MoveFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for move_file: ${parsed.error}`);
        }
        const validSourcePath = await validatePath(parsed.data.source);
        const validDestPath = await validatePath(parsed.data.destination);
        await wslRename(validSourcePath, validDestPath);
        return {
          content: [{ type: "text", text: `Successfully moved ${parsed.data.source} to ${parsed.data.destination}` }],
        };
      }
      case "search_files_by_name": {
        const parsed = SearchFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for search_files_by_name: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const results = await searchFilesByName(validPath, parsed.data.pattern, parsed.data.excludePatterns || []);
        return {
          content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "No matches found" }],
        };
      }
      case "search_in_files": {
        const parsed = SearchInFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for search_in_files: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const result = await searchInFiles(validPath, parsed.data.pattern, {
          caseInsensitive: parsed.data.caseInsensitive,
          isRegex: parsed.data.isRegex,
          includePatterns: parsed.data.includePatterns,
          excludePatterns: parsed.data.excludePatterns,
          maxResults: parsed.data.maxResults,
          contextLines: parsed.data.contextLines
        });
        return {
          content: [{ type: "text", text: result }],
        };
      }
      case "get_file_info": {
        const parsed = GetFileInfoArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for get_file_info: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const info = await getFileStats(validPath);
        return {
          content: [{
            type: "text", text: Object.entries(info)
              .map(([key, value]) => `${key}: ${value}`)
              .join("\n")
          }],
        };
      }
      case "list_allowed_directories": {
        return {
          content: [{
            type: "text",
            text: `Allowed directories:\n${allowedDirectories.join('\n')}`
          }],
        };
      }
      case "list_wsl_distributions": {
        const distributions = await listWslDistributions();
        const formattedList = distributions.map(d => {
          const isActive = allowedDistro && d.name.toLowerCase() === allowedDistro.toLowerCase()
            ? " (ACTIVE)"
            : d.name.includes("(Default)") ? " (DEFAULT)" : "";
          return `${d.name}${isActive} - State: ${d.state}, Version: ${d.version}`;
        }).join('\n');

        return {
          content: [{
            type: "text",
            text: `Available WSL Distributions:\n${formattedList}\n\nCurrently using: ${allowedDistro}`
          }],
        };
      }
      case "exec_command": {
        const parsed = ExecCommandArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for exec_command: ${parsed.error}`);
        }
        // cwd 必须在白名单内（如果提供）
        let validatedCwd: string | undefined;
        if (parsed.data.cwd) {
          try {
            validatedCwd = await validatePath(parsed.data.cwd);
          } catch (e: any) {
            throw new Error(`cwd is outside allowed directories: ${parsed.data.cwd} (${e.message})`);
          }
        }
        const result = await execWslCommandSafe(parsed.data.command, {
          cwd: validatedCwd,
          timeoutMs: parsed.data.timeout
        });
        const truncationNote = result.truncated ? `\n[output truncated to ${maxOutputBytes} bytes]` : '';
        const text = `exit_code: ${result.exitCode}\n` +
          `--- stdout ---\n${result.stdout || '(empty)'}\n` +
          `--- stderr ---\n${result.stderr || '(empty)'}${truncationNote}`;
        return {
          content: [{ type: "text", text }],
        };
      }
      case "delete_file": {
        const parsed = DeleteFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for delete_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await wslDelete(validPath);
        return {
          content: [{ type: "text", text: `Successfully deleted ${parsed.data.path}` }],
        };
      }
      case "copy_file": {
        const parsed = CopyFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for copy_file: ${parsed.error}`);
        }
        const validSource = await validatePath(parsed.data.source);
        // 目标若存在需在白名单内；若不存在则校验父目录
        const validDest = await validatePath(parsed.data.destination);
        await wslCopy(validSource, validDest, parsed.data.overwrite);
        return {
          content: [{ type: "text", text: `Successfully copied ${parsed.data.source} to ${parsed.data.destination}` }],
        };
      }
      case "convert_path": {
        const parsed = ConvertPathArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for convert_path: ${parsed.error}`);
        }
        const result = await wslConvertPath(parsed.data.path, parsed.data.direction);
        return {
          content: [{
            type: "text",
            text: `wslPath: ${result.wslPath}\nwindowsPath: ${result.windowsPath}`
          }],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    const elapsed = Date.now() - callStart;
    log('INFO', `tool call end: ${name}`, { elapsed_ms: elapsed, ok: true });
    // 返回值在上面的各个 case 中已 return，这里不会执行到
    return undefined as any;
  }
  catch (error) {
    const elapsed = Date.now() - callStart;
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('ERROR', `tool call end: ${name}`, { elapsed_ms: elapsed, ok: false, error: errorMessage });
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start server
async function runServer() {
  log('INFO', 'runServer: initializing WSL and directories');
  await initializeWslAndDirectories();
  log('INFO', 'runServer: WSL initialized', { distro: allowedDistro, allowedDirectories });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('INFO', 'runServer: server connected on stdio', { distro: allowedDistro, allowedDirectories });
  console.error("wsl-rwx-7 MCP server running on stdio");
  console.error(`Using WSL distribution: ${allowedDistro}`);
  console.error("Allowed directories:", allowedDirectories);
}

runServer().catch((error) => {
  log('ERROR', 'runServer: fatal error', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  console.error("Fatal error running server:", error);
  process.exit(1);
});