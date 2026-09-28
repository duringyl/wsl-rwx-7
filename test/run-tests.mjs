#!/usr/bin/env node
/**
 * wsl-rwx-7 MCP server 回归测试
 * 用法: node test/run-tests.mjs [distro] [allowed-dir]
 * 默认: Ubuntu-24.04 /home/user/test-project
 */
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'dist', 'index.js');
const DISTRO = process.argv[2] || 'Ubuntu-24.04';
const ALLOWED = process.argv[3] || '/home/user/test-project';

const child = spawn('node', [SERVER, `--distro=${DISTRO}`, ALLOWED], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let buf = '';
let pending = new Map();
let nextId = 1;
let passed = 0;
let failed = 0;

child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {}
  }
});

child.stderr.on('data', (c) => process.stderr.write('[server] ' + c.toString()));

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 30000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

async function callTool(name, args) {
  const r = await send('tools/call', { name, arguments: args });
  return r.result;
}

async function main() {
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  notify('notifications/initialized');

  // === 1. tools/list 包含全部工具 ===
  console.log('\n[1] tools/list');
  const list = await send('tools/list');
  const toolNames = list.result.tools.map(t => t.name);
  assert(toolNames.includes('exec_command'), 'exec_command registered');
  assert(toolNames.includes('delete_file'), 'delete_file registered');
  assert(toolNames.includes('copy_file'), 'copy_file registered');
  assert(toolNames.includes('convert_path'), 'convert_path registered');
  assert(toolNames.includes('write_file'), 'write_file registered');

  // === 2. write_file + read_file 特殊字符 ===
  console.log('\n[2] write_file / read_file 特殊字符');
  const special = 'dollar=$HOME\nbacktick=`whoami`\nquote="hi"\nsingle=\'bye\'\nbackslash=\\path\n中文\n';
  const f = `${ALLOWED}/.test-special.txt`;
  const w = await callTool('write_file', { path: f, content: special });
  assert(!w.isError, `write_file 成功: ${w.content[0].text}`);
  const r = await callTool('read_file', { path: f });
  assert(!r.isError, 'read_file 成功');
  assert(r.content[0].text === special.slice(0, -1), '内容原样保留（trim 掉末尾换行）');

  // === 3. 路径含空格 ===
  console.log('\n[3] 路径含空格');
  const spaceDir = `${ALLOWED}/dir with spaces`;
  const spaceFile = `${spaceDir}/file name.txt`;
  await callTool('create_directory', { path: spaceDir });
  const w2 = await callTool('write_file', { path: spaceFile, content: 'space test' });
  assert(!w2.isError, `write 含空格路径成功: ${w2.content[0].text}`);
  const r2 = await callTool('read_file', { path: spaceFile });
  assert(r2.content[0].text === 'space test', 'read 含空格路径内容正确');

  // === 4. copy_file (no-clobber + overwrite) ===
  console.log('\n[4] copy_file');
  const cp1 = await callTool('copy_file', { source: spaceFile, destination: `${spaceDir}/copy.txt` });
  assert(!cp1.isError, '首次复制成功');
  const cp2 = await callTool('copy_file', { source: spaceFile, destination: `${spaceDir}/copy.txt` });
  assert(cp2.isError, '目标存在时拒绝覆盖');
  const cp3 = await callTool('copy_file', { source: spaceFile, destination: `${spaceDir}/copy.txt`, overwrite: true });
  assert(!cp3.isError, 'overwrite=true 覆盖成功');

  // === 5. delete_file ===
  console.log('\n[5] delete_file');
  const d1 = await callTool('delete_file', { path: `${spaceDir}/copy.txt` });
  assert(!d1.isError, '删除文件成功');

  // === 6. exec_command ===
  console.log('\n[6] exec_command');
  const e1 = await callTool('exec_command', { command: 'echo hello | tr a-z A-Z' });
  assert(!e1.isError && e1.content[0].text.includes('HELLO'), '管道执行正确');
  const e2 = await callTool('exec_command', { command: 'exit 42' });
  assert(!e2.isError && e2.content[0].text.includes('exit_code: 42'), '非零退出码返回 exit_code');
  const e3 = await callTool('exec_command', { command: 'echo $HOME', cwd: ALLOWED });
  assert(!e3.isError, 'cwd 白名单内命令执行成功');
  const e4 = await callTool('exec_command', { command: 'sudo rm -rf /' });
  assert(e4.isError, '危险命令被拦截');

  // === 7. convert_path ===
  console.log('\n[7] convert_path');
  const c1 = await callTool('convert_path', { path: 'C:\\Users\\test' });
  assert(c1.content[0].text.includes('/mnt/c/Users/test'), 'Windows→WSL 转换正确');
  const c2 = await callTool('convert_path', { path: '/home/user' });
  assert(c2.content[0].text.includes('\\\\home\\\\user') || c2.content[0].text.toLowerCase().includes('home'), 'WSL→Windows 转换有结果');

  // === 8. 大内容 heredoc 分隔符不冲突 ===
  console.log('\n[8] 大内容 + heredoc 分隔符');
  const big = 'MCP_EOF_xyz\n'.repeat(500) + 'end';
  const bf = `${ALLOWED}/.test-big.txt`;
  await callTool('write_file', { path: bf, content: big });
  const br = await callTool('read_file', { path: bf });
  assert(br.content[0].text === big, '大内容写入/读取一致');

  // === 9. tool_search 关键词可发现性 ===
  console.log('\n[9] tool_search 关键词可发现性');
  {
    const allTools = list.result.tools;
    const descOf = (name) => (allTools.find(t => t.name === name)?.description || '').toLowerCase();
    const searchTools = (kw) => allTools.filter(t => (t.description || '').toLowerCase().includes(kw.toLowerCase())).map(t => t.name);
    const assertFound = (kw, expected) => {
      const found = searchTools(kw);
      assert(found.includes(expected), `search "${kw}" → ${expected} (命中 ${found.length} 个)`);
    };

    // 9.1 通用关键词 "wsl" 应命中全部工具
    const wslHits = searchTools('wsl');
    assert(wslHits.length === allTools.length, `search "wsl" 命中全部 ${allTools.length} 个工具（实际 ${wslHits.length}）`);

    // 9.2 动作关键词
    assertFound('read', 'read_file');
    assertFound('read', 'read_file_by_parts');
    assertFound('read', 'read_multiple_files');
    assertFound('write', 'write_file');
    assertFound('edit', 'edit_file');
    assertFound('create', 'write_file');
    assertFound('create', 'create_directory');
    assertFound('delete', 'delete_file');
    assertFound('remove', 'delete_file');
    assertFound('copy', 'copy_file');
    assertFound('move', 'move_file');
    assertFound('rename', 'move_file');
    assertFound('search', 'search_files_by_name');
    assertFound('search', 'search_in_files');
    assertFound('list', 'list_directory');
    assertFound('list', 'list_allowed_directories');
    assertFound('list', 'list_wsl_distributions');
    assertFound('execute', 'exec_command');
    assertFound('convert', 'convert_path');

    // 9.3 资源关键词
    assertFound('file', 'read_file');
    assertFound('file', 'write_file');
    assertFound('file', 'edit_file');
    assertFound('file', 'delete_file');
    assertFound('file', 'copy_file');
    assertFound('file', 'move_file');
    assertFound('directory', 'create_directory');
    assertFound('directory', 'list_directory');
    assertFound('directory', 'directory_tree');
    assertFound('path', 'convert_path');
    assertFound('metadata', 'get_file_info');
    assertFound('info', 'get_file_info');

    // 9.4 语义/别名关键词（Agent 可能用的同义词）
    assertFound('shell', 'exec_command');
    assertFound('command', 'exec_command');
    assertFound('bash', 'exec_command');
    assertFound('grep', 'search_in_files');
    assertFound('find', 'search_files_by_name');
    assertFound('tree', 'directory_tree');
    assertFound('distribution', 'list_wsl_distributions');
    assertFound('whitelist', 'list_allowed_directories');
    assertFound('diff', 'edit_file');
    assertFound('large', 'read_file_by_parts');
    assertFound('batch', 'read_multiple_files');
    assertFound('stat', 'get_file_info');
    assertFound('ls', 'list_directory');
    assertFound('mkdir', 'create_directory');
    assertFound('cp', 'copy_file');
    assertFound('rm', 'delete_file');
    assertFound('mv', 'move_file');

    // 9.5 每个工具至少被 3 个不同关键词命中（可发现性下限）
    const keywordSet = ['wsl', 'read', 'write', 'edit', 'create', 'delete', 'remove', 'copy',
      'move', 'rename', 'search', 'list', 'execute', 'convert', 'file', 'directory', 'path',
      'metadata', 'info', 'shell', 'command', 'bash', 'grep', 'find', 'tree', 'distribution',
      'whitelist', 'diff', 'large', 'batch', 'stat', 'ls', 'mkdir', 'cp', 'rm', 'mv',
      'multiple', 'parts', 'recursive', 'structure', 'rename', 'overwrite'];
    for (const t of allTools) {
      const hits = keywordSet.filter(kw => (t.description || '').toLowerCase().includes(kw));
      assert(hits.length >= 3, `"${t.name}" 至少被 3 个关键词命中（实际 ${hits.length}: ${hits.join(',')}）`);
    }
  }

  // 清理
  await callTool('delete_file', { path: f });
  await callTool('delete_file', { path: spaceFile });
  await callTool('delete_file', { path: spaceDir });
  await callTool('delete_file', { path: bf });

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  child.kill();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); child.kill(); process.exit(1); });
