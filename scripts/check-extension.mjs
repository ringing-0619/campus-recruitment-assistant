import { readFile } from 'node:fs/promises';
const manifest = JSON.parse(
  await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'),
);
if (manifest.manifest_version !== 3) throw new Error('扩展必须使用 Manifest V3');
for (const file of [
  'background.js',
  'popup.html',
  'popup.js',
  'options.html',
  'options.js',
  'content.js',
])
  await readFile(new URL(`../extension/${file}`, import.meta.url));
if (
  !manifest.permissions.includes('sidePanel') ||
  manifest.side_panel?.default_path !== 'popup.html' ||
  manifest.action?.default_popup
)
  throw new Error('记录界面必须通过持久侧栏打开');
console.log('Chromium 扩展结构检查通过');
