import { createDemoServer } from '../dist-server/server/demo.js';

const port = 43112;
const demo = await createDemoServer({ port });
try {
  await demo.app.listen({ host: '127.0.0.1', port });
} catch (error) {
  await demo.close();
  console.error(`Demo could not start on port ${port}: ${error.message}`);
  process.exit(1);
}
console.log(`Synthetic demo: http://127.0.0.1:${port}`);
console.log(`Scenario controls: http://127.0.0.1:${port}/demo`);
console.log('40 fictional applications; no personal database, email or system notifications.');
console.log('Press Ctrl+C to close and remove the temporary demo database.');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    try {
      await demo.close();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });
