# 开发与贡献

先阅读 [README](README.md)、[架构](docs/architecture.md) 和 [开发验证](docs/development.md)。项目当前保留所有权利；提交贡献前请与仓库维护者确认接受条件。

## 开发流程

1. 使用 `.nvmrc` 指定的 Node.js 主版本，执行 `npm ci`。
2. 从 `main` 创建工作分支，例如 `fix/mail-subject-labels`。
3. 执行 `npm run dev`；开发数据库默认为 `data/runtime/development.sqlite`。
4. 修改后运行 `npm run format` 和 `npm run validate`。
5. 提交说明写清问题、行为变化和验证方式，发起 Pull Request。

## 修改约定

- 新的识别规则要同时覆盖成功样本、容易混淆的反例、重复同步及国内／美国隔离。
- 规则改变后更新 `MAIL_RULES_VERSION`，并验证旧待确认的重新解析。
- 修改表结构要保留已有数据库的兼容性；使用临时数据库验证迁移。
- 自动写入通过 `CandidateService`，保持岗位、事件、待办与审计的事务一致性。
- 邮件摘要应简短，完整正文仅在内存处理。不要把测试流量接到真实邮箱。
- 用户已经维护的公司、岗位与终态进度不得被弱匹配覆盖。
- 样本先脱敏，保留导致问题的结构；不要提交真实姓名、链接令牌、邮件会话编号、简历或数据库。

## 提交前检查

`npm run validate` 依次执行格式、类型、单元测试、扩展结构、仓库检查、生产构建和空库冒烟验证。真实 IMAP、浏览器登录和系统通知不在无人值守测试中运行。

提交前查看 `git diff --cached`，确认只包含本次需要的源码。涉及私密问题时按 [安全说明](SECURITY.md) 处理。
