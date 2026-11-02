import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store } from './db.js';
import { MARKETS, MARKET_LABELS, EMPTY_APPLICATION, type Market } from '../shared/types.js';
import {
  DEFAULT_PRODUCTIVITY_SETTINGS,
  type ProductivitySettings,
  type Reminder,
} from '../shared/productivity.js';
import { dayInZone, daysBetween, isDay, localInZone, zonedToIso, addDays } from '../shared/time.js';
import { applicationDay } from './application.js';
import { submitted, usefulEvents, stageEvents } from './analytics.js';
import { calendarActions } from './actions.js';

export function productivitySettings(store: Store): ProductivitySettings {
  try {
    const stored = JSON.parse(store.getSetting('productivity_settings') || '{}');
    return {
      ...DEFAULT_PRODUCTIVITY_SETTINGS,
      ...stored,
      staleDays: { ...DEFAULT_PRODUCTIVITY_SETTINGS.staleDays, ...stored.staleDays },
    };
  } catch {
    return {
      ...DEFAULT_PRODUCTIVITY_SETTINGS,
      staleDays: { ...DEFAULT_PRODUCTIVITY_SETTINGS.staleDays },
    };
  }
}
export async function nativeNotification(title: string, message: string) {
  if (process.platform !== 'darwin') throw new Error('电脑通知目前支持 macOS');
  await promisify(execFile)(
    '/usr/bin/osascript',
    [
      '-e',
      'on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run',
      title,
      message,
    ],
    { timeout: 10000 },
  );
}
export class ReminderService {
  private busy = false;
  constructor(
    private store: Store,
    private notify = nativeNotification,
  ) {}
  list(market: Market, asOf = new Date().toISOString()): Reminder[] {
    const settings = productivitySettings(this.store),
      today = dayInZone(asOf, settings.timezone);
    const now = Date.parse(asOf),
      jobs = this.store.listJobs(market),
      items: Omit<Reminder, 'snoozedUntil' | 'dismissedAt' | 'desktopSentAt'>[] = [];
    const actions = calendarActions(jobs, settings.timezone, asOf);
    for (const action of actions) {
      if (action.completedAt || action.cancelledAt || action.resolvedAt) continue;
      const date = ['interview', 'ai_interview'].includes(action.type)
        ? action.startsAt || action.dueAt
        : action.dueAt || action.startsAt;
      if (!date) continue;
      const effective = isDay(date) ? zonedToIso(`${date}T09:00`, settings.timezone) : date;
      if (!effective) continue;
      const remaining = (Date.parse(effective) - now) / 36e5;
      if (remaining > 24) continue;
      let band = remaining < 0 ? 'overdue' : remaining <= 2 ? 'soon' : 'day';
      if (isDay(date)) {
        const local = localInZone(asOf, settings.timezone),
          hour = Number(local.slice(11, 13));
        if (
          date > addDays(today, 1) ||
          (date === addDays(today, 1) && hour < 9) ||
          (date === today && hour < 9)
        )
          continue;
        band = date < today ? 'overdue' : date === today ? 'date' : 'day';
      }
      const job = jobs.find((job) => job.id === action.jobId)!;
      items.push({
        key: `deadline:${action.id}:${date}:${band}`,
        market,
        jobId: job.id,
        company: job.company,
        position: job.position,
        kind: 'deadline',
        title: action.overdue ? '待办已逾期' : isDay(date) ? '待办日期提醒' : '待办即将到期',
        reason: `${action.title} · ${isDay(date) ? date : localInZone(date, settings.timezone).replace('T', ' ')}（${settings.timezone}）`,
        anchor: date,
        dueAt: date,
      });
    }
    for (const job of jobs) {
      const meta = job.application || EMPTY_APPLICATION;
      if (
        !submitted(job) ||
        meta.archived ||
        meta.followupPaused ||
        ['已拒绝', '流程结束', '已offer'].includes(job.status)
      )
        continue;
      if (
        actions.some(
          (action) =>
            action.jobId === job.id &&
            !action.completedAt &&
            !action.cancelledAt &&
            !action.resolvedAt,
        )
      )
        continue;
      const events = [
          ...stageEvents(job, asOf),
          ...usefulEvents(job, asOf).filter((event) =>
            ['offer', 'rejection', 'ended'].includes(event.type),
          ),
        ],
        applied = meta.appliedAt || applicationDay(meta, settings.timezone);
      const anchors = [
        ...(applied ? [{ at: applied, type: 'application', id: 'application' }] : []),
        ...events.map((event) => ({
          at: event.resultAt || event.completedAt || event.occurredAt,
          type: event.type,
          id: event.id,
        })),
      ]
        .filter((anchor) => (isDay(anchor.at) ? anchor.at <= today : Date.parse(anchor.at) <= now))
        .sort((a, b) => a.at.localeCompare(b.at));
      const anchor = anchors.at(-1);
      if (!anchor) continue;
      const threshold = /interview/.test(anchor.type)
        ? settings.staleDays.interview
        : /assessment|written_test/.test(anchor.type)
          ? settings.staleDays.assessment
          : settings.staleDays.application;
      const elapsed = daysBetween(dayInZone(anchor.at, settings.timezone), today);
      if (elapsed < threshold) continue;
      items.push({
        key: `stale:${job.id}:${anchor.id}:${anchor.at}`,
        market,
        jobId: job.id,
        company: job.company,
        position: job.position,
        kind: 'stale',
        title: '长期无进展，建议跟进',
        reason: `距离${anchor.type === 'application' ? '投递' : '最近一次有效进展／完成'}已 ${elapsed} 天，提醒阈值 ${threshold} 天。尚不能据此判断招聘结果。`,
        anchor: anchor.at,
        dueAt: null,
      });
    }
    return items
      .map((item) => {
        const state = this.store.db
          .prepare('SELECT * FROM reminder_state WHERE key=?')
          .get(item.key);
        return {
          ...item,
          snoozedUntil: (state?.snoozed_until as string | null) || null,
          dismissedAt: (state?.dismissed_at as string | null) || null,
          desktopSentAt: (state?.desktop_sent_at as string | null) || null,
        };
      })
      .filter(
        (item) => !item.dismissedAt && (!item.snoozedUntil || Date.parse(item.snoozedUntil) <= now),
      );
  }
  act(
    market: Market,
    key: string,
    action: 'dismiss' | 'snooze' | 'followed_up',
    days = 3,
    asOf = new Date().toISOString(),
  ) {
    const item = this.list(market, asOf).find((item) => item.key === key);
    if (!item) throw new Error('提醒已失效或不属于当前模块');
    const until =
      action === 'dismiss' ? null : new Date(Date.parse(asOf) + days * 864e5).toISOString();
    this.store.db
      .prepare(
        `INSERT INTO reminder_state(key,market,job_id,snoozed_until,dismissed_at,desktop_sent_at,updated_at) VALUES(?,?,?,?,?,NULL,?)
      ON CONFLICT(key) DO UPDATE SET snoozed_until=excluded.snoozed_until,dismissed_at=excluded.dismissed_at,desktop_sent_at=NULL,updated_at=excluded.updated_at`,
      )
      .run(key, market, item.jobId, until, action === 'dismiss' ? asOf : null, asOf);
  }
  private quiet(settings: ProductivitySettings, asOf: string) {
    if (settings.quietStart === settings.quietEnd) return false;
    const hour = Number(localInZone(asOf, settings.timezone).slice(11, 13));
    return settings.quietStart > settings.quietEnd
      ? hour >= settings.quietStart || hour < settings.quietEnd
      : hour >= settings.quietStart && hour < settings.quietEnd;
  }
  async tick(asOf = new Date().toISOString()) {
    const settings = productivitySettings(this.store);
    if (
      this.busy ||
      !settings.desktopEnabled ||
      this.quiet(settings, asOf) ||
      Date.parse(this.store.getSetting('desktop_notification_retry_after') || '') > Date.parse(asOf)
    )
      return;
    this.busy = true;
    try {
      for (const market of MARKETS) {
        const items = this.list(market, asOf).filter((item) => !item.desktopSentAt);
        if (!items.length) continue;
        // One summary per market on recovery; older phases of a deadline are not replayed.
        await this.notify(
          `${MARKET_LABELS[market]} · ${items.length} 项提醒`,
          items
            .slice(0, 3)
            .map((item) => `${item.company}：${item.title}`)
            .join('；'),
        );
        this.store.transaction(() => {
          for (const item of items)
            this.store.db
              .prepare(
                `INSERT INTO reminder_state(key,market,job_id,desktop_sent_at,updated_at) VALUES(?,?,?,?,?)
            ON CONFLICT(key) DO UPDATE SET desktop_sent_at=excluded.desktop_sent_at,last_error=NULL,updated_at=excluded.updated_at`,
              )
              .run(item.key, market, item.jobId, asOf, asOf);
        });
      }
      this.store.setSetting('desktop_notification_error', '');
      this.store.setSetting('desktop_notification_attempts', '0');
      this.store.setSetting('desktop_notification_retry_after', '');
    } catch (error) {
      this.store.setSetting('desktop_notification_error', (error as Error).message.slice(0, 300));
      const attempts = Number(this.store.getSetting('desktop_notification_attempts') || '0') + 1;
      this.store.setSetting('desktop_notification_attempts', String(attempts));
      this.store.setSetting(
        'desktop_notification_retry_after',
        new Date(
          Date.parse(asOf) + Math.min(30, 2 ** Math.min(attempts - 1, 5)) * 60_000,
        ).toISOString(),
      );
    } finally {
      this.busy = false;
    }
  }
}
