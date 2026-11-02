import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  JOB_STATUSES,
  MARKETS,
  normalizeMarket,
  type CandidateInput,
  type JobStatus,
  type Market,
} from '../shared/types.js';
import type { Store } from './db.js';
import type { CandidateService } from './candidates.js';
import { safeError, type MailSyncService } from './mail.js';
import {
  parseApplication,
  manualStage,
  recordManualStatus,
  parseDate,
} from './productivity-api.js';
import { GoalService } from './goals.js';
import { productivitySettings } from './reminders.js';
import { validTimezone } from '../shared/time.js';
import {
  saveMailCredential,
  deleteMailCredential,
  normalizeAuthorizationCode,
} from './keychain.js';

export function registerApi(
  app: FastifyInstance,
  store: Store,
  candidateService: CandidateService,
  mail: MailSyncService,
) {
  app.addHook('preHandler', async (request, reply) => {
    const query = request.query as { market?: string };
    if (query.market !== undefined && !MARKETS.includes(query.market as Market))
      return reply.code(400).send({ error: '未知求职模块' });
    const entity = request.url
      .split('?')[0]
      .match(/^\/api\/v1\/(jobs|candidates|tasks|events|audit)\/([^/]+)/);
    if (entity && store.entityMarket(entity[1], entity[2]) !== requestMarket(request)) {
      return reply.code(404).send({ error: '当前模块中不存在该记录' });
    }
  });
  app.get('/api/v1/health', async () => ({ ok: true, version: 3 }));
  app.get('/api/v1/extension/ping', { preHandler: extensionAuth(store) }, async () => ({
    ok: true,
  }));
  app.get('/api/v1/jobs', async (request) => store.listJobs(requestMarket(request)));
  app.get<{ Params: { id: string } }>(
    '/api/v1/jobs/:id',
    async (request, reply) =>
      store.getJob(request.params.id) || reply.code(404).send({ error: '岗位不存在' }),
  );
  app.post<{ Body: Record<string, unknown> }>('/api/v1/jobs', async (request, reply) => {
    const company = text(request.body.company),
      position = text(request.body.position);
    if (!company || !position) return reply.code(400).send({ error: '公司和岗位不能为空' });
    return store.transaction(() => {
      const job = store.createJob({
        market: requestMarket(request),
        company,
        position,
        status: validStatus(request.body.status),
        notes: text(request.body.notes),
        progressUrls: arrayOfText(request.body.progressUrls),
        source: 'manual',
        application:
          request.body.application === undefined
            ? undefined
            : parseApplication(
                request.body.application,
                undefined,
                productivitySettings(store).timezone,
              ),
      });
      recordManualStatus(store, null, job);
      return store.getJob(job.id);
    });
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/jobs/:id',
    async (request, reply) => {
      const before = store.getJob(request.params.id);
      const updated = store.transaction(() => {
        const job = store.updateJob(request.params.id, {
          company: text(request.body.company),
          position: text(request.body.position),
          status: validStatus(request.body.status),
          notes: text(request.body.notes),
          progressUrls: arrayOfText(request.body.progressUrls),
          ...(request.body.application === undefined
            ? {}
            : {
                application: parseApplication(
                  request.body.application,
                  before?.application,
                  productivitySettings(store).timezone,
                ),
              }),
        });
        if (job) recordManualStatus(store, before, job);
        return job ? store.getJob(job.id) : null;
      });
      return updated || reply.code(404).send({ error: '岗位不存在' });
    },
  );
  app.delete<{ Params: { id: string } }>('/api/v1/jobs/:id', async (request, reply) =>
    store.deleteJob(request.params.id)
      ? { ok: true }
      : reply.code(404).send({ error: '岗位不存在' }),
  );
  app.post<{ Params: { id: string }; Body: { health: 'ok' | 'needs_login' | 'error' } }>(
    '/api/v1/jobs/:id/sync-health',
    { preHandler: extensionAuth(store) },
    async (request, reply) => {
      const job = store.getJob(request.params.id);
      if (!job) return reply.code(404).send({ error: '岗位不存在' });
      return store.updateJob(job.id, {
        syncHealth: request.body.health,
        lastSyncedAt: new Date().toISOString(),
      });
    },
  );
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/jobs/:id/events',
    async (request, reply) => {
      const job = store.getJob(request.params.id);
      if (!job) return reply.code(404).send({ error: '岗位不存在' });
      return manualStage(store, job, request.body);
    },
  );
  app.post<{ Params: { id: string }; Body: { completedAt?: string; overwrite?: boolean } }>(
    '/api/v1/tasks/:id/complete',
    async (request, reply) => {
      try {
        return (
          store.completeTask(
            request.params.id,
            parseDate(request.body?.completedAt || new Date().toISOString(), false)!,
            Boolean(request.body?.overwrite),
          ) || reply.code(404).send({ error: '任务不存在' })
        );
      } catch (error) {
        if ((error as Error).message === 'TASK_ALREADY_COMPLETED')
          return reply.code(409).send({ error: '任务已经完成', code: 'TASK_ALREADY_COMPLETED' });
        if ((error as Error).message === 'TASK_CANCELLED')
          return reply.code(409).send({ error: '已取消的任务不能完成' });
        throw error;
      }
    },
  );
  app.get('/api/v1/candidates', async (request) =>
    store.listCandidates('pending', requestMarket(request)),
  );
  app.post<{ Body: CandidateInput }>(
    '/api/v1/candidates',
    { preHandler: extensionAuth(store) },
    async (request, reply) => {
      const selected = request.body.market ?? (request.query as { market?: string }).market;
      if (selected !== undefined && !MARKETS.includes(selected as Market))
        return reply.code(400).send({ error: '未知求职模块' });
      const market = normalizeMarket(
        selected ??
          store.getSetting(request.body.source === 'email' ? 'mail_market' : 'website_market'),
      );
      try {
        return candidateService.ingest({ ...request.body, market });
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );
  app.post<{
    Params: { id: string };
    Body: { jobId?: string; overrides?: Record<string, unknown> };
  }>('/api/v1/candidates/:id/confirm', async (request, reply) => {
    try {
      return candidateService.apply(
        request.params.id,
        request.body?.jobId,
        request.body?.overrides as never,
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
  app.post<{ Params: { id: string } }>('/api/v1/candidates/:id/ignore', async (request) => {
    store.setCandidateStatus(request.params.id, 'ignored');
    return { ok: true };
  });
  app.post<{ Body: { domain: string } }>(
    '/api/v1/domains/unrecognized',
    { preHandler: extensionAuth(store) },
    async (request) => {
      store.recordDomain(request.body.domain);
      return { ok: true };
    },
  );
  app.get('/api/v1/audit', async (request) => store.listAudit(50, requestMarket(request)));
  app.post<{ Params: { id: string } }>('/api/v1/audit/:id/undo', async (request, reply) =>
    store.undoAudit(request.params.id)
      ? { ok: true }
      : reply.code(409).send({ error: '该记录无法撤销或已经撤销' }),
  );
  app.get('/api/v1/status', async (request) => ({
    service: 'online',
    email: mail.status(),
    extension: {
      paired: Boolean(store.getSetting('extension_token')),
      lastSeenAt: store.getSetting('extension_last_seen') || null,
    },
    routing: {
      email: normalizeMarket(store.getSetting('mail_market')),
      website: normalizeMarket(store.getSetting('website_market')),
    },
    pendingCandidates: store.listCandidates('pending', requestMarket(request)).length,
    unrecognizedDomains: store.listDomains(),
  }));
  app.put<{ Body: { email: Market; website: Market } }>(
    '/api/v1/routing',
    async (request, reply) => {
      if (!MARKETS.includes(request.body.email) || !MARKETS.includes(request.body.website))
        return reply.code(400).send({ error: '请选择有效的求职模块' });
      if (mail.status().syncing)
        return reply.code(409).send({ error: '邮箱正在同步，请完成后再修改归属' });
      store.setSetting('mail_market', request.body.email);
      store.setSetting('website_market', request.body.website);
      return { ok: true };
    },
  );
  app.get('/api/v1/pairing', async () => {
    let token = store.getSetting('extension_token');
    if (!token) {
      token = randomBytes(24).toString('base64url');
      store.setSetting('extension_token', token);
    }
    return { token, endpoint: 'http://127.0.0.1:43110/api/v1' };
  });
  app.post<{ Body: { address: string; authorizationCode: string } }>(
    '/api/v1/email/configure',
    async (request, reply) => {
      const address = text(request.body.address).toLowerCase(),
        authorizationCode = normalizeAuthorizationCode(text(request.body.authorizationCode));
      if (!/^[^@\s]+@126\.com$/.test(address))
        return reply.code(400).send({ error: '请输入完整的 @126.com 邮箱地址' });
      if (!/^[A-Za-z0-9]{16}$/.test(authorizationCode))
        return reply.code(400).send({
          error: `授权码格式不正确：去除空格后应为 16 位字母或数字，目前识别到 ${authorizationCode.length} 位`,
        });
      await saveMailCredential(address, authorizationCode);
      try {
        await mail.test(address);
        store.setSetting('mail_address', address);
        store.setSetting('mail_last_uid', '0');
        store.setSetting('mail_last_sync_at', '');
        mail.configurationChanged();
        return { ok: true };
      } catch (error) {
        await deleteMailCredential(address).catch(() => undefined);
        const reason = safeError(error);
        request.log.warn({ reason }, '126 邮箱连接验证失败');
        return reply.code(400).send({ error: reason });
      }
    },
  );
  app.post('/api/v1/email/sync', async (_request, reply) => {
    try {
      return await mail.sync();
    } catch {
      return reply.code(502).send({ error: mail.lastError || '邮箱同步失败' });
    }
  });
  app.delete('/api/v1/email/configure', async () => {
    const address = store.getSetting('mail_address');
    if (address) await deleteMailCredential(address).catch(() => undefined);
    ['mail_address', 'mail_last_uid', 'mail_uid_validity', 'mail_last_sync_at'].forEach((key) =>
      store.db.prepare('DELETE FROM settings WHERE key=?').run(key),
    );
    mail.configurationChanged();
    return { ok: true };
  });
  app.get('/api/v1/export', async (request) => ({
    version: 4,
    market: requestMarket(request),
    exportedAt: new Date().toISOString(),
    jobs: store.listJobs(requestMarket(request)),
    productivity: {
      goals: new GoalService(store).export(requestMarket(request)),
      settings: productivitySettings(store),
      reminders: store.db
        .prepare(
          'SELECT key,job_id AS jobId,snoozed_until AS snoozedUntil,dismissed_at AS dismissedAt FROM reminder_state WHERE market=?',
        )
        .all(requestMarket(request)),
    },
  }));
  app.post<{
    Body:
      | {
          market?: Market;
          jobs?: Array<Record<string, unknown>>;
          productivity?: {
            goals?: unknown;
            settings?: Record<string, unknown>;
            reminders?: Array<Record<string, unknown>>;
          };
        }
      | Array<Record<string, unknown>>;
  }>('/api/v1/import', async (request, reply) => {
    const rows = Array.isArray(request.body) ? request.body : request.body?.jobs;
    if (!Array.isArray(rows)) return reply.code(400).send({ error: '无法识别备份文件' });
    const market = requestMarket(request);
    const backupMarket = Array.isArray(request.body) ? undefined : request.body.market;
    if (
      (backupMarket && backupMarket !== market) ||
      rows.some(
        (row) =>
          (row.market && row.market !== market) ||
          (row.id && store.getJob(text(row.id)) && store.getJob(text(row.id))!.market !== market),
      )
    ) {
      return reply.code(409).send({ error: '备份包含其他求职模块的数据，请切换到对应模块导入' });
    }
    let imported = 0;
    store.db.exec('BEGIN');
    try {
      for (const row of rows) {
        const company = text(row.company),
          position = text(row.position);
        if (!company || !position) continue;
        const existing = row.id ? store.getJob(text(row.id)) : null;
        const application =
          row.application === undefined
            ? undefined
            : parseApplication(
                row.application,
                existing?.application,
                productivitySettings(store).timezone,
              );
        if (application && typeof row.application === 'object' && row.application) {
          const source = (row.application as Record<string, unknown>).dateSource;
          if (['unknown', 'manual', 'email', 'website'].includes(String(source)))
            application.dateSource = source as never;
        }
        const job = existing
          ? store.updateJob(existing.id, {
              ...(application ? { application } : {}),
              company,
              position,
              status: validStatus(row.status),
              notes: text(row.notes),
              progressUrls: arrayOfText(row.progressUrls),
            })!
          : store.createJob({
              application,
              id: text(row.id) || undefined,
              market,
              company,
              position,
              status: validStatus(row.status),
              notes: text(row.notes),
              progressUrls: arrayOfText(row.progressUrls || (row.link ? [row.link] : [])),
            });
        const events: Array<Record<string, unknown>> = Array.isArray(row.events)
          ? (row.events as Array<Record<string, unknown>>)
          : Array.isArray(row.stages)
            ? (row.stages as Array<Record<string, unknown>>).map((stage) => ({
                title: stage.title,
                occurredAt: stage.date ? `${stage.date}T12:00:00.000Z` : undefined,
                evidence: stage.note,
                type: 'other',
              }))
            : [];
        for (const event of events)
          store.addEvent(job.id, {
            id: text(event.id) || undefined,
            type: (text(event.type) || 'other') as never,
            title: text(event.title) || '进度',
            source: (text(event.source) || 'manual') as never,
            occurredAt: text(event.occurredAt) || new Date().toISOString(),
            startsAt: nullableText(event.startsAt),
            dueAt: nullableText(event.dueAt),
            completedAt: nullableText(event.completedAt),
            confidence: Number(event.confidence ?? 1),
            evidence: text(event.evidence),
            round: text(event.round),
            outcome: (['unknown', 'passed', 'failed', 'cancelled'].includes(text(event.outcome))
              ? text(event.outcome)
              : 'unknown') as never,
            resultAt: nullableText(event.resultAt),
            dedupeKey:
              text(event.dedupeKey) ||
              `import:${job.id}:${text(event.id) || text(event.title)}:${text(event.occurredAt)}`,
          });
        const tasks = Array.isArray(row.tasks) ? (row.tasks as Array<Record<string, unknown>>) : [];
        for (const task of tasks)
          store.addTask(job.id, {
            id: text(task.id) || undefined,
            eventId: nullableText(task.eventId),
            type: (text(task.type) || 'other') as never,
            title: text(task.title) || '待处理事项',
            startsAt: nullableText(task.startsAt),
            dueAt: nullableText(task.dueAt),
            completedAt: nullableText(task.completedAt),
            cancelledAt: nullableText(task.cancelledAt),
          });
        imported++;
      }
      if (!Array.isArray(request.body) && request.body.productivity) {
        const features = request.body.productivity;
        if (features.goals) new GoalService(store).import(market, features.goals);
        const settings = features.settings;
        if (settings && typeof settings.timezone === 'string' && validTimezone(settings.timezone)) {
          const current = productivitySettings(store);
          const quiet = {
            quietStart:
              Number.isInteger(settings.quietStart) &&
              Number(settings.quietStart) >= 0 &&
              Number(settings.quietStart) <= 23
                ? settings.quietStart
                : current.quietStart,
            quietEnd:
              Number.isInteger(settings.quietEnd) &&
              Number(settings.quietEnd) >= 0 &&
              Number(settings.quietEnd) <= 23
                ? settings.quietEnd
                : current.quietEnd,
          };
          const raw = settings.staleDays as Record<string, number> | undefined;
          const staleDays =
            raw &&
            ['application', 'assessment', 'interview'].every(
              (key) => Number.isInteger(raw[key]) && raw[key] >= 1 && raw[key] <= 365,
            )
              ? {
                  application: raw.application,
                  assessment: raw.assessment,
                  interview: raw.interview,
                }
              : current.staleDays;
          store.setSetting(
            'productivity_settings',
            JSON.stringify({ ...current, ...quiet, timezone: settings.timezone, staleDays }),
          );
        }
        for (const state of features.reminders || []) {
          const job = store.getJob(text(state.jobId));
          if (!job || job.market !== market || !text(state.key) || text(state.key).length > 600)
            throw new Error('提醒备份不正确');
          const snooze = parseDate(state.snoozedUntil),
            dismissed = parseDate(state.dismissedAt);
          store.db
            .prepare(
              'INSERT INTO reminder_state(key,market,job_id,snoozed_until,dismissed_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET snoozed_until=excluded.snoozed_until,dismissed_at=excluded.dismissed_at',
            )
            .run(text(state.key), market, job.id, snooze, dismissed, new Date().toISOString());
        }
      }
      store.db.exec('COMMIT');
      return { ok: true, imported };
    } catch {
      store.db.exec('ROLLBACK');
      return reply.code(409).send({ error: '备份中的进度或待办记录存在冲突，未导入任何数据' });
    }
  });
}

function requestMarket(request: FastifyRequest) {
  return normalizeMarket((request.query as { market?: string }).market);
}

function extensionAuth(store: Store) {
  return async (
    request: FastifyRequest,
    reply: { code: (n: number) => { send: (v: unknown) => unknown } },
  ) => {
    const expected = store.getSetting('extension_token');
    if (!expected || request.headers['x-campus-token'] !== expected)
      return reply.code(401).send({ error: '扩展尚未配对或令牌无效' });
    store.setSetting('extension_last_seen', new Date().toISOString());
  };
}
function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}
function nullableText(value: unknown) {
  const valueText = text(value);
  return valueText || null;
}
function arrayOfText(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
function validStatus(value: unknown): JobStatus {
  return JOB_STATUSES.includes(value as JobStatus) ? (value as JobStatus) : '已投递';
}
