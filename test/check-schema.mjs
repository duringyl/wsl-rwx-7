import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'dist', 'index.js');

const proc = spawn('node', [serverPath, '--distro=Ubuntu-24.04', '/home/duringyl/wspace'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let buf = '';
proc.stdout.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      const j = JSON.parse(l);
      if (j.id === 2 && j.result && j.result.tools) {
        const exec = j.result.tools.find(t => t.name === 'exec_command');
        console.log('=== exec_command inputSchema ===');
        console.log(JSON.stringify(exec.inputSchema, null, 2));
        const hasType = exec.inputSchema.type === 'object';
        const hasProps = exec.inputSchema.properties && 'command' in exec.inputSchema.properties;
        const hasRequired = Array.isArray(exec.inputSchema.required) && exec.inputSchema.required.includes('command');
        console.log(`\nChecks: type=object:${hasType}, has command prop:${hasProps}, command required:${hasRequired}`);
        console.log(hasType && hasProps && hasRequired ? '\n✅ Schema is VALID' : '\n❌ Schema is BROKEN');
        proc.kill();
        process.exit(0);
      }
    } catch (e) { /* not json, skip */ }
  }
});

proc.stderr.on('data', (d) => { /* ignore stderr from server init */ });

proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }) + '\n');
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 15000);
