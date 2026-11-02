import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'campus-smoke-'));
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', resolve);
});
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const child = spawn(process.execPath, ['--enable-source-maps', 'dist-server/server/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    CAMPUS_DB_PATH: join(temp, 'fresh.sqlite'),
    CAMPUS_LEGACY_DATA_PATH: '',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (chunk) => {
  logs += chunk;
});
child.stderr.on('data', (chunk) => {
  logs += chunk;
});
const done = new Promise((resolve) => child.once('exit', resolve));
const url = `http://127.0.0.1:${port}`;
async function request(path, options) {
  const response = await fetch(`${url}${path}`, options);
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`启动进程提前退出：${logs}`);
    try {
      const result = await request('/api/v1/health');
      ready = result.ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `服务未就绪：${logs}`);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /校招进度助手/);
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]);
  assert.ok(
    assets.some((asset) => asset.endsWith('.js')) && assets.some((asset) => asset.endsWith('.css')),
  );
  for (const asset of assets) {
    const response = await fetch(new URL(asset, url));
    assert.equal(response.status, 200, `静态资源 ${asset}`);
    assert.doesNotMatch(response.headers.get('content-type') || '', /text\/html/);
    assert.ok((await response.text()).length > 0);
  }
  assert.deepEqual(await request('/api/v1/jobs?market=cn'), []);
  assert.deepEqual(await request('/api/v1/jobs?market=us'), []);
  const status = await request('/api/v1/status?market=cn');
  assert.equal(status.email.configured, false);
  const job = await request('/api/v1/jobs?market=cn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ company: '示例科技', position: '数据分析师', status: '已投递' }),
  });
  const exported = await request('/api/v1/export?market=cn');
  assert.equal(exported.jobs[0].id, job.id);
  assert.deepEqual(await request('/api/v1/jobs?market=us'), []);
  console.log(
    '生产启动冒烟验证通过：空库、页面、API、投递写入、导出及模块隔离正常；未连接真实邮箱。',
  );
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await done;
  await rm(temp, { recursive: true, force: true });
}
