import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = join(root, '.env.development');
if (existsSync(config)) process.loadEnvFile(config);
const child = spawn(
  process.execPath,
  [
    join(root, 'node_modules/concurrently/dist/bin/concurrently.js'),
    '-k',
    'npm:dev:server',
    'npm:dev:web',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: process.env.PORT || '43111',
      CAMPUS_DB_PATH: process.env.CAMPUS_DB_PATH || 'data/runtime/development.sqlite',
    },
  },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
