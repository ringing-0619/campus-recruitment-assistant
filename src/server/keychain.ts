import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SERVICE = '校招进度助手-126邮箱';
function requireMacOS() {
  if (process.platform !== 'darwin')
    throw new Error('126 邮箱凭据存储目前仅支持 macOS 钥匙串，请在 macOS 上配置邮箱。');
}

export function normalizeAuthorizationCode(value: string) {
  return value.normalize('NFKC').replace(/[\s-]+/g, '');
}

export async function saveMailCredential(address: string, authorizationCode: string) {
  requireMacOS();
  await deleteMailCredential(address).catch(() => undefined);
  await execFileAsync('/usr/bin/security', [
    'add-generic-password',
    '-a',
    address,
    '-s',
    SERVICE,
    '-w',
    authorizationCode,
  ]);
}

export async function readMailCredential(address: string) {
  requireMacOS();
  const { stdout } = await execFileAsync('/usr/bin/security', [
    'find-generic-password',
    '-a',
    address,
    '-s',
    SERVICE,
    '-w',
  ]);
  return stdout.trim();
}

export async function deleteMailCredential(address: string) {
  requireMacOS();
  await execFileAsync('/usr/bin/security', [
    'delete-generic-password',
    '-a',
    address,
    '-s',
    SERVICE,
  ]);
}
