import { mkdir, mkdtemp, cp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sourceFiles } from './repository-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.execPath, ['scripts/check-repository.mjs'], { cwd: root, stdio: 'inherit' });
const { name, version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const output = join(root, 'output', 'github');
const temp = await mkdtemp(join(tmpdir(), 'campus-source-'));
const folder = `${name}-${version}`;
const archive = join(output, `${folder}-source.tar.gz`);
try {
  const files = await sourceFiles(root);
  for (const file of files) {
    const target = join(temp, folder, file);
    await mkdir(join(target, '..'), { recursive: true });
    await cp(join(root, file), target, { preserveTimestamps: true });
  }
  await mkdir(output, { recursive: true });
  execFileSync('tar', ['-czf', archive, '-C', temp, folder], {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${folder}-source.tar.gz\n`);
  await writeFile(
    join(output, 'source-manifest.json'),
    JSON.stringify({ name, version, fileCount: files.length, files }, null, 2) + '\n',
  );
  console.log(
    `已生成源码包：${archive}\n包含 ${files.length} 个文件，附 SHA-256 校验和及文件清单。`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
