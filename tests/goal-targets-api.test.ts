import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/db.js';
import { createServer } from '../src/server/app.js';
import { GoalService } from '../src/server/goals.js';
import { addDays, dayInZone, weekStart } from '../src/shared/time.js';
import type { CurrentGoalChanges, GoalSummary } from '../src/shared/productivity.js';

let dir: string, store: Store, server: Awaited<ReturnType<typeof createServer>>, goals: GoalService;
const timezone = 'America/Chicago';
const period = () => {
  const date = dayInZone(new Date(), timezone);
  return { date, weekStart: weekStart(date), timezone };
};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'campus-goal-targets-'));
  store = new Store(join(dir, 'db.sqlite'));
  goals = new GoalService(store);
  server = await createServer({ store, startMail: false });
});
afterEach(async () => {
  await server.app.close();
  rmSync(dir, { recursive: true, force: true });
});
const save = (changes: CurrentGoalChanges, market = 'cn', extra: Record<string, unknown> = {}) =>
  server.app.inject({
    method: 'PUT',
    url: `/api/v1/goals/current-targets?market=${market}`,
    payload: { ...period(), changes, ...extra },
  });

describe('当前模块今日／本周目标保存', () => {
  it('一次保存两个目标并返回可刷新界面的汇总，保持另一模块与历史目标', async () => {
    const { date, weekStart: start } = period();
    goals.saveRules('us', { weekdays: [2, 2, 2, 2, 2, 2, 0], weeklyTarget: 8 }, start);
    goals.override('cn', 'day', addDays(date, -1), 7);
    goals.override('cn', 'week', addDays(start, -7), 15);
    const response = await save({ day: 5, week: 20 });
    expect(response.statusCode).toBe(200);
    const result = response.json<GoalSummary>();
    expect(result.modules[0]).toMatchObject({ day: { target: 5 }, week: { target: 20 } });
    expect(result.modules[1].week.target).toBe(8);
    expect(goals.target('cn', 'day', addDays(date, -1))).toBe(7);
    expect(goals.target('cn', 'week', addDays(start, -7))).toBe(15);
  });
  it('只修改提交字段，不给未修改字段创建覆盖值，仍可继承默认规则', async () => {
    const { date } = period();
    goals.saveRules('cn', { weekdays: [3, 3, 3, 3, 3, 3, 3], weeklyTarget: 15 }, date);
    expect((await save({ day: 4 })).statusCode).toBe(200);
    expect(store.db.prepare("SELECT * FROM goal_overrides WHERE kind='week'").all()).toHaveLength(
      0,
    );
    goals.saveRules('cn', { weekdays: [3, 3, 3, 3, 3, 3, 3], weeklyTarget: 18 }, date);
    expect(goals.target('cn', 'week', date)).toBe(18);
    expect(goals.target('cn', 'day', date)).toBe(4);
  });
  it('美国保存仅作用于美国，0 与 null 的含义独立保留', async () => {
    await save({ day: 5, week: 20 });
    const response = await save({ day: 0, week: null }, 'us');
    expect(response.statusCode).toBe(200);
    expect(response.json<GoalSummary>().modules[1]).toMatchObject({
      day: { target: 0 },
      week: { target: null },
    });
    expect(goals.target('cn', 'day', period().date)).toBe(5);
    expect(goals.target('cn', 'week', period().date)).toBe(20);
  });
  it('第二个值非法时不保存第一个值，拒绝不认识的字段和求职模块', async () => {
    expect((await save({ day: 5, week: -1 })).statusCode).toBe(400);
    expect(goals.target('cn', 'day', period().date)).toBeNull();
    expect((await save({})).statusCode).toBe(400);
    expect((await save({ day: 1 }, 'invalid')).statusCode).toBe(400);
    expect((await save({ day: 1 }, 'cn', { changes: { day: 1, market: 'us' } })).statusCode).toBe(
      400,
    );
  });
  it('数据库第二次写入失败时，第一个目标一起回滚', async () => {
    store.db.exec(
      "CREATE TEMP TRIGGER fail_week_goal BEFORE INSERT ON goal_overrides WHEN NEW.kind='week' BEGIN SELECT RAISE(FAIL,'test rollback'); END;",
    );
    expect((await save({ day: 5, week: 20 })).statusCode).toBe(500);
    expect(store.db.prepare('SELECT * FROM goal_overrides').all()).toHaveLength(0);
  });
  it('跨日、跨周或时区变化返回冲突，不保存到错误的期间', async () => {
    const { date, weekStart: start } = period();
    for (const extra of [
      { date: addDays(date, -1) },
      { weekStart: addDays(start, -7) },
      { timezone: 'Asia/Shanghai' },
    ]) {
      const response = await save({ day: 5, week: 20 }, 'cn', extra);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('GOAL_PERIOD_CHANGED');
    }
    expect(store.db.prepare('SELECT * FROM goal_overrides').all()).toHaveLength(0);
  });
});
