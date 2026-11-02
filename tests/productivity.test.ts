import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/db.js';
import { GoalService } from '../src/server/goals.js';
import { calculateAnalytics } from '../src/server/analytics.js';
import { ReminderService } from '../src/server/reminders.js';
import { calendarActions, exportCalendar } from '../src/server/actions.js';
import { CandidateService } from '../src/server/candidates.js';
import { EMPTY_APPLICATION, type Job, type JobEvent } from '../src/shared/types.js';
import { DEFAULT_PRODUCTIVITY_SETTINGS } from '../src/shared/productivity.js';
import {
  addDays,
  dayInZone,
  daysBetween,
  weekStart,
  zonedToIso,
  isDay,
  isInstant,
} from '../src/shared/time.js';

let dir: string, store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'campus-productivity-'));
  store = new Store(join(dir, 'db.sqlite'));
  store.db.exec('DELETE FROM audit_log; DELETE FROM candidates; DELETE FROM jobs;');
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const create = (patch: Partial<Job> = {}) =>
  store.createJob({
    company: '示例公司',
    position: '数据分析',
    status: '已投递',
    application: { ...EMPTY_APPLICATION, appliedAt: '2026-10-19T16:00:00Z', dateSource: 'manual' },
    ...patch,
  });
const event = (job: Job, patch: Partial<JobEvent> = {}) =>
  store.addEvent(job.id, {
    type: 'assessment',
    title: '测评通知',
    source: 'email',
    occurredAt: '2026-10-20T16:00:00Z',
    ...patch,
  })!;
const asOf = '2026-10-31T17:00:00Z';
const analytics = (from?: string) =>
  calculateAnalytics(store.listJobs(), { timezone: 'America/Chicago', asOf, from });

describe('日期与统计时区', () => {
  it('按 Chicago 午夜归日，夏令时两侧的同一天正确，周一和跨年周正确', () => {
    expect(dayInZone('2026-11-01T04:59:00Z')).toBe('2026-10-31');
    expect(dayInZone('2026-11-01T05:01:00Z')).toBe('2026-11-01');
    expect(dayInZone('2026-11-01T06:30:00Z')).toBe('2026-11-01');
    expect(dayInZone('2026-11-01T07:30:00Z')).toBe('2026-11-01');
    expect(weekStart('2027-01-01')).toBe('2026-12-28');
    expect(weekStart('2026-11-02')).toBe('2026-11-02');
    expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);
  });
  it('本地准确时间转换按设置时区，夏令时缺失时间拒绝，不接受无效日期', () => {
    expect(zonedToIso('2026-10-31T09:00')).toBe('2026-10-31T14:00:00.000Z');
    expect(zonedToIso('2026-11-02T09:00')).toBe('2026-11-02T15:00:00.000Z');
    expect(zonedToIso('2026-03-08T02:30')).toBeNull();
    expect(zonedToIso('2026-10-31T09:00', 'Asia/Shanghai')).toBe('2026-10-31T01:00:00.000Z');
    expect(isDay('2026-02-30')).toBe(false);
    expect(isInstant('2026-02-30T10:00:00Z')).toBe(false);
    expect(isInstant('2026-10-31T24:00:00Z')).toBe(false);
  });
});

describe('投递目标与数量', () => {
  it('真实日期计数，建档时间和重复邮件不增加今天数量，归档和拒绝保留历史', () => {
    const job = create();
    const unknown = create({ application: { ...EMPTY_APPLICATION } });
    store.updateJob(job.id, {
      status: '已拒绝',
      application: { ...job.application!, archived: true },
    });
    const service = new CandidateService(store);
    const input = {
      source: 'website' as const,
      market: 'cn' as const,
      sourceRef: 'web:dated',
      company: '另一公司',
      position: '数据分析',
      eventType: 'application' as const,
      confidence: 0.99,
      application: { appliedAt: '2026-10-30T16:00:00Z' },
    };
    service.ingest(input);
    service.ingest(input);
    const goals = new GoalService(store).summary('America/Chicago', asOf),
      cn = goals.modules[0];
    expect(cn.day.actual).toBe(0);
    expect(cn.week.actual).toBe(1);
    expect(cn.days.find((day) => day.date === '2026-10-19')?.actual).toBe(1);
    expect(cn.days.find((day) => day.date === '2026-10-30')?.actual).toBe(1);
    expect(cn.missingDateIds).toEqual([unknown.id]);
    store.updateJob(job.id, { application: { ...job.application!, excluded: true } });
    expect(
      new GoalService(store)
        .summary('America/Chicago', asOf)
        .modules[0].days.find((day) => day.date === '2026-10-19')?.actual,
    ).toBe(0);
  });
  it('两模块分别设置与达标，一个模块超额不抵消另一个模块缺口', () => {
    const service = new GoalService(store),
      rules = { weekdays: [5, 5, 5, 5, 5, 5, 0], weeklyTarget: 20 };
    service.saveRules('cn', rules, '2026-10-26');
    service.saveRules('us', rules, '2026-10-26');
    for (let i = 0; i < 8; i++)
      create({ application: { ...EMPTY_APPLICATION, appliedOn: '2026-10-31' } });
    for (let i = 0; i < 2; i++)
      create({ market: 'us', application: { ...EMPTY_APPLICATION, appliedOn: '2026-10-31' } });
    const summary = service.summary('America/Chicago', asOf);
    expect(summary.total.day).toMatchObject({ actual: 10, target: 10, remaining: 3 });
    expect(summary.modules[0].day.remaining).toBe(0);
    expect(summary.modules[1].day.remaining).toBe(3);
    expect(summary.modules[0].week.target).toBe(20);
  });
  it('修改默认值不覆盖已结束日期与周，允许显式覆盖；0 和未设目标分开', () => {
    const service = new GoalService(store);
    service.saveRules('cn', { weekdays: [2, 2, 2, 2, 2, 0, null], weeklyTarget: 10 }, '2026-10-19');
    service.saveRules('cn', { weekdays: [6, 6, 6, 6, 6, 6, 6], weeklyTarget: 25 }, '2026-10-31');
    expect(service.target('cn', 'day', '2026-10-23')).toBe(2);
    expect(service.target('cn', 'day', '2026-10-24')).toBe(0);
    expect(service.target('cn', 'day', '2026-10-25')).toBeNull();
    expect(service.target('cn', 'week', '2026-10-19')).toBe(10);
    expect(service.target('cn', 'week', '2026-10-26')).toBe(25);
    service.override('cn', 'day', '2026-10-23', 4);
    expect(service.target('cn', 'day', '2026-10-23')).toBe(4);
    expect(service.target('us', 'day', '2026-10-23')).toBeNull();
  });
  it('计划中申请和已作废申请不计数，午夜归属服从统计时区', () => {
    create({ status: '待投递' });
    create({ application: { ...EMPTY_APPLICATION, appliedAt: '2026-10-31T04:00:00Z' } });
    create({ application: { ...EMPTY_APPLICATION, appliedOn: '2026-10-31', excluded: true } });
    const service = new GoalService(store);
    expect(service.summary('America/Chicago', asOf).modules[0].day.actual).toBe(0);
    expect(service.summary('Asia/Shanghai', '2026-10-31T14:00:00Z').modules[0].day.actual).toBe(1);
  });
});

describe('招聘漏斗与对比', () => {
  it('投递回执不是反馈，旧申请本周 Offer 不混进本周新投组', () => {
    const old = create();
    event(old, { type: 'offer', title: 'Offer 通知', occurredAt: '2026-10-30T16:00:00Z' });
    const fresh = create({
      application: { ...EMPTY_APPLICATION, appliedAt: '2026-10-28T16:00:00Z' },
    });
    event(fresh, { type: 'application', title: '已收到投递' });
    const result = analytics('2026-10-26');
    expect(result.cohortIds).toEqual([fresh.id]);
    expect(result.metrics.find((item) => item.key === 'feedback')).toMatchObject({
      numerator: 0,
      denominator: 1,
      rate: 0,
    });
    expect(result.metrics.find((item) => item.key === 'offer')?.numerator).toBe(0);
    expect(analytics().metrics.find((item) => item.key === 'offer')?.numerator).toBe(1);
  });
  it('完成不等于通过，AI 面试和真人面试分开，明确失败只统计所属阶段', () => {
    const job = create(),
      assessment = event(job);
    const task = store.addTask(job.id, {
      eventId: assessment.id,
      type: 'assessment',
      title: '测评',
    });
    store.completeTask(task.id, '2026-10-21T16:00:00Z');
    event(job, { type: 'ai_interview', title: 'AI 面试', occurredAt: '2026-10-22T16:00:00Z' });
    event(job, { type: 'rejection', title: '很遗憾', occurredAt: '2026-10-24T16:00:00Z' });
    let result = analytics();
    expect(result.stages.find((item) => item.type === 'assessment')).toMatchObject({
      completed: 1,
      passed: 0,
      failed: 0,
      passRate: null,
      coverage: 0,
    });
    expect(result.metrics.find((item) => item.key === 'ai_interview')?.numerator).toBe(1);
    expect(result.metrics.find((item) => item.key === 'interview')?.numerator).toBe(0);
    store.updateEvent(assessment.id, { outcome: 'passed', resultAt: '2026-10-22T12:00:00Z' });
    result = analytics();
    expect(result.stages.find((item) => item.type === 'assessment')).toMatchObject({
      passed: 1,
      failed: 0,
      passRate: 1,
      coverage: 1,
    });
  });
  it('同阶段相同安排与提醒不重复计数，明确不同轮次分别计算', () => {
    const job = create();
    event(job, { startsAt: '2026-10-21T16:00:00Z' });
    event(job, { startsAt: '2026-10-21T16:00:00Z', title: '补充测评通知' });
    event(job, { title: '测评提醒', occurredAt: '2026-10-22T16:00:00Z' });
    event(job, { type: 'interview', round: '第一轮' });
    event(job, { type: 'interview', round: '第二轮' });
    expect(analytics().stages.find((item) => item.type === 'assessment')?.reached).toBe(1);
    expect(analytics().stages.filter((item) => item.type === 'interview')).toHaveLength(2);
    expect(analytics().metrics.find((item) => item.key === 'interview')?.numerator).toBe(1);
  });
  it('日期未知只在全部时间中保留；分母为空显示暂无数据', () => {
    const job = create({ application: { ...EMPTY_APPLICATION } });
    event(job);
    expect(analytics().missingDateIds).toEqual([job.id]);
    expect(analytics().cohortIds).toEqual([job.id]);
    expect(analytics('2026-10-01').cohortIds).toHaveLength(0);
    expect(analytics('2026-10-01').metrics[0].rate).toBeNull();
    expect(analytics().medians.feedbackHours).toBeNull();
  });
  it('按真实渠道和简历标签分组，不把采集来源当渠道；少量样本标记', () => {
    const job = create({
      source: 'email',
      application: {
        ...EMPTY_APPLICATION,
        appliedAt: '2026-10-19T16:00:00Z',
        channel: '内推',
        direction: '数据',
        resumeVersion: '数据-v2',
      },
    });
    event(job, { type: 'interview' });
    const result = calculateAnalytics(store.listJobs(), {
      timezone: 'America/Chicago',
      asOf,
      groupBy: 'channel',
    });
    expect(result.groups[0]).toMatchObject({
      name: '内推',
      count: 1,
      sampleSmall: true,
      interview: { numerator: 1, denominator: 1 },
    });
    expect(result.medians.feedbackHours).toBe(24);
  });
  it('取消的阶段与任务不计入有效阶段，网页发现时间不当作反馈准确时刻', () => {
    const job = create(),
      stage = event(job, { source: 'website' });
    const task = store.addTask(job.id, { eventId: stage.id, type: 'assessment', title: '测评' });
    expect(analytics().medians.feedbackHours).toBeNull();
    store.updateTask(task.id, { cancelledAt: '2026-10-21T16:00:00Z' });
    expect(analytics().stages).toHaveLength(0);
  });
});

describe('行动、日历和长期无进展提醒', () => {
  it('编辑与同步不重置等待，新进展使旧提醒失效，暂停可恢复', () => {
    const job = create(),
      service = new ReminderService(store);
    const initial = service.list('cn', asOf);
    expect(initial).toHaveLength(1);
    expect(initial[0].kind).toBe('stale');
    store.updateJob(job.id, { notes: '改备注', lastSyncedAt: asOf });
    expect(service.list('cn', asOf)[0].key).toBe(initial[0].key);
    event(job, { occurredAt: '2026-10-30T16:00:00Z' });
    expect(service.list('cn', asOf)).toHaveLength(0);
    store.updateJob(job.id, { application: { ...job.application!, followupPaused: true } });
    expect(service.list('cn', '2026-11-20T17:00:00Z')).toHaveLength(0);
  });
  it('稍后提醒、已跟进与忽略持久化，不改企业进展；新锚点可产生新提醒', () => {
    const job = create(),
      service = new ReminderService(store),
      initial = service.list('cn', asOf)[0];
    service.act('cn', initial.key, 'followed_up', 7, asOf);
    expect(service.list('cn', asOf)).toHaveLength(0);
    expect(store.getJob(job.id)?.events).toHaveLength(0);
    expect(service.list('cn', '2026-11-08T17:00:00Z')).toHaveLength(1);
    service.act('cn', initial.key, 'dismiss', 3, '2026-11-08T17:00:00Z');
    expect(service.list('cn', '2026-11-09T17:00:00Z')).toHaveLength(0);
    event(job, { occurredAt: '2026-11-10T17:00:00Z' });
    expect(service.list('cn', '2026-11-20T17:00:00Z')).toHaveLength(1);
  });
  it('完成、取消、改期与明确结果使旧待办提醒失效', () => {
    const job = create(),
      stage = event(job),
      task = store.addTask(job.id, {
        eventId: stage.id,
        type: 'assessment',
        title: '测评',
        dueAt: '2026-10-31T18:00:00Z',
      }),
      service = new ReminderService(store);
    expect(service.list('cn', asOf)).toMatchObject([{ kind: 'deadline' }]);
    store.updateTask(task.id, { dueAt: '2026-11-03T18:00:00Z' });
    expect(service.list('cn', asOf)).toHaveLength(0);
    store.updateEvent(stage.id, { outcome: 'passed', resultAt: asOf });
    expect(calendarActions(store.listJobs(), 'America/Chicago', asOf)[0].resolvedAt).toBe(asOf);
    expect(service.list('cn', asOf)).toHaveLength(0);
    expect(store.getJob(job.id)?.tasks[0].completedAt).toBeNull();
  });
  it('电脑通知持久去重，恢复后只发送当前阶段，不重放所有提前提醒', async () => {
    const job = create();
    store.addTask(job.id, { type: 'interview', title: '面试', dueAt: '2026-10-30T16:00:00Z' });
    store.setSetting(
      'productivity_settings',
      JSON.stringify({
        ...DEFAULT_PRODUCTIVITY_SETTINGS,
        desktopEnabled: true,
        quietStart: 0,
        quietEnd: 0,
      }),
    );
    const notify = vi.fn(async () => {}),
      service = new ReminderService(store, notify);
    await service.tick(asOf);
    await service.tick(asOf);
    expect(notify).toHaveBeenCalledTimes(1);
    const serviceAfterRestart = new ReminderService(store, notify);
    await serviceAfterRestart.tick(asOf);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(service.list('cn', asOf)).toHaveLength(1);
  });
  it('免打扰时不发外部通知，发送失败保留待发送状态并允许重试', async () => {
    create();
    store.setSetting(
      'productivity_settings',
      JSON.stringify({ ...DEFAULT_PRODUCTIVITY_SETTINGS, desktopEnabled: true }),
    );
    const notify = vi.fn(async () => {
        throw new Error('权限未开启');
      }),
      service = new ReminderService(store, notify);
    await service.tick('2026-11-01T03:00:00Z');
    expect(notify).not.toHaveBeenCalled();
    await service.tick(asOf);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(store.getSetting('desktop_notification_error')).toBe('权限未开启');
    expect(service.list('cn', asOf)[0].desktopSentAt).toBeNull();
  });
  it('只对准确的面试时段检测冲突，全天事项导出不捏造时间，ICS 正确转义', () => {
    const a = create(),
      b = create();
    store.addTask(a.id, {
      type: 'interview',
      title: '面试,问题;A\nB',
      startsAt: '2026-10-31T16:00:00Z',
      dueAt: '2026-10-31T17:00:00Z',
    });
    store.addTask(b.id, {
      type: 'interview',
      title: '第二场',
      startsAt: '2026-10-31T16:30:00Z',
      dueAt: '2026-10-31T17:30:00Z',
    });
    store.addTask(b.id, { type: 'written_test', title: '笔试', dueAt: '2026-11-02' });
    const actions = calendarActions(store.listJobs(), 'America/Chicago', asOf),
      ics = exportCalendar(actions, 'America/Chicago', asOf);
    expect(actions.filter((item) => item.conflict)).toHaveLength(2);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261102');
    expect(ics).toContain('DTEND;VALUE=DATE:20261103');
    expect(ics).toContain('DTSTART:20261031T160000Z');
    expect(ics).toContain('面试\\,问题\\;A\\nB');
  });
  it('纯个人待办完成不改变招聘状态，招聘任务完成撤销恢复原状态与时间', () => {
    const job = create({ status: '面试中' }),
      personal = store.addTask(job.id, { type: 'other', title: '看 JD' });
    store.completeTask(personal.id, '2026-10-21T16:00:00Z');
    expect(store.getJob(job.id)?.status).toBe('面试中');
    const stage = event(job, { type: 'interview' }),
      task = store.addTask(job.id, { eventId: stage.id, type: 'interview', title: '面试' });
    store.completeTask(task.id, '2026-10-22T16:00:00Z');
    expect(store.getJob(job.id)?.status).toBe('等待结果');
    const audit = store
      .listAudit()
      .find((row) => row.action === 'complete' && row.entityId === task.id)!;
    store.undoAudit(String(audit.id));
    expect(store.getJob(job.id)?.status).toBe('面试中');
    expect(store.getJob(job.id)?.tasks.find((item) => item.id === task.id)?.completedAt).toBeNull();
  });
  it('升级与删除撤销保留元数据、阶段结果和待办，不从收件时间编造投递日期', () => {
    const job = create({
        application: { ...EMPTY_APPLICATION, appliedOn: '2026-10-19', resumeVersion: '英文-v1' },
      }),
      stage = event(job, { outcome: 'passed', round: '第一轮', resultAt: asOf });
    store.addTask(job.id, {
      eventId: stage.id,
      type: 'assessment',
      title: '测评',
      completedAt: asOf,
    });
    store.deleteJob(job.id);
    const audit = store.listAudit().find((row) => row.action === 'delete')!;
    store.undoAudit(String(audit.id));
    expect(store.getJob(job.id)).toMatchObject({
      application: { appliedOn: '2026-10-19', resumeVersion: '英文-v1' },
      events: [{ outcome: 'passed', round: '第一轮' }],
      tasks: [{ completedAt: asOf }],
    });
    const unknown = create({ application: { ...EMPTY_APPLICATION } });
    event(unknown, { type: 'application' });
    expect(store.getJob(unknown.id)?.application?.appliedAt).toBeNull();
    const second = new Store(join(dir, 'db.sqlite'));
    expect(second.getJob(job.id)?.application?.resumeVersion).toBe('英文-v1');
    second.close();
  });
});
