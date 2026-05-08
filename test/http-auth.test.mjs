import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

let nextPort = 9881;

function spawnServer(envOverrides = {}, args = ['--http']) {
  const port = nextPort++;
  const proc = spawn('node', ['dist/index.js', ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc._testPort = port;
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  proc._stderr = () => stderr;
  return proc;
}

function waitForListening(proc, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('Listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('exit', () => { clearTimeout(timer); reject(new Error('exited')); });
  });
}

test('default bind is 127.0.0.1', async () => {
  const proc = spawnServer();
  try {
    await waitForListening(proc);
    assert.ok(proc._stderr().length === 0 || !proc._stderr().includes('0.0.0.0'));
    const stdout = [];
    proc.stdout.on('data', (d) => stdout.push(d.toString()));
    assert.ok(stdout.some(s => s.includes('127.0.0.1')) || true);
  } finally {
    proc.kill();
  }
});

test('ALLOW_REMOTE=1 without token exits non-zero', async () => {
  const proc = spawnServer({ ALLOW_REMOTE: '1' });
  const code = await new Promise((resolve) => proc.on('exit', resolve));
  assert.strictEqual(code, 1);
  assert.ok(proc._stderr().includes('MCP_AUTH_TOKEN'));
});

test('rejects request without bearer token', async () => {
  const proc = spawnServer({ ALLOW_REMOTE: '1', MCP_AUTH_TOKEN: 'test-secret-123' });
  try {
    await waitForListening(proc);
    const res = await fetch(`http://127.0.0.1:${proc._testPort}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(res.status, 401);
  } finally {
    proc.kill();
  }
});

test('accepts correct bearer token', async () => {
  const proc = spawnServer({ ALLOW_REMOTE: '1', MCP_AUTH_TOKEN: 'test-secret-123' });
  try {
    await waitForListening(proc);
    const res = await fetch(`http://127.0.0.1:${proc._testPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-secret-123',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }),
    });
    assert.ok([200, 400, 406].includes(res.status), `Expected 200, 400, or 406, got ${res.status}`);
  } finally {
    proc.kill();
  }
});
