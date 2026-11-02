import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

export const rootFiles = new Set([
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.prettierignore',
  '.prettierrc.json',
  '.nvmrc',
  '.env.example',
  '.env.development.example',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'LICENSE',
  'NOTICE.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.server.json',
  'vite.config.ts',
  'vitest.config.ts',
  '启动校招助手.command',
]);
const directories = new Set(['.github', 'src', 'tests', 'scripts', 'extension', 'docs', 'public']);

export function isSourcePath(path) {
  const parts = path.split('/');
  if (rootFiles.has(path) || path === 'data/.gitkeep') return true;
  if (
    !directories.has(parts[0]) ||
    parts.some((part) => part === '..' || part === 'node_modules' || part === '.DS_Store')
  )
    return false;
  if (path.startsWith('docs/local-history/')) return false;
  return !/(?:^|\/)\.env(?:\.|$)|\.(?:sqlite(?:-\w+)?|db(?:-\w+)?|log|eml|mbox|pem|key|p12|pfx|zip|gz)$/i.test(
    path,
  );
}

export async function sourceFiles(root) {
  const result = [];
  async function walk(relative = '') {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && !rootFiles.has(path) && !directories.has(path) && path !== 'data') continue;
      if (entry.isDirectory()) {
        if (path === 'data' || isSourcePath(`${path}/_`)) await walk(path);
      } else if (isSourcePath(path)) {
        if (entry.isSymbolicLink() || !(await lstat(join(root, path))).isFile())
          throw new Error(`发行文件必须为普通文件：${path}`);
        result.push(path);
      }
    }
  }
  await walk();
  return result.sort();
}
