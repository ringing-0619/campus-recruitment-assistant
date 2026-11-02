import type { Job } from '../shared/types.js';
import type { ActionItem } from '../shared/productivity.js';
import { addDays, dayInZone, isDay } from '../shared/time.js';

export function calendarActions(
  jobs: Job[],
  timezone: string,
  asOf = new Date().toISOString(),
): ActionItem[] {
  const today = dayInZone(asOf, timezone);
  const actions = jobs
    .filter((job) => !job.application?.excluded && !job.application?.archived)
    .flatMap((job) =>
      job.tasks.map((task) => {
        const date = task.startsAt || task.dueAt;
        const end = task.dueAt || task.startsAt;
        const closed = ['已拒绝', '流程结束', '已offer'].includes(job.status);
        const event = job.events.find((event) => event.id === task.eventId);
        const cancelledAt =
          task.cancelledAt ||
          (event?.outcome === 'cancelled' ? event.resultAt || asOf : null) ||
          (closed && !task.completedAt ? asOf : null);
        const overdue = Boolean(
          !task.completedAt &&
          !task.resolvedAt &&
          !cancelledAt &&
          end &&
          (isDay(end) ? end < today : Date.parse(end) < Date.parse(asOf)),
        );
        return {
          id: task.id,
          jobId: job.id,
          company: job.company,
          position: job.position,
          title: task.title,
          type: task.type,
          startsAt: task.startsAt,
          dueAt: task.dueAt,
          completedAt: task.completedAt,
          cancelledAt,
          resolvedAt: task.resolvedAt || null,
          date: date ? dayInZone(date, timezone) : null,
          overdue,
          conflict: false,
          eventId: task.eventId,
        };
      }),
    );
  // Assessments often have multi-day availability windows; only fixed interview appointments conflict.
  const appointments = actions.filter(
    (action) =>
      ['interview', 'ai_interview'].includes(action.type) &&
      !action.completedAt &&
      !action.cancelledAt &&
      !action.resolvedAt &&
      action.startsAt &&
      !isDay(action.startsAt),
  );
  for (let i = 0; i < appointments.length; i++)
    for (let j = i + 1; j < appointments.length; j++) {
      const a = appointments[i],
        b = appointments[j],
        aStart = Date.parse(a.startsAt!),
        bStart = Date.parse(b.startsAt!);
      const aEnd =
        a.dueAt && !isDay(a.dueAt) && Date.parse(a.dueAt) > aStart ? Date.parse(a.dueAt) : aStart;
      const bEnd =
        b.dueAt && !isDay(b.dueAt) && Date.parse(b.dueAt) > bStart ? Date.parse(b.dueAt) : bStart;
      if (aStart === bStart || (aEnd > aStart && bEnd > bStart && aStart < bEnd && bStart < aEnd)) {
        a.conflict = true;
        b.conflict = true;
      }
    }
  return actions.sort(
    (a, b) =>
      Number(Boolean(a.completedAt || a.cancelledAt)) -
        Number(Boolean(b.completedAt || b.cancelledAt)) ||
      Number(b.overdue) - Number(a.overdue) ||
      (a.startsAt || a.dueAt || '9999').localeCompare(b.startsAt || b.dueAt || '9999'),
  );
}
const escapeIcs = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
const utc = (value: string) =>
  new Date(value)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
function fold(line: string) {
  let result = '',
    current = '',
    bytes = 0;
  for (const char of line) {
    const length = Buffer.byteLength(char);
    if (bytes + length > 73) {
      result += current + '\r\n';
      current = ' ';
      bytes = 1;
    }
    current += char;
    bytes += length;
  }
  return result + current;
}
export function exportCalendar(
  actions: ActionItem[],
  timezone: string,
  asOf = new Date().toISOString(),
) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Campus Assistant//Calendar//ZH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-TIMEZONE:${timezone}`,
  ];
  for (const action of actions) {
    const start = action.startsAt || action.dueAt;
    if (!start) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:task-${action.id}@campus-assistant.local`,
      `DTSTAMP:${utc(asOf)}`,
    );
    if (isDay(start))
      lines.push(
        `DTSTART;VALUE=DATE:${start.replaceAll('-', '')}`,
        `DTEND;VALUE=DATE:${addDays(start, 1).replaceAll('-', '')}`,
      );
    else {
      lines.push(`DTSTART:${utc(start)}`);
      if (action.dueAt && !isDay(action.dueAt) && Date.parse(action.dueAt) > Date.parse(start))
        lines.push(`DTEND:${utc(action.dueAt)}`);
    }
    lines.push(
      `SUMMARY:${escapeIcs(`${action.company} · ${action.title}`)}`,
      `DESCRIPTION:${escapeIcs(`${action.position}\n时区：${timezone}\n日历导出为快照；后续变更请在助手中查看。`)}`,
      `STATUS:${action.cancelledAt ? 'CANCELLED' : 'CONFIRMED'}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
