# 上传、更新与发布

## 首次推送

建议创建私有仓库。仓库名可使用 `campus-recruitment-assistant`，创建时保持为空，避免与本地 README 和许可文件产生不同的初始历史。

确认 Git 的提交用户名与邮箱；需要隐藏个人邮箱时，使用 GitHub 账户设置里提供的 noreply 地址。

```bash
git status --short
npm ci
npm run validate
npm audit
git add .
git diff --cached --stat
git diff --cached
git commit -m "chore: prepare version 3.1.0 repository"
git remote add origin https://github.com/YOUR_ACCOUNT/campus-recruitment-assistant.git
git push -u origin main
```

将 `YOUR_ACCOUNT` 替换为实际账户。整理后的工作目录已初始化 `main`；若从不含 `.git` 的源码包开始，在上述步骤前执行 `git init -b main`。

首次推送后查看 Actions 页。仓库内的工作流已提供配置，本机整理本身不会产生 GitHub 远程运行结果。

## 之后上传修改

每个改动使用工作分支，执行完整验证后提交并推送，合并回 `main`。代码、锁文件与文档一起更新，数据库与凭据保持本地。

```bash
git switch -c fix/recognition-update
# 完成代码修改
npm run validate
git add .
git diff --cached
git commit -m "fix: improve recruitment notification matching"
git push -u origin fix/recognition-update
```

## 更新本机使用的助手

先在界面导出当前模块 JSON；默认数据库和备份均不会被 Git 跟踪。然后在工作目录干净时执行：

```bash
git switch main
git pull --ff-only
npm ci
npm run validate
```

手动启动的进程先在原终端按 Control+C，再执行 `npm start`。安装了 macOS 登录自启动时，执行：

```bash
launchctl kickstart -k "gui/$(id -u)/com.local.campus-recruitment-assistant"
```

移动项目目录或切换 Node.js 安装位置后，重新执行 `npm run install:agent`，以更新 LaunchAgent 路径。扩展代码有更新时，在浏览器扩展管理页重新加载并刷新招聘页面。

## 源码包与版本

```bash
npm run package:source
```

输出位于 `output/github/`，包含版本化的 `.tar.gz` 源码包、`.sha256` 校验和与 `source-manifest.json`。源码包按发行文件白名单生成，解压后可以重新 `npm ci`、验证并运行。它可作为版本附件分享；GitHub 仓库中直接管理源码文件。

发布新版本时更新 `package.json`、锁文件和 `CHANGELOG.md`，完成验证并提交后，再创建相应版本标签。扩展版本独立记录在 `extension/manifest.json` 中。

## 保持私密数据在本地

`.gitignore` 排除实际数据、数据库、备份、导出、临时目录、实际 `.env` 及现场报告。`npm run repo:check` 会检查 Git 跟踪和未忽略文件，阻止超出发行范围的文件。

不要对这些目录使用 `git add -f`。如需补充样本，在 `tests/fixtures/` 中创建脱敏最小复现。关于已经进入历史的私密内容，参见 [安全说明](../SECURITY.md)。
