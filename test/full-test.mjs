#!/usr/bin/env node
/**
 * wsl-rwx-7 MCP Server 全面测试套件
 * 覆盖维度: 功能 / 边界 / 安全 / 转义 / 错误处理 / 性能
 * 用法: node test/full-test.mjs [distro] [allowed-dir]
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
let passed = 0, failed = 0;
const failures = [];

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
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 60000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function check(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.error(`  FAIL: ${msg}`); }
}

async function callTool(name, args) {
  const r = await send('tools/call', { name, arguments: args });
  return r.result;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'full-test', version: '1' } });
  notify('notifications/initialized');

  const TMP = `${ALLOWED}/.wsl-rwx7-test`;
  const TMP2 = `${TMP}/sub dir`; // 含空格的子目录
  const OUT = `${TMP}/output`;

  // 清理上次残留
  await callTool('delete_file', { path: TMP }).catch(() => {});

  // ==================== 1. 基础设施 & 信息类工具 ====================
  console.log('\n[1] 基础设施 & 信息类工具');

  const list = await send('tools/list');
  check(list.result.tools.length === 18, `tools/list 返回 18 个工具（实际 ${list.result.tools.length}）`);

  const distros = await callTool('list_wsl_distributions', {});
  check(!distros.isError && distros.content[0].text.length > 0, 'list_wsl_distributions 有输出');

  const allowed = await callTool('list_allowed_directories', {});
  check(allowed.content[0].text.includes(ALLOWED), `list_allowed_directories 包含 ${ALLOWED}`);

  // ==================== 2. 目录操作 ====================
  console.log('\n[2] 目录操作');

  const cd1 = await callTool('create_directory', { path: TMP });
  check(!cd1.isError, 'create_directory 单层目录');

  const cd2 = await callTool('create_directory', { path: TMP2 });
  check(!cd2.isError, 'create_directory 含空格的目录');

  const cd3 = await callTool('create_directory', { path: `${TMP}/a/b/c` });
  check(!cd3.isError, 'create_directory 嵌套目录（mkdir -p）');

  const ld = await callTool('list_directory', { path: TMP });
  check(!ld.isError && ld.content[0].text.includes('sub dir'), 'list_directory 列出含空格的子目录');

  const dt = await callTool('directory_tree', { path: TMP });
  check(!dt.isError && dt.content[0].text.length > 0, 'directory_tree 有输出');

  // ==================== 3. 文件读写（功能+边界+转义） ====================
  console.log('\n[3] 文件读写');

  // 3.1 基础读写
  const f1 = `${TMP}/basic.txt`;
  await callTool('write_file', { path: f1, content: 'hello world' });
  const r1 = await callTool('read_file', { path: f1 });
  check(r1.content[0].text === 'hello world', '基础 write/read 一致');

  // 3.2 空内容
  const f2 = `${TMP}/empty.txt`;
  await callTool('write_file', { path: f2, content: '' });
  const r2 = await callTool('read_file', { path: f2 });
  check(r2.content[0].text === '', '空内容写入读取');

  // 3.3 特殊字符（$ ` " ' \ 中文 emoji）
  const special = 'dollar=$HOME\nbacktick=`whoami`\nquote="hi"\nsingle=\'bye\'\nbackslash=\\x\n中文=你好\nemoji=🚀\n';
  const f3 = `${TMP}/special.txt`;
  await callTool('write_file', { path: f3, content: special });
  const r3 = await callTool('read_file', { path: f3 });
  check(r3.content[0].text === special.slice(0, -1), '特殊字符原样保留（$ ` " \' \\ 中文 emoji）');

  // 3.4 路径含空格
  const f4 = `${TMP2}/file name.txt`;
  await callTool('write_file', { path: f4, content: 'space path' });
  const r4 = await callTool('read_file', { path: f4 });
  check(r4.content[0].text === 'space path', '路径含空格的读写');

  // 3.5 大文件
  const big = 'x'.repeat(500000);
  const f5 = `${TMP}/big.txt`;
  await callTool('write_file', { path: f5, content: big });
  const r5 = await callTool('read_file', { path: f5 });
  check(r5.content[0].text.length === 500000, `大文件 500KB 读写（实际 ${r5.content[0].text.length}）`);

  // 3.6 heredoc 分隔符冲突
  const delimContent = 'MCP_EOF_abc123\n'.repeat(100) + 'end';
  const f6 = `${TMP}/delim.txt`;
  await callTool('write_file', { path: f6, content: delimContent });
  const r6 = await callTool('read_file', { path: f6 });
  check(r6.content[0].text === delimContent, '内容含 heredoc 分隔符不冲突');

  // 3.7 read_multiple_files
  const rm = await callTool('read_multiple_files', { paths: [f1, f2] });
  check(!rm.isError && rm.content[0].text.includes('hello world'), 'read_multiple_files 批量读取');

  // ==================== 4. edit_file ====================
  console.log('\n[4] edit_file');

  const fe = `${TMP}/edit.txt`;
  await callTool('write_file', { path: fe, content: 'line1\nline2\nline3\n' });

  // 4.1 正常编辑
  const e1 = await callTool('edit_file', { path: fe, edits: [{ oldText: 'line2', newText: 'LINE2' }] });
  check(!e1.isError, 'edit_file 正常替换');
  const re1 = await callTool('read_file', { path: fe });
  check(re1.content[0].text.includes('LINE2') && !re1.content[0].text.includes('line2'), 'edit_file 替换生效');

  // 4.2 dryRun
  const e2 = await callTool('edit_file', { path: fe, edits: [{ oldText: 'LINE2', newText: 'DRY' }], dryRun: true });
  check(!e2.isError && e2.content[0].text.includes('diff'), 'edit_file dryRun 返回 diff');
  const re2 = await callTool('read_file', { path: fe });
  check(re2.content[0].text.includes('LINE2') && !re2.content[0].text.includes('DRY'), 'edit_file dryRun 不修改文件');

  // 4.3 oldText 不存在
  const e3 = await callTool('edit_file', { path: fe, edits: [{ oldText: 'NOT_EXIST', newText: 'X' }] });
  check(e3.isError, 'edit_file oldText 不存在时报错');

  // ==================== 5. move_file ====================
  console.log('\n[5] move_file');

  const fsrc = `${TMP}/move-src.txt`;
  const fdst = `${TMP}/move-dst.txt`;
  await callTool('write_file', { path: fsrc, content: 'move me' });
  const mv = await callTool('move_file', { source: fsrc, destination: fdst });
  check(!mv.isError, 'move_file 成功');
  const rsrc = await callTool('read_file', { path: fsrc });
  check(rsrc.isError, 'move_file 源文件已删除');
  const rdst = await callTool('read_file', { path: fdst });
  check(rdst.content[0].text === 'move me', 'move_file 目标文件内容正确');

  // ==================== 6. copy_file ====================
  console.log('\n[6] copy_file');

  const csrc = `${TMP}/copy-src.txt`;
  const cdst = `${TMP}/copy-dst.txt`;
  await callTool('write_file', { path: csrc, content: 'copy me' });

  const cp1 = await callTool('copy_file', { source: csrc, destination: cdst });
  check(!cp1.isError, 'copy_file 首次复制');

  const cp2 = await callTool('copy_file', { source: csrc, destination: cdst });
  check(cp2.isError, 'copy_file 目标存在时拒绝覆盖');

  const cp3 = await callTool('copy_file', { source: csrc, destination: cdst, overwrite: true });
  check(!cp3.isError, 'copy_file overwrite=true 覆盖');

  // copy 目录
  const cdir = `${TMP}/copydir`;
  await callTool('create_directory', { path: cdir });
  await callTool('write_file', { path: `${cdir}/inner.txt`, content: 'inner' });
  const cpdir = `${TMP}/copydir-copy`;
  await callTool('copy_file', { source: cdir, destination: cpdir });
  const rcp = await callTool('read_file', { path: `${cpdir}/inner.txt` });
  check(rcp.content[0].text === 'inner', 'copy_file 递归复制目录');

  // ==================== 7. delete_file ====================
  console.log('\n[7] delete_file');

  const fdel = `${TMP}/delete.txt`;
  await callTool('write_file', { path: fdel, content: 'delete me' });
  const del1 = await callTool('delete_file', { path: fdel });
  check(!del1.isError, 'delete_file 成功');
  const rdel = await callTool('read_file', { path: fdel });
  check(rdel.isError, 'delete_file 后文件不存在');

  // 删除目录
  const ddel = `${TMP}/deldir`;
  await callTool('create_directory', { path: ddel });
  await callTool('write_file', { path: `${ddel}/a.txt`, content: 'a' });
  const del2 = await callTool('delete_file', { path: ddel });
  check(!del2.isError, 'delete_file 递归删除目录');

  // ==================== 8. search ====================
  console.log('\n[8] search');

  const sdir = `${TMP}/search`;
  await callTool('create_directory', { path: sdir });
  await callTool('write_file', { path: `${sdir}/hello.js`, content: 'const hello = "world";\nconsole.log(hello);\n' });
  await callTool('write_file', { path: `${sdir}/data.txt`, content: 'hello there\nhello again\n' });

  // search_files_by_name
  const sfn = await callTool('search_files_by_name', { path: sdir, pattern: 'hello' });
  check(!sfn.isError && sfn.content[0].text.includes('hello.js'), 'search_files_by_name 找到 hello.js');

  // search_files_by_name 排除
  const sfn2 = await callTool('search_files_by_name', { path: sdir, pattern: 'hello', excludePatterns: ['*.js'] });
  check(!sfn2.content[0].text.includes('hello.js'), 'search_files_by_name 排除 *.js 生效');

  // search_in_files 固定字符串
  const sif = await callTool('search_in_files', { path: sdir, pattern: 'hello' });
  check(!sif.isError && sif.content[0].text.includes('hello.js'), 'search_in_files 找到匹配');

  // search_in_files 正则
  const sif2 = await callTool('search_in_files', { path: sdir, pattern: 'con\\w+', isRegex: true });
  check(!sif2.isError && sif2.content[0].text.includes('console'), 'search_in_files 正则匹配');

  // search_in_files 大小写不敏感
  const sif3 = await callTool('search_in_files', { path: sdir, pattern: 'HELLO', caseInsensitive: true });
  check(!sif3.isError && sif3.content[0].text.includes('hello'), 'search_in_files 大小写不敏感');

  // search_in_files 包含模式
  const sif4 = await callTool('search_in_files', { path: sdir, pattern: 'hello', includePatterns: ['*.txt'] });
  check(!sif4.content[0].text.includes('hello.js'), 'search_in_files includePatterns 仅搜 *.txt');

  // ==================== 9. get_file_info ====================
  console.log('\n[9] get_file_info');

  const fi = await callTool('get_file_info', { path: f1 });
  check(!fi.isError && fi.content[0].text.includes('size'), 'get_file_info 返回 size 等信息');

  const fi2 = await callTool('get_file_info', { path: TMP });
  check(!fi2.isError && fi2.content[0].text.includes('isDirectory: true'), 'get_file_info 目录识别');

  // ==================== 10. read_file_by_parts ====================
  console.log('\n[10] read_file_by_parts');

  const pf = `${TMP}/parts.txt`;
  // 15000 行 ≈ 150KB > PART_SIZE(95KB)，确保至少有 2 个 part
  const lines = Array.from({ length: 15000 }, (_, i) => `line ${i} padding-padding-padding`).join('\n');
  await callTool('write_file', { path: pf, content: lines });

  const p1 = await callTool('read_file_by_parts', { path: pf, part_number: 1 });
  check(!p1.isError && p1.content[0].text.startsWith('line 0'), 'read_file_by_parts part 1 从开头开始');

  const p2 = await callTool('read_file_by_parts', { path: pf, part_number: 2 });
  check(!p2.isError && p2.content[0].text.length > 0, 'read_file_by_parts part 2 有内容');

  const p99 = await callTool('read_file_by_parts', { path: pf, part_number: 99 });
  check(p99.isError, 'read_file_by_parts 超出范围时报错');

  // ==================== 11. convert_path ====================
  console.log('\n[11] convert_path');

  const c1 = await callTool('convert_path', { path: 'C:\\Users\\test' });
  check(c1.content[0].text.includes('/mnt/c/Users/test'), 'convert_path Windows→WSL');

  const c2 = await callTool('convert_path', { path: '/home/user' });
  check(c2.content[0].text.length > 0, 'convert_path WSL→Windows 有结果');

  const c3 = await callTool('convert_path', { path: 'C:\\Users\\a b' });
  check(c3.content[0].text.includes('/mnt/c/Users/a b'), 'convert_path 含空格路径');

  // ==================== 12. exec_command ====================
  console.log('\n[12] exec_command');

  // 基础
  const ex1 = await callTool('exec_command', { command: 'echo hello' });
  check(!ex1.isError && ex1.content[0].text.includes('hello'), 'exec_command 基础执行');

  // 管道
  const ex2 = await callTool('exec_command', { command: 'echo "a b c" | tr " " "\\n" | sort | head -1' });
  check(!ex2.isError && ex2.content[0].text.includes('a'), 'exec_command 管道');

  // 重定向
  const ex3 = await callTool('exec_command', { command: `echo "redirected" > '${TMP}/redir.txt' && cat '${TMP}/redir.txt'` });
  check(!ex3.isError && ex3.content[0].text.includes('redirected'), 'exec_command 重定向');

  // cwd
  const ex4 = await callTool('exec_command', { command: 'pwd', cwd: TMP });
  check(!ex4.isError && ex4.content[0].text.includes(TMP), 'exec_command cwd 生效');

  // 非零退出码
  const ex5 = await callTool('exec_command', { command: 'exit 42' });
  check(!ex5.isError && ex5.content[0].text.includes('exit_code: 42'), 'exec_command 非零退出码返回 exit_code，isError=false');

  // 危险命令拦截
  const dangerous = ['sudo rm -rf /', 'mkfs.ext4 /dev/sda', 'shutdown now', ':(){ :|:& };:', 'dd if=/dev/zero of=/dev/sda'];
  let allBlocked = true;
  for (const cmd of dangerous) {
    const r = await callTool('exec_command', { command: cmd });
    if (!r.isError) { allBlocked = false; break; }
  }
  check(allBlocked, `exec_command 拦截 ${dangerous.length} 种危险命令`);

  // 超时
  const ex6 = await callTool('exec_command', { command: 'sleep 10', timeout: 1000 });
  check(ex6.isError, 'exec_command 超时触发错误');

  // ==================== 13. 安全测试：白名单边界 ====================
  console.log('\n[13] 安全测试：白名单边界');

  const outside = '/etc/passwd';
  const s1 = await callTool('read_file', { path: outside });
  check(s1.isError, '白名单外路径 read_file 被拒');

  const s2 = await callTool('write_file', { path: outside, content: 'x' });
  check(s2.isError, '白名单外路径 write_file 被拒');

  const s3 = await callTool('create_directory', { path: '/tmp/should-not-create' });
  check(s3.isError, '白名单外路径 create_directory 被拒');

  const s4 = await callTool('list_directory', { path: '/etc' });
  check(s4.isError, '白名单外路径 list_directory 被拒');

  // exec_command cwd 白名单外
  const s5 = await callTool('exec_command', { command: 'echo hi', cwd: '/etc' });
  check(s5.isError, 'exec_command cwd 在白名单外被拒');

  // exec_command command 可访问白名单外（设计如此）
  const s6 = await callTool('exec_command', { command: 'cat /etc/hostname' });
  check(!s6.isError, 'exec_command command 本身可访问白名单外路径（设计选择）');

  // 路径穿越尝试
  const s7 = await callTool('read_file', { path: `${ALLOWED}/../../etc/passwd` });
  check(s7.isError, '路径穿越 ../../etc/passwd 被拒');

  // ==================== 14. 错误处理 ====================
  console.log('\n[14] 错误处理');

  const err1 = await callTool('read_file', { path: `${TMP}/nonexistent.txt` });
  check(err1.isError, '读取不存在的文件报错');

  const err2 = await callTool('delete_file', { path: `${TMP}/nonexistent.txt` });
  check(!err2.isError, '删除不存在的文件不报错（rm -rf 幂等性）');

  const err3 = await callTool('copy_file', { source: `${TMP}/nonexistent.txt`, destination: `${TMP}/x.txt` });
  check(err3.isError, '复制不存在的源文件报错');

  const err4 = await callTool('get_file_info', { path: `${TMP}/nonexistent.txt` });
  check(err4.isError, '获取不存在文件的 info 报错');

  // ==================== 15. 性能测试 ====================
  console.log('\n[15] 性能测试');

  const start = Date.now();
  for (let i = 0; i < 20; i++) {
    await callTool('read_file', { path: f1 });
  }
  const elapsed = Date.now() - start;
  check(elapsed < 30000, `20 次 read_file 总耗时 ${elapsed}ms < 30000ms`);
  console.log(`  20 次 read_file 平均: ${(elapsed / 20).toFixed(0)}ms/次`);

  // ==================== 清理 ====================
  console.log('\n[清理]');
  await callTool('delete_file', { path: TMP }).catch(() => {});

  console.log(`\n${'='.repeat(50)}`);
  console.log(`测试结果: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n失败项:');
    failures.forEach(f => console.log(`  - ${f}`));
  }
  console.log('='.repeat(50));

  child.kill();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); child.kill(); process.exit(1); });
