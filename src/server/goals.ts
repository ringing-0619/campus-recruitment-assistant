import type { Store } from './db.js';
import { EMPTY_APPLICATION, MARKETS, type Market } from '../shared/types.js';
import type { GoalRules, GoalPoint, GoalSummary, GoalModule } from '../shared/productivity.js';
import { addDays, dateRange, dayInZone, weekStart, weekdayIndex, isDay } from '../shared/time.js';
import { applicationDay } from './application.js';
import { submitted } from './analytics.js';

const EMPTY_RULES: GoalRules = { weekdays: Array(7).fill(null), weeklyTarget: null };
export class GoalService {
  constructor(private store: Store) {}
  rules(market: Market, day: string): GoalRules {
    const read = (kind: string, date: string) =>
      this.store.db
        .prepare(
          'SELECT config_json FROM goal_rules WHERE market=? AND kind=? AND effective_on<=? ORDER BY effective_on DESC LIMIT 1',
        )
        .get(market, kind, date);
    const daily = read('day', day),
      weekly = read('week', weekStart(day));
    return {
      weekdays: daily ? JSON.parse(String(daily.config_json)) : EMPTY_RULES.weekdays,
      weeklyTarget: weekly ? JSON.parse(String(weekly.config_json)) : null,
    };
  }
  saveRules(market: Market, rules: GoalRules, today: string) {
    this.store.transaction(() => {
      const statement = this.store.db.prepare(
        'INSERT INTO goal_rules(market,kind,effective_on,config_json) VALUES(?,?,?,?) ON CONFLICT(market,kind,effective_on) DO UPDATE SET config_json=excluded.config_json',
      );
      statement.run(market, 'day', today, JSON.stringify(rules.weekdays));
      statement.run(market, 'week', weekStart(today), JSON.stringify(rules.weeklyTarget));
    });
  }
  override(market: Market, kind: 'day' | 'week', date: string, target: number | null) {
    const period = kind === 'week' ? weekStart(date) : date;
    this.store.db
      .prepare(
        'INSERT INTO goal_overrides(market,kind,period_start,target) VALUES(?,?,?,?) ON CONFLICT(market,kind,period_start) DO UPDATE SET target=excluded.target',
      )
      .run(market, kind, period, target);
  }
  target(market: Market, kind: 'day' | 'week', date: string): number | null {
    const period = kind === 'week' ? weekStart(date) : date;
    const row = this.store.db
      .prepare('SELECT target FROM goal_overrides WHERE market=? AND kind=? AND period_start=?')
      .get(market, kind, period);
    if (row) return row.target === null ? null : Number(row.target);
    const rules = this.rules(market, date);
    return kind === 'week' ? rules.weeklyTarget : rules.weekdays[weekdayIndex(date)];
  }
  summary(timezone: string, asOf = new Date().toISOString()): GoalSummary {
    const today = dayInZone(asOf, timezone),
      start = weekStart(today);
    const modules: GoalModule[] = MARKETS.map((market) => {
      const jobs = this.store.listJobs(market).filter(submitted);
      const dates = new Map<string, string[]>();
      for (const job of jobs) {
        const day = applicationDay(job.application || EMPTY_APPLICATION, timezone);
        if (day && day <= today) dates.set(day, [...(dates.get(day) || []), job.id]);
      }
      const point = (kind: 'day' | 'week', date: string): GoalPoint => {
        const jobIds =
          kind === 'day'
            ? dates.get(date) || []
            : dateRange(date, addDays(date, 6)).flatMap((day) => dates.get(day) || []);
        const target = this.target(market, kind, date),
          actual = jobIds.length;
        return {
          date,
          actual,
          target,
          remaining: target === null ? null : Math.max(target - actual, 0),
          jobIds,
        };
      };
      const days = dateRange(
        addDays(today, -27),
        addDays(start, 6) > today ? addDays(start, 6) : today,
      ).map((day) => point('day', day));
      const weeks = Array.from({ length: 8 }, (_, i) =>
        point('week', addDays(start, -7 * (7 - i))),
      );
      const ended = days.filter((day) => day.date < today && day.target !== null && day.target > 0);
      const day = point('day', today),
        week = point('week', start);
      const planned = dateRange(today, addDays(start, 6)).filter(
        (date) => (this.target(market, 'day', date) || 0) > 0,
      ).length;
      return {
        market,
        rules: this.rules(market, today),
        day,
        week,
        days,
        weeks,
        missingDateIds: jobs
          .filter((job) => !applicationDay(job.application || EMPTY_APPLICATION, timezone))
          .map((job) => job.id),
        dailyAdherence: {
          achieved: ended.filter((day) => day.actual >= day.target!).length,
          total: ended.length,
        },
        neededPerDay:
          week.remaining !== null && planned ? Math.ceil(week.remaining / planned) : null,
      };
    });
    const total = (period: 'day' | 'week'): GoalPoint => {
      const points = modules.map((module) => module[period]),
        set = points.filter((point) => point.target !== null);
      return {
        date: period === 'day' ? today : start,
        actual: points.reduce((sum, point) => sum + point.actual, 0),
        target: set.length ? set.reduce((sum, point) => sum + point.target!, 0) : null,
        remaining: set.length ? set.reduce((sum, point) => sum + point.remaining!, 0) : null,
        jobIds: points.flatMap((point) => point.jobIds),
      };
    };
    return {
      asOf,
      timezone,
      today,
      weekStart: start,
      modules,
      total: { day: total('day'), week: total('week') },
    };
  }
  export(market: Market) {
    return {
      rules: this.store.db
        .prepare(
          'SELECT kind,effective_on AS effectiveOn,config_json AS config FROM goal_rules WHERE market=? ORDER BY effective_on',
        )
        .all(market),
      overrides: this.store.db
        .prepare(
          'SELECT kind,period_start AS periodStart,target FROM goal_overrides WHERE market=?',
        )
        .all(market),
    };
  }
  import(market: Market, value: unknown) {
    if (!value || typeof value !== 'object') throw new Error('目标备份格式不正确');
    const data = value as {
      rules?: Array<Record<string, unknown>>;
      overrides?: Array<Record<string, unknown>>;
    };
    const valid = (value: unknown) =>
      value === null || (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 10000);
    for (const row of data.rules || []) {
      if (!['day', 'week'].includes(String(row.kind)) || !isDay(row.effectiveOn))
        throw new Error('目标规则日期不正确');
      const config = JSON.parse(String(row.config));
      if (
        row.kind === 'day'
          ? !Array.isArray(config) || config.length !== 7 || !config.every(valid)
          : !valid(config)
      )
        throw new Error('目标数值不正确');
      this.store.db
        .prepare(
          'INSERT INTO goal_rules(market,kind,effective_on,config_json) VALUES(?,?,?,?) ON CONFLICT(market,kind,effective_on) DO UPDATE SET config_json=excluded.config_json',
        )
        .run(market, String(row.kind), String(row.effectiveOn), JSON.stringify(config));
    }
    for (const row of data.overrides || []) {
      if (
        !['day', 'week'].includes(String(row.kind)) ||
        !isDay(row.periodStart) ||
        !valid(row.target)
      )
        throw new Error('目标覆盖信息不正确');
      this.override(
        market,
        row.kind as 'day' | 'week',
        row.periodStart as string,
        row.target as number | null,
      );
    }
  }
}
