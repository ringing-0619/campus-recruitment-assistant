import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles, isSourcePath } from './repository-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = await sourceFiles(root),
  included = new Set(files),
  problems = [];
const patterns = [
  ['私钥', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['GitHub访问令牌', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  [
    '带凭据的链接',
    /[?&](?:share_token|access_token|refresh_token|client_secret)=[A-Za-z0-9%_-]{12,}/i,
  ],
  ['个人机器绝对路径', /(?:\/Users\/|[A-Z]:\\Users\\)[^\s/'"\\]+[\/\\]/],
];
try {
  const gitFiles = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
    .split('\0')
    .filter(Boolean);
  for (const path of gitFiles)
    if (!isSourcePath(path)) problems.push(`Git包含发行范围以外的文件：${path}`);
} catch (error) {
  if (error.status !== 128) throw error; /* Source ZIPs need no .git directory. */
}

for (const path of files) {
  if ((await stat(join(root, path))).size > 1_000_000)
    problems.push(`文件超过1 MB，需确认是否为生成物：${path}`);
  const text = await readFile(join(root, path), 'utf8');
  for (const [label, pattern] of patterns)
    if (pattern.test(text)) problems.push(`${label}：${path}`);
  // 保留识别器需要的编号形态，同时要求测试值使用显式虚构前缀，防止再次复制真实申请编号。
  if (path.startsWith('tests/')) {
    const identifiers = text.matchAll(/(?<![0-9a-z])(?:[0-9a-f]{24}|[0-9]{9})(?![0-9a-z])/gi);
    for (const [value] of identifiers) {
      if (!/^0{20}\d{4}$/.test(value) && !/^900000\d{3}$/.test(value)) {
        problems.push(`测试编号需要脱敏（使用显式虚构前缀）：${path}`);
        break;
      }
    }
  }
  if (path.endsWith('.md')) {
    for (const match of text.matchAll(/!?\[[^\]]*\]\((<?[^\s)>]+>?)(?:\s+"[^"]*")?\)/g)) {
      let target = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!target || /^[a-z]+:|^\/\//i.test(target)) continue;
      target = decodeURIComponent(target);
      const resolved = normalize(join(dirname(path), target)).replaceAll('\\', '/');
      if (!included.has(resolved)) problems.push(`文档链接不在发行源码中：${path} → ${target}`);
    }
  }
  if (path.endsWith('.mjs') || (path.startsWith('extension/') && path.endsWith('.js'))) {
    try {
      execFileSync(process.execPath, ['--check', join(root, path)], { stdio: 'pipe' });
    } catch {
      problems.push(`JavaScript语法错误：${path}`);
    }
  }
  if (process.platform !== 'win32' && /\.(?:sh|command)$/.test(path)) {
    try {
      execFileSync('bash', ['-n', join(root, path)], { stdio: 'pipe' });
    } catch {
      problems.push(`Shell语法错误：${path}`);
    }
  }
}
for (const required of [
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  '.github/workflows/ci.yml',
  'tests/fixtures/legacy-jobs.json',
]) {
  if (!included.has(required)) problems.push(`缺少正式仓库文件：${required}`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `仓库检查通过：${files.length}个源码文件；未发现检查范围内的凭据模式、私有路径或失效的本地文档链接。`,
  );
