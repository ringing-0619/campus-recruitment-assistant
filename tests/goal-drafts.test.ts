import { describe, expect, it } from 'vitest';
import { GoalDraftBook } from '../src/web/goal-drafts.js';
import type { GoalModule, GoalSummary } from '../src/shared/productivity.js';
const point = (target: number | null) => ({
  date: '2026-10-31',
  target,
  actual: 1,
  remaining: target === null ? null : Math.max(target - 1, 0),
  jobIds: [],
});
const module = (market: 'cn' | 'us', day: number | null, week: number | null): GoalModule => ({
  market,
  day: point(day),
  week: point(week),
  days: [],
  weeks: [],
  rules: { weekdays: [null, null, null, null, null, null, null], weeklyTarget: null },
  missingDateIds: [],
  dailyAdherence: { achieved: 0, total: 0 },
  neededPerDay: null,
});
const summary = (): GoalSummary => ({
  asOf: '2026-10-31T16:00:00Z',
  timezone: 'America/Chicago',
  today: '2026-10-31',
  weekStart: '2026-10-26',
  modules: [module('cn', 5, 20), module('us', 2, 8)],
  total: { day: point(7), week: point(28) },
});
describe('目标输入草稿与自动刷新', () => {
  it('中美草稿分别保留，往返切换不会带入另一个模块的输入', () => {
    const drafts = new GoalDraftBook(),
      data = summary();
    drafts.edit('cn', 'day', '9', data);
    drafts.edit('us', 'week', '30', data);
    expect(drafts.sync('cn', data).values).toEqual({ day: '9', week: '20' });
    expect(drafts.sync('us', data).values).toEqual({ day: '2', week: '30' });
  });
  it('刷新更新未修改字段，保留未保存的输入；提交只包含实际修改项', () => {
    const drafts = new GoalDraftBook(),
      data = summary();
    drafts.edit('cn', 'day', '9', data);
    const updated = summary();
    updated.modules[0].day.target = 6;
    updated.modules[0].week.target = 22;
    const draft = drafts.sync('cn', updated);
    expect(draft.values).toEqual({ day: '9', week: '22' });
    expect(drafts.request(draft).changes).toEqual({ day: 9 });
  });
  it('保存中的旧模块响应不清除另一模块的新草稿', () => {
    const drafts = new GoalDraftBook(),
      data = summary();
    drafts.edit('cn', 'day', '9', data);
    const cn = drafts.sync('cn', data);
    cn.saving = true;
    drafts.edit('us', 'day', '4', data);
    const saved = summary();
    saved.modules[0].day.target = 9;
    drafts.saved(cn, saved, 'cn');
    expect(drafts.sync('us', saved).values.day).toBe('4');
    expect(drafts.request(drafts.sync('us', saved)).changes).toEqual({ day: 4 });
    expect(cn.dirty.size).toBe(0);
  });
  it('跨日和跨周保留旧草稿并标记过期，显式刷新后才使用新期间', () => {
    const drafts = new GoalDraftBook(),
      data = summary();
    drafts.edit('cn', 'day', '9', data);
    const updated = { ...data, today: '2026-11-02', weekStart: '2026-11-02' };
    const draft = drafts.sync('cn', updated);
    expect(drafts.stale(draft, updated)).toBe(true);
    expect(draft.values.day).toBe('9');
    const reset = drafts.reset('cn', updated);
    expect(drafts.stale(reset, updated)).toBe(false);
    expect(reset.dirty.size).toBe(0);
  });
  it('空白、零与非法数字分别处理；改回原值不产生额外覆盖', () => {
    const drafts = new GoalDraftBook(),
      data = summary();
    drafts.edit('cn', 'day', '', data);
    expect(drafts.request(drafts.sync('cn', data)).changes).toEqual({ day: null });
    drafts.edit('cn', 'day', '0', data);
    expect(drafts.request(drafts.sync('cn', data)).changes).toEqual({ day: 0 });
    drafts.edit('cn', 'day', '1.5', data);
    expect(() => drafts.request(drafts.sync('cn', data))).toThrow();
    drafts.edit('cn', 'day', '5', data);
    expect(drafts.sync('cn', data).dirty.size).toBe(0);
  });
});
