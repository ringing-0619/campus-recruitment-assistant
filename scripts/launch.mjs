import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const port = Number(process.env.PORT || 43110);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT 必须为 1–65535 的整数');
const url = `http://127.0.0.1:${port}`;
async function online() {
  try {
    const response = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).ok;
  } catch {
    return false;
  }
}
function open() {
  if (process.platform === 'darwin') spawn('/usr/bin/open', [url], { stdio: 'ignore' }).unref();
}
if (await online()) {
  open();
  console.log(`助手已经运行：${url}\n若刚更新代码，请按 docs/github.md 的说明重启已有后台服务。`);
} else {
  if (!existsSync(join(root, 'node_modules')))
    execFileSync('npm', ['ci'], { cwd: root, stdio: 'inherit' });
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  const child = spawn(process.execPath, ['--enable-source-maps', 'dist-server/server/index.js'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  const done = new Promise((resolve) => child.once('exit', resolve));
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
    if (await online()) {
      open();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const code = await done;
  process.exitCode = code ?? 1;
}
