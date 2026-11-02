import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from './db.js';
import {
  EMPTY_APPLICATION,
  EVENT_TYPES,
  normalizeMarket,
  type ApplicationMeta,
  type Job,
  type JobEvent,
  type JobTask,
  type Market,
  type StageOutcome,
} from '../shared/types.js';
import {
  STAGE_TYPES,
  type ProductivitySettings,
  type GoalRules,
  type CurrentGoalTargetsInput,
} from '../shared/productivity.js';
import { dayInZone, isDay, isInstant, validTimezone, weekStart } from '../shared/time.js';
import { GoalService } from './goals.js';
import { calculateAnalytics } from './analytics.js';
import { calendarActions, exportCalendar } from './actions.js';
import { nativeNotification, productivitySettings, ReminderService } from './reminders.js';

export function invalid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}
const short = (value: unknown, max = 100) => {
  if (typeof value !== 'string' || value.length > max) invalid(`文本应在 ${max} 字以内`);
  return value.trim();
};
export function parseApplication(
  value: unknown,
  previous?: ApplicationMeta,
  timezone = 'America/Chicago',
): ApplicationMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('投递信息格式不正确');
  const input = value as Record<string, unknown>,
    result = { ...EMPTY_APPLICATION, ...previous };
  for (const key of ['direction', 'channel', 'resumeVersion'] as const)
    if (key in input) result[key] = short(input[key]);
  for (const key of ['archived', 'excluded', 'followupPaused'] as const)
    if (key in input) {
      if (typeof input[key] !== 'boolean') invalid('开关格式不正确');
      result[key] = input[key];
    }
  if ('appliedOn' in input) {
    if (input.appliedOn !== null && !isDay(input.appliedOn)) invalid('实际投递日期不正确');
    result.appliedOn = input.appliedOn as string | null;
  }
  if ('appliedAt' in input) {
    if (input.appliedAt !== null && !isInstant(input.appliedAt)) invalid('实际投递时间应包含时区');
    result.appliedAt = input.appliedAt as string | null;
  }
  if ('appliedOn' in input || 'appliedAt' in input) result.dateSource = 'manual';
  if (
    (result.appliedAt && Date.parse(result.appliedAt) > Date.now()) ||
    (result.appliedOn && result.appliedOn > dayInZone(new Date(), timezone))
  )
    invalid('实际投递日期不能在未来');
  return result;
}
export function parseDate(value: unknown, allowNull = true): string | null {
  if ((value === null || value === undefined || value === '') && allowNull) return null;
  if (!isDay(value) && !isInstant(value)) invalid('日期应是 YYYY-MM-DD 或带时区的准确时间');
  return value as string;
}
function checkSchedule(start: string | null, end: string | null, timezone: string) {
  if (!start || !end) return;
  if (
    isInstant(start) && isInstant(end)
      ? Date.parse(start) > Date.parse(end)
      : dayInZone(start, timezone) > dayInZone(end, timezone)
  )
    invalid('结束／截止不能早于开始');
}
const target = (value: unknown): number | null => {
  if (value === null) return null;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 10000)
    invalid('目标须为 0–10000 的整数，未设置请留空');
  return Number(value);
};
function range(request: FastifyRequest, timezone: string) {
  const query = request.query as Record<string, string>,
    from = query.from || undefined,
    to = query.to || dayInZone(new Date(), timezone);
  if ((from && !isDay(from)) || !isDay(to) || (from && from > to)) invalid('投递日期范围不正确');
  return {
    from,
    to,
    groupBy: query.groupBy,
    direction: query.direction,
    channel: query.channel,
    resumeVersion: query.resumeVersion,
  };
}
export function registerProductivityApi(
  app: FastifyInstance,
  store: Store,
  reminders: ReminderService,
) {
  const goals = new GoalService(store),
    market = (request: FastifyRequest) =>
      normalizeMarket((request.query as { market?: string }).market);
  app.get('/api/v1/productivity/settings', async () => ({
    settings: productivitySettings(store),
    desktopSupported: process.platform === 'darwin',
    desktopError: store.getSetting('desktop_notification_error') || null,
  }));
  app.put<{ Body: ProductivitySettings }>('/api/v1/productivity/settings', async (request) => {
    const body = request.body;
    if (!body || typeof body.timezone !== 'string' || !validTimezone(body.timezone))
      invalid('请选择有效的 IANA 时区');
    if (typeof body.desktopEnabled !== 'boolean') invalid('通知设置不正确');
    for (const value of Object.values(body.staleDays || {}))
      if (!Number.isInteger(value) || value < 1 || value > 365) invalid('跟进阈值须为 1–365 天');
    if (
      !body.staleDays ||
      ['application', 'assessment', 'interview'].some((key) => !(key in body.staleDays))
    )
      invalid('请填写三个跟进阈值');
    for (const value of [body.quietStart, body.quietEnd])
      if (!Number.isInteger(value) || value < 0 || value > 23) invalid('免打扰时间须为 0–23 点');
    const settings: ProductivitySettings = {
      timezone: body.timezone,
      desktopEnabled: body.desktopEnabled,
      staleDays: {
        application: body.staleDays.application,
        assessment: body.staleDays.assessment,
        interview: body.staleDays.interview,
      },
      quietStart: body.quietStart,
      quietEnd: body.quietEnd,
    };
    store.setSetting('productivity_settings', JSON.stringify(settings));
    return { settings };
  });
  app.post('/api/v1/reminders/test-desktop', async (_request, reply) => {
    try {
      await nativeNotification(
        '校招进度助手',
        '这是一条测试通知。请在 macOS 通知设置中允许对应应用的通知。',
      );
      return { ok: true, message: '已提交系统，请检查实际显示与通知权限' };
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
  app.get('/api/v1/analytics', async (request) => {
    const settings = productivitySettings(store);
    return calculateAnalytics(store.listJobs(market(request)), {
      timezone: settings.timezone,
      ...range(request, settings.timezone),
    });
  });
  app.get('/api/v1/goals', async () => goals.summary(productivitySettings(store).timezone));
  app.put<{ Body: CurrentGoalTargetsInput }>(
    '/api/v1/goals/current-targets',
    async (request, reply) => {
      const input = request.body;
      if (
        !input ||
        !isDay(input.date) ||
        !isDay(input.weekStart) ||
        typeof input.timezone !== 'string'
      )
        invalid('请提供当前目标的日期、周起点与统计时区');
      if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes))
        invalid('目标修改格式不正确');
      const keys = Object.keys(input.changes);
      if (!keys.length || keys.some((key) => !['day', 'week'].includes(key)))
        invalid('请修改今日或本周目标');
      const timezone = productivitySettings(store).timezone,
        now = new Date().toISOString(),
        today = dayInZone(now, timezone),
        week = weekStart(today);
      if (input.date !== today || input.weekStart !== week || input.timezone !== timezone)
        return reply.code(409).send({
          error: '日期、周次或统计时区已变化，请刷新目标设置后重试',
          code: 'GOAL_PERIOD_CHANGED',
        });
      const updates = keys.map((key) => ({
        kind: key as 'day' | 'week',
        value: target(input.changes[key as 'day' | 'week']),
      }));
      return store.transaction(() => {
        for (const update of updates)
          goals.override(
            market(request),
            update.kind,
            update.kind === 'day' ? today : week,
            update.value,
          );
        return goals.summary(timezone, now);
      });
    },
  );
  app.put<{ Body: GoalRules }>('/api/v1/goals', async (request) => {
    const input = request.body;
    if (!input || !Array.isArray(input.weekdays) || input.weekdays.length !== 7)
      invalid('请填写周一至周日的目标');
    const rules = {
      weekdays: input.weekdays.map(target),
      weeklyTarget: target(input.weeklyTarget),
    };
    goals.saveRules(
      market(request),
      rules,
      dayInZone(new Date(), productivitySettings(store).timezone),
    );
    return { ok: true };
  });
  app.put<{ Body: { kind: 'day' | 'week'; date: string; target: number | null } }>(
    '/api/v1/goals/override',
    async (request) => {
      const input = request.body;
      if (!input || !['day', 'week'].includes(input.kind) || !isDay(input.date))
        invalid('目标覆盖日期不正确');
      goals.override(market(request), input.kind, input.date, target(input.target));
      return { ok: true };
    },
  );
  app.put<{ Body: { ids: string[]; application: Partial<ApplicationMeta> } }>(
    '/api/v1/applications/batch',
    async (request) => {
      const input = request.body;
      if (!input || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 200)
        invalid('每次请选择 1–200 条申请');
      const jobs = input.ids.map((id) => store.getJob(id));
      if (jobs.some((job) => !job || job.market !== market(request)))
        invalid('存在不属于当前模块的申请');
      const updates = jobs.map((job) => ({
        job: job!,
        application: parseApplication(
          input.application,
          job!.application,
          productivitySettings(store).timezone,
        ),
      }));
      store.transaction(() => {
        for (const update of updates)
          store.updateJob(update.job.id, { application: update.application });
      });
      return { ok: true, updated: updates.length };
    },
  );
  app.get('/api/v1/actions', async (request) => {
    const settings = productivitySettings(store);
    return {
      asOf: new Date().toISOString(),
      timezone: settings.timezone,
      items: calendarActions(store.listJobs(market(request)), settings.timezone),
    };
  });
  app.get('/api/v1/calendar.ics', async (request, reply) => {
    const settings = productivitySettings(store),
      items = calendarActions(store.listJobs(market(request)), settings.timezone);
    return reply
      .header('content-type', 'text/calendar; charset=utf-8')
      .header('content-disposition', 'attachment; filename="campus-calendar.ics"')
      .send(exportCalendar(items, settings.timezone));
  });
  app.get('/api/v1/reminders', async (request) => ({
    items: reminders.list(market(request)),
    asOf: new Date().toISOString(),
  }));
  app.post<{ Body: { key: string; action: 'dismiss' | 'snooze' | 'followed_up'; days?: number } }>(
    '/api/v1/reminders/action',
    async (request) => {
      const input = request.body;
      if (
        !input ||
        !['dismiss', 'snooze', 'followed_up'].includes(input.action) ||
        typeof input.key !== 'string'
      )
        invalid('提醒操作不正确');
      const days = input.days ?? 3;
      if (!Number.isInteger(days) || days < 1 || days > 365) invalid('稍后提醒天数不正确');
      try {
        reminders.act(market(request), input.key, input.action, days);
      } catch (error) {
        invalid((error as Error).message);
      }
      return { ok: true };
    },
  );
  app.put<{ Params: { id: string }; Body: Partial<JobEvent> }>(
    '/api/v1/events/:id',
    async (request, reply) => {
      const input = request.body;
      if (!input || !['unknown', 'passed', 'failed', 'cancelled'].includes(input.outcome || ''))
        invalid('请选择明确结果或未知');
      const previous = store
        .listJobs(market(request))
        .flatMap((job) => job.events)
        .find((event) => event.id === request.params.id);
      const round = short(input.round || '', 40),
        resultAt =
          input.outcome === 'unknown'
            ? null
            : parseDate(
                input.resultAt ||
                  (previous?.outcome === input.outcome ? previous?.resultAt : null) ||
                  new Date().toISOString(),
              );
      return (
        store.updateEvent(request.params.id, {
          round,
          outcome: input.outcome as StageOutcome,
          resultAt,
        }) || reply.code(404).send({ error: '进度不存在' })
      );
    },
  );
  app.put<{ Params: { id: string }; Body: Partial<JobTask> }>(
    '/api/v1/tasks/:id',
    async (request, reply) => {
      const input = request.body;
      if (!input) invalid('任务信息不正确');
      const patch: Partial<JobTask> = {};
      if ('title' in input) patch.title = short(input.title, 200);
      if ('startsAt' in input) patch.startsAt = parseDate(input.startsAt);
      if ('dueAt' in input) patch.dueAt = parseDate(input.dueAt);
      if ('cancelledAt' in input) patch.cancelledAt = parseDate(input.cancelledAt);
      const job = store
        .listJobs(market(request))
        .find((job) => job.tasks.some((task) => task.id === request.params.id));
      const old = job?.tasks.find((task) => task.id === request.params.id);
      if (!old) return reply.code(404).send({ error: '任务不存在' });
      const merged = { ...old, ...patch };
      checkSchedule(merged.startsAt, merged.dueAt, productivitySettings(store).timezone);
      return store.updateTask(request.params.id, patch);
    },
  );
}

export function manualStage(store: Store, job: Job, input: Record<string, unknown>) {
  if (!EVENT_TYPES.includes(input.type as never)) invalid('未知进度类型');
  const type = input.type as JobEvent['type'],
    occurredAt = parseDate(input.occurredAt || new Date().toISOString(), false)!;
  const startsAt = parseDate(input.startsAt),
    dueAt = parseDate(input.dueAt);
  checkSchedule(startsAt, dueAt, productivitySettings(store).timezone);
  return store.transaction(() => {
    const event = store.addEvent(job.id, {
      type,
      title: typeof input.title === 'string' ? input.title.slice(0, 200) : '进度更新',
      source: 'manual',
      occurredAt,
      startsAt,
      dueAt,
      round: typeof input.round === 'string' ? input.round.slice(0, 40) : '',
      confidence: 1,
      evidence: typeof input.evidence === 'string' ? input.evidence.slice(0, 2000) : '',
    })!;
    if ((STAGE_TYPES as readonly string[]).includes(type) || type === 'other')
      store.addTask(job.id, {
        eventId: event.id,
        type: type as JobTask['type'],
        title: event.title,
        startsAt,
        dueAt,
      });
    const statuses: Partial<Record<JobEvent['type'], Job['status']>> = {
      application: '已投递',
      assessment: '测评中',
      ai_assessment: 'AI测评中',
      written_test: '笔试中',
      interview: '面试中',
      ai_interview: 'AI面试中',
      offer: '已offer',
      rejection: '已拒绝',
      ended: '流程结束',
    };
    if (statuses[type]) store.updateJob(job.id, { status: statuses[type] });
    return event;
  });
}

export function recordManualStatus(store: Store, before: Job | null, job: Job) {
  if (before?.status === job.status) return;
  const types: Partial<Record<Job['status'], JobEvent['type']>> = {
    测评中: 'assessment',
    AI测评中: 'ai_assessment',
    笔试中: 'written_test',
    面试中: 'interview',
    AI面试中: 'ai_interview',
    已offer: 'offer',
    已拒绝: 'rejection',
    流程结束: 'ended',
  };
  const type = types[job.status];
  if (!type) return;
  const event = store.addEvent(job.id, {
    type,
    title: `手动记录：${job.status}`,
    source: 'manual',
    occurredAt: new Date().toISOString(),
    evidence: '用户明确修改了当前招聘状态',
    confidence: 1,
  })!;
  if ((STAGE_TYPES as readonly string[]).includes(type))
    store.addTask(job.id, { eventId: event.id, type: type as JobTask['type'], title: event.title });
}
