import { createServer } from './app.js';

const port = Number(process.env.PORT || 43110);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT 必须为 1–65535 的整数');
const { app, store } = await createServer();
store.backupIfDue();
const backupTimer = setInterval(
  () => {
    try {
      store.backupIfDue();
    } catch (error) {
      app.log.error({ error }, '数据库备份失败');
    }
  },
  60 * 60 * 1000,
);
backupTimer.unref();
app.addHook('onClose', async () => clearInterval(backupTimer));

try {
  await app.listen({ host: '127.0.0.1', port });
} catch (error) {
  await app.close();
  throw error;
}
console.log(`校招进度助手已启动：http://127.0.0.1:${port}`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
