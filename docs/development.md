# 开发与验证

## 本地开发

使用 Node.js 22.13+ 的 22.x 或 24.x，执行 `npm ci`，然后执行 `npm run dev`。

前端位于 `http://127.0.0.1:5173`，代理到开发 API 的 `43111` 端口。开发库与生产库不同；测试使用临时目录和虚构迁移样本，不依赖本机个人记录。

## 命令

| 命令                      | 作用                                                    |
| ------------------------- | ------------------------------------------------------- |
| `npm run format`          | 按固定版本 Prettier 统一格式                            |
| `npm run format:check`    | 检查格式，不修改文件                                    |
| `npm run typecheck`       | 前端、后端、共享类型及测试的 TypeScript 检查            |
| `npm test`                | Vitest 全套测试                                         |
| `npm run extension:check` | Manifest V3 与侧栏文件完整性                            |
| `npm run repo:check`      | 发行范围、指定凭据模式、脚本语法与文档本地链接检查      |
| `npm run build`           | 生成 `dist/`、`dist-server/` 并检查扩展                 |
| `npm run smoke`           | 启动构建产物，以全新临时数据库验证页面、API、写入和导出 |
| `npm run validate`        | 依次执行完整本地质量验证                                |
| `npm audit`               | 从 npm 查询当前依赖告警，需要网络                       |
| `npm run package:source`  | 生成源码包、校验和与发行文件清单                        |

## 测试边界

自动测试覆盖邮件目的与阶段、字段提取、岗位关联、重放去重、事务与审计、模块隔离、迁移、统计、目标、日历和浏览器扩展逻辑。

CI 不登录招聘网站，不访问真实邮箱，不触发系统通知。真实 IMAP、网站登录、系统权限及扩展侧栏交互需在对应环境下人工验证。仓库检查也不能证明任意附件已经脱敏。

## 持续集成

`.github/workflows/ci.yml` 在推送、Pull Request 和手动触发时运行。矩阵为 Ubuntu／macOS 与 Node.js 22／24；使用锁文件安装、只读仓库权限和固定提交版本的官方 Actions。

上传前的本机验证结果与 GitHub 实际运行结果分别记录；只有推送后才会产生远程 CI 结果。工作流结构参考 [GitHub Node.js 构建测试文档](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs)。

## 依赖与发布

锁文件随依赖变化提交。避免不经检查的强制大版本修复；依赖升级后完成完整验证。`@fastify/static` 的 `glob` 覆盖用于已知告警修复，静态资源冒烟验证是必要检查。

格式配置使用固定版本 Prettier，安装与使用方式见 [官方说明](https://prettier.io/docs/install)。Vite 大版本调整后同时检查开发代理和生产构建，迁移背景见 [Vite 迁移文档](https://vite.dev/guide/migration)。

GitHub 发布和更新步骤见 [上传与版本管理](github.md)。
