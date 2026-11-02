import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [target, node, project] = process.argv.slice(2);
if (!target || !node || !project) throw new Error('需要 plist 路径、Node.js 路径和项目目录');
const xml = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const string = (value) => `<string>${xml(value)}</string>`;
const log = join(project, 'data', 'runtime');
mkdirSync(dirname(target), { recursive: true });
mkdirSync(log, { recursive: true });
writeFileSync(
  target,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.local.campus-recruitment-assistant</string>
  <key>ProgramArguments</key><array>${[node, '--env-file-if-exists=.env', '--enable-source-maps', join(project, 'dist-server/server/index.js')].map(string).join('')}</array>
  <key>WorkingDirectory</key>${string(project)}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${string(join(log, 'service.log'))}
  <key>StandardErrorPath</key>${string(join(log, 'service-error.log'))}
</dict></plist>
`,
);
