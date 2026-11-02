import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/db.js';
import { createServer } from '../src/server/app.js';
import { EMPTY_APPLICATION, type Job } from '../src/shared/types.js';
import { GoalService } from '../src/server/goals.js';
import { dayInZone } from '../src/shared/time.js';
import { DEFAULT_PRODUCTIVITY_SETTINGS } from '../src/shared/productivity.js';
let dir: string, store: Store, server: Awaited<ReturnType<typeof createServer>>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'campus-productivity-api-'));
  store = new Store(join(dir, 'db.sqlite'));
  store.db.exec('DELETE FROM audit_log; DELETE FROM candidates; DELETE FROM jobs;');
  server = await createServer({ store, startMail: false });
});
afterEach(async () => {
  await server.app.close();
  rmSync(dir, { recursive: true, force: true });
});
const create = (
  market = 'cn',
  application: unknown = { ...EMPTY_APPLICATION, appliedOn: dayInZone(new Date()) },
) =>
  server.app.inject({
    method: 'POST',
    url: `/api/v1/jobs?market=${market}`,
    payload: { company: '示例公司', position: '数据分析', status: '已投递', application },
  });

describe('桌面生产力接口', () => {
  it('申请信息保存和批量修改按模块隔离，未知字段不污染元数据', async () => {
    const cn = (await create()).json<Job>(),
      us = (await create('us')).json<Job>();
    const rejected = await server.app.inject({
      method: 'PUT',
      url: '/api/v1/applications/batch',
      payload: { ids: [cn.id, us.id], application: { channel: '内推' } },
    });
    expect(rejected.statusCode).toBe(400);
    expect(store.getJob(cn.id)?.application?.channel).toBe('');
    const accepted = await server.app.inject({
      method: 'PUT',
      url: '/api/v1/applications/batch?market=us',
      payload: {
        ids: [us.id],
        application: { direction: '数据', resumeVersion: '英文-v1', channel: '官网', fake: 123 },
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(store.getJob(us.id)?.application).toMatchObject({
      direction: '数据',
      resumeVersion: '英文-v1',
      channel: '官网',
    });
    expect(store.getJob(us.id)?.application).not.toHaveProperty('fake');
  });
  it('手动改变招聘状态创建历史，重复保存不重复建阶段', async () => {
    const job = (await create()).json<Job>();
    const payload = { company: job.company, position: job.position, status: '面试中', notes: '' };
    await server.app.inject({ method: 'PUT', url: `/api/v1/jobs/${job.id}`, payload });
    await server.app.inject({ method: 'PUT', url: `/api/v1/jobs/${job.id}`, payload });
    expect(store.getJob(job.id)).toMatchObject({
      events: [{ type: 'interview', outcome: 'unknown' }],
      tasks: [{ type: 'interview', startsAt: null }],
    });
    const result = (await server.app.inject('/api/v1/analytics')).json();
    expect(result.metrics.find((item: { key: string }) => item.key === 'interview').numerator).toBe(
      1,
    );
  });
  it('结果和待办修改不能越模块，完成不自动通过，撤销结果后待办重新有效', async () => {
    const job = (await create('us')).json<Job>();
    const stage = (
      await server.app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${job.id}/events?market=us`,
        payload: { type: 'ai_assessment', title: 'AI测评', startsAt: null, dueAt: '2026-11-15' },
      })
    ).json();
    expect(stage.type).toBe('ai_assessment');
    const task = store.getJob(job.id)!.tasks[0];
    expect(
      (
        await server.app.inject({
          method: 'PUT',
          url: `/api/v1/events/${stage.id}`,
          payload: { outcome: 'passed' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await server.app.inject({
          method: 'PUT',
          url: `/api/v1/tasks/${task.id}`,
          payload: { dueAt: '2026-11-16' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/v1/tasks/${task.id}/complete?market=us`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(store.getJob(job.id)?.events[0].outcome).toBe('unknown');
    expect(
      (
        await server.app.inject({
          method: 'PUT',
          url: `/api/v1/events/${stage.id}?market=us`,
          payload: { outcome: 'passed', round: '第一轮' },
        })
      ).statusCode,
    ).toBe(200);
    expect(store.getJob(job.id)?.events[0].outcome).toBe('passed');
    const audit = store
      .listAudit(50, 'us')
      .find((row) => row.entityId === stage.id && row.action === 'update')!;
    store.undoAudit(String(audit.id));
    expect(store.getJob(job.id)?.events[0].outcome).toBe('unknown');
  });
  it('拒绝非法日期、时间范围、目标、时区和阶段结果，不留下部分数据', async () => {
    expect((await create('cn', { appliedOn: '2026-02-30' })).statusCode).toBe(400);
    expect(
      (
        await server.app.inject({
          method: 'PUT',
          url: '/api/v1/goals',
          payload: { weekdays: [-1, 0, 0, 0, 0, 0, 0], weeklyTarget: 5 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.app.inject({
          method: 'PUT',
          url: '/api/v1/productivity/settings',
          payload: { ...DEFAULT_PRODUCTIVITY_SETTINGS, timezone: 'Fake/Zone' },
        })
      ).statusCode,
    ).toBe(400);
    const job = (await create()).json<Job>();
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/v1/jobs/${job.id}/events`,
          payload: {
            type: 'interview',
            startsAt: '2026-11-15T17:00:00Z',
            dueAt: '2026-11-15T16:00:00Z',
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(store.getJob(job.id)?.events).toHaveLength(0);
    expect((await server.app.inject('/api/v1/analytics?from=oops')).statusCode).toBe(400);
  });
  it('新备份保留元数据、阶段结果、取消状态和历史目标，重复导入幂等', async () => {
    const job = (
      await create('us', {
        ...EMPTY_APPLICATION,
        appliedOn: dayInZone(new Date()),
        direction: '分析',
        channel: '官网',
        resumeVersion: 'EN-v2',
      })
    ).json<Job>();
    const stage = store.addEvent(job.id, {
      type: 'interview',
      title: '第一轮面试',
      source: 'manual',
      round: '第一轮',
      outcome: 'passed',
      occurredAt: new Date().toISOString(),
    })!;
    store.addTask(job.id, {
      eventId: stage.id,
      type: 'interview',
      title: '面试',
      cancelledAt: new Date().toISOString(),
    });
    const goals = new GoalService(store);
    goals.saveRules('us', { weekdays: [1, 2, 3, 4, 5, 0, null], weeklyTarget: 15 }, '2026-10-01');
    goals.override('us', 'day', '2026-10-12', 7);
    const backup = (await server.app.inject('/api/v1/export?market=us')).json();
    for (let i = 0; i < 2; i++)
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: '/api/v1/import?market=us',
            payload: backup,
          })
        ).statusCode,
      ).toBe(200);
    expect(store.listJobs('us')).toHaveLength(1);
    expect(store.getJob(job.id)?.tasks).toHaveLength(1);
    store.deleteJob(job.id);
    store.db.exec('DELETE FROM goal_rules;DELETE FROM goal_overrides;');
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/v1/import?market=us',
          payload: backup,
        })
      ).statusCode,
    ).toBe(200);
    expect(store.getJob(job.id)).toMatchObject({
      application: { direction: '分析', resumeVersion: 'EN-v2' },
      events: [{ round: '第一轮', outcome: 'passed' }],
      tasks: [{ type: 'interview' }],
    });
    expect(new GoalService(store).target('us', 'day', '2026-10-12')).toBe(7);
    expect(new GoalService(store).target('cn', 'day', '2026-10-12')).toBeNull();
  });
  it('损坏的目标备份事务回滚，不留下新申请', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/import',
      payload: {
        market: 'cn',
        jobs: [{ company: '不能留存', position: '分析' }],
        productivity: {
          goals: {
            rules: [{ kind: 'day', effectiveOn: '2026-10-01', config: '[-1,1,1,1,1,1,1]' }],
          },
        },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(store.listJobs()).toHaveLength(0);
  });
  it('同一阶段仅改轮次不重置明确结果时间，带不同偏移的安排按真实时间校验', async () => {
    const job = (await create()).json<Job>();
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${job.id}/events`,
      payload: {
        type: 'interview',
        title: '跨时区面试',
        startsAt: '2026-11-15T17:00:00+08:00',
        dueAt: '2026-11-15T12:00:00Z',
      },
    });
    expect(response.statusCode).toBe(200);
    const stage = response.json();
    const resultAt = '2026-10-20T16:00:00Z';
    await server.app.inject({
      method: 'PUT',
      url: `/api/v1/events/${stage.id}`,
      payload: { outcome: 'passed', resultAt, round: '一面' },
    });
    await server.app.inject({
      method: 'PUT',
      url: `/api/v1/events/${stage.id}`,
      payload: { outcome: 'passed', round: '第一轮' },
    });
    expect(store.getJob(job.id)?.events[0]).toMatchObject({ round: '第一轮', resultAt });
  });

  it('日历接口仅导出当前模块，并保留日期事项与稳定 UID', async () => {
    const cn = (await create()).json<Job>(),
      us = (await create('us')).json<Job>();
    store.addTask(cn.id, { type: 'interview', title: '国内面试', dueAt: '2026-11-15' });
    store.addTask(us.id, { type: 'written_test', title: '美国笔试', dueAt: '2026-11-16' });
    const response = await server.app.inject('/api/v1/calendar.ics?market=us');
    expect(response.headers['content-type']).toContain('text/calendar');
    expect(response.body).toContain('美国笔试');
    expect(response.body).not.toContain('国内面试');
    expect(response.body).toContain('VALUE=DATE:20261116');
  });
});
