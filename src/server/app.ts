import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { existsSync } from 'node:fs';
import { Store } from './db.js';
import { CandidateService } from './candidates.js';
import { MailSyncService, type MailSyncOptions } from './mail.js';
import { registerApi } from './api.js';
import { registerProductivityApi } from './productivity-api.js';
import { ReminderService } from './reminders.js';
import { webDistPath } from './paths.js';

export interface ServerOptions {
  store?: Store;
  candidateService?: CandidateService;
  mail?: MailSyncService;
  mailOptions?: MailSyncOptions;
  startMail?: boolean;
  webRoot?: string;
  demoMode?: boolean;
}

export async function createServer(options: ServerOptions = {}) {
  if (options.demoMode && !options.store)
    throw new Error('Demo mode requires an explicitly isolated store');
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.x-campus-token'],
    },
  });
  const store = options.store ?? new Store();
  const candidateService = options.candidateService ?? new CandidateService(store);
  const mail =
    options.mail ??
    new MailSyncService(store, candidateService, {
      ...options.mailOptions,
      onBackgroundError:
        options.mailOptions?.onBackgroundError ??
        ((reason) => app.log.warn({ reason }, '126 邮箱后台同步失败，已安排重试')),
    });

  if (options.demoMode) {
    app.addHook('onRequest', async (request, reply) => {
      const route = request.routeOptions.url || request.url.split('?')[0];
      if (route.startsWith('/api/v1/email/') || route === '/api/v1/reminders/test-desktop')
        return reply.code(403).send({ error: '模拟演示不连接真实邮箱或发送系统通知。' });
    });
  }

  await app.register(cors, {
    origin(origin, callback) {
      const allowed =
        !origin ||
        /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin) ||
        /^chrome-extension:\/\//.test(origin) ||
        /^edge-extension:\/\//.test(origin);
      callback(null, allowed);
    },
    allowedHeaders: ['content-type', 'x-campus-token'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  registerApi(app, store, candidateService, mail);
  const reminders = new ReminderService(store);
  registerProductivityApi(app, store, reminders);
  const reminderTimer =
    options.startMail === false || options.demoMode
      ? null
      : setInterval(() => {
          if (!mail.status().syncing) void reminders.tick();
        }, 60_000);
  reminderTimer?.unref();

  const webRoot = options.webRoot ?? webDistPath;
  if (existsSync(webRoot)) {
    await app.register(staticPlugin, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: '接口不存在' })
        : reply.sendFile('index.html'),
    );
  }

  app.addHook('onClose', async () => {
    if (reminderTimer) clearInterval(reminderTimer);
    mail.stop();
    store.close();
  });
  if (options.startMail !== false && !options.demoMode) mail.start();
  return { app, store, candidateService, mail, reminders };
}
