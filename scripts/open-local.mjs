import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const config = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(config)) process.loadEnvFile(config);
const port = Number(process.env.PORT || 43110);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT 必须为 1–65535 的整数');
const url = `http://127.0.0.1:${port}`;
let online = false;
for (let attempt = 0; attempt < 50; attempt++) {
  try {
    const response = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
    online = response.ok && (await response.json()).ok;
  } catch {}
  if (online) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!online) throw new Error('服务未在预期时间启动，请检查 data/runtime/service-error.log');
console.log(`助手已就绪：${url}`);
if (process.platform === 'darwin') spawn('/usr/bin/open', [url], { stdio: 'ignore' }).unref();
