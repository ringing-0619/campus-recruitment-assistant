# 配置说明

## 环境变量

| 变量                      | 默认值                                      | 含义                                   |
| ------------------------- | ------------------------------------------- | -------------------------------------- |
| `PORT`                    | 生产 `43110`、开发 `43111`                  | 只监听 `127.0.0.1` 的本地端口          |
| `CAMPUS_DB_PATH`          | 生产 `data/runtime/campus-assistant.sqlite` | SQLite 路径；相对路径按项目根目录解析  |
| `CAMPUS_LEGACY_DATA_PATH` | 不设置                                      | 首次启动时可选的旧版 JSON 数组迁移文件 |
| `NODE_ENV`                | 不设置                                      | 测试模式下减少服务日志                 |

`npm start` 加载项目根目录下可选的 `.env`。`npm run dev` 使用可选的 `.env.development`，默认开发数据库为 `data/runtime/development.sqlite`。环境中显式设置的值优先。

配置模板可以复制为实际文件：

```bash
cp .env.example .env
cp .env.development.example .env.development
```

实际 `.env` 文件被 Git 忽略。模板只包含非敏感选项，授权码和扩展配对通过界面设置。

扩展默认连接 `http://127.0.0.1:43110/api/v1`。更改后端端口时，需要同步修改扩展选项中的服务地址，并保证扩展具有相应本地地址权限。通常保持默认端口最方便。

## 数据与备份

默认数据库在 `data/runtime/` 下。每日备份保存在当前数据库所在目录的 `backups/`，保留最近 7 份。自定义数据库不会备份其他路径的默认数据库。

Mac 自启动服务的日志保存在 `data/runtime/service.log` 和 `service-error.log`。日志、数据库及备份不属于发行源码。

网页 JSON 导出用于迁移与恢复；其中包含个人申请和事件，应保存在私密位置。邮箱授权码不随 JSON 导出。

## 可选旧数据迁移

新安装默认空库。需要迁移旧版数组时，在**新数据库首次启动前**设置 `CAMPUS_LEGACY_DATA_PATH`，指向本机旧数据文件。此自动迁移只执行一次，且只向空库导入。

已有数据库和已经完成首次启动的空库，请使用界面的 JSON 导入。带模块的备份应导入对应模块；旧版无模块数组导入当前模块。

原项目曾使用的本地迁移文件可以继续留在 `data/`，不会随源码上传，也不再作为安装或测试的必需文件。

## 系统支持

macOS 使用 `/usr/bin/security` 保存邮箱授权码，使用系统通知与 LaunchAgent。其他系统可运行网页、API 和未连接邮箱的核心功能，但尚未实现同等的凭据存储、自启动及通知能力。

Node.js 内置 SQLite 从受支持的 22.x 版本即可使用；API 背景见 [Node.js 22 SQLite 文档](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)。
