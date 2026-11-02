export const DEFAULT_TIMEZONE = 'America/Chicago';
export const isDay = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
export function dayInZone(value: string | Date, timeZone = DEFAULT_TIMEZONE): string {
  if (typeof value === 'string' && isDay(value)) return value;
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join('-');
}
export function addDays(day: string, count: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5);
}
export function weekStart(day: string) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}
export function weekdayIndex(day: string) {
  return (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
}
export function dateRange(from: string, to: string) {
  const length = daysBetween(from, to) + 1;
  if (!Number.isFinite(length) || length < 0 || length > 3660)
    throw new Error('日期范围应在 10 年以内');
  return Array.from({ length }, (_, index) => addDays(from, index));
}
export function isInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isDay(value.slice(0, 10)) &&
    +value.slice(11, 13) < 24 &&
    +value.slice(14, 16) < 60 &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
/** Interpret a user's datetime-local in the configured IANA zone; reject DST gaps. */
export function zonedToIso(local: string, timeZone = DEFAULT_TIMEZONE): string | null {
  const match = local.match(/^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)$/);
  if (!match || !isDay(match[1]) || +match[2] > 23 || +match[3] > 59) return null;
  const desired = Date.parse(`${local}:00Z`);
  let guess = desired;
  for (let i = 0; i < 4; i++) {
    const formatted = localInZone(new Date(guess).toISOString(), timeZone);
    const difference = desired - Date.parse(`${formatted}:00Z`);
    if (difference === 0) return new Date(guess).toISOString();
    guess += difference;
  }
  return localInZone(new Date(guess).toISOString(), timeZone) === local
    ? new Date(guess).toISOString()
    : null;
}
export function localInZone(value: string, timeZone = DEFAULT_TIMEZONE) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
