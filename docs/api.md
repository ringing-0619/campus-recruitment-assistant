# API 概览

默认地址为 `http://127.0.0.1:43110/api/v1`。API 面向本机单用户使用，不能直接作为公网服务暴露。

## 共同约定

- 查询参数 `market=cn` 或 `market=us` 指定求职模块，默认国内。实体与模块不一致时返回 404。
- 请求和响应使用 JSON；日历接口返回 `.ics`。时间尽量使用带时区的 ISO 8601，纯日期为 `YYYY-MM-DD`。
- 扩展写入接口使用 `x-campus-token`，令牌从本地配对设置获取，日志对该请求头脱敏。
- 本地管理接口没有多用户登录体系。CORS 限定本地网页及扩展来源，服务只监听回环地址。

## 主要接口

| 方法               | 路径                      | 作用                                   |
| ------------------ | ------------------------- | -------------------------------------- |
| GET                | `/health`                 | 服务健康和协议版本                     |
| GET                | `/status`                 | 邮箱同步、扩展连接、模块路由与待确认数 |
| GET / POST         | `/jobs`                   | 列表／新增投递                         |
| GET / PUT / DELETE | `/jobs/:id`               | 读取／编辑／删除投递                   |
| POST               | `/jobs/:id/events`        | 添加人工阶段                           |
| GET                | `/candidates`             | 当前模块待确认                         |
| POST               | `/candidates`             | 扩展或识别候选入库，要求配对令牌       |
| POST               | `/candidates/:id/confirm` | 选择申请或新建并采纳                   |
| POST               | `/candidates/:id/ignore`  | 忽略候选                               |
| GET                | `/audit`                  | 审计记录                               |
| POST               | `/audit/:id/undo`         | 撤销支持的变更                         |
| GET                | `/pairing`                | 本机扩展配对信息                       |
| PUT                | `/routing`                | 邮件／网页默认归属                     |
| POST               | `/email/configure`        | 验证并保存 126 连接                    |
| DELETE             | `/email/configure`        | 断开并删除钥匙串凭据                   |
| POST               | `/email/sync`             | 立即同步                               |
| GET                | `/export`                 | 当前模块 JSON 备份                     |
| POST               | `/import`                 | 当前模块导入                           |
| GET / PUT          | `/productivity/settings`  | 时区、提醒与通知设置                   |
| GET                | `/analytics`              | 漏斗及分组统计                         |
| GET / PUT          | `/goals`                  | 目标汇总／规则                         |
| PUT                | `/goals/current-targets`  | 当前目标设置                           |
| PUT                | `/goals/override`         | 特定日期／周的目标覆盖                 |
| PUT                | `/applications/batch`     | 批量更新申请元数据                     |
| GET                | `/actions`                | 行动列表与日历数据                     |
| GET                | `/calendar.ics`           | 导出日历                               |
| PUT                | `/events/:id`             | 事件轮次、结果与时间                   |
| PUT                | `/tasks/:id`              | 任务改期或取消                         |
| POST               | `/tasks/:id/complete`     | 完成任务                               |
| GET                | `/reminders`              | 提醒列表                               |
| POST               | `/reminders/action`       | 稍后提醒、已跟进等                     |
| POST               | `/reminders/test-desktop` | 测试 macOS 通知                        |

## 新增投递示例

```bash
curl -X POST 'http://127.0.0.1:43110/api/v1/jobs?market=cn' \
  -H 'Content-Type: application/json' \
  -d '{"company":"示例科技","position":"数据分析师","status":"已投递"}'
```

实际请求字段与约束以 `src/server/api.ts`、`src/server/productivity-api.ts` 及 `src/shared/types.ts` 为准。
