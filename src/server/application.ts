import { EMPTY_APPLICATION, type ApplicationMeta, type JobEvent } from '../shared/types.js';
import { dayInZone, isDay, isInstant } from '../shared/time.js';

export function readApplication(value: unknown): ApplicationMeta {
  let input: Partial<ApplicationMeta> = {};
  try {
    input =
      typeof value === 'string'
        ? JSON.parse(value)
        : value && typeof value === 'object'
          ? value
          : {};
  } catch {
    /* old snapshots */
  }
  return { ...EMPTY_APPLICATION, ...input };
}

/** Only labelled application dates are usable. Receipt and discovery times are not submission times. */
export function applicationFromEvidence(events: JobEvent[]): Partial<ApplicationMeta> {
  for (const event of [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    if (event.source !== 'website') continue;
    const match =
      event.evidence.match(
        /(?:投递|申请)时间[：:]\s*(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s+(\d{1,2}:\d{2}))?/,
      ) || event.evidence.match(/(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s+(\d{1,2}:\d{2}))?\s*投递/);
    if (!match) continue;
    const date = match[1]
      .split(/[-/.]/)
      .map((part, i) => (i ? part.padStart(2, '0') : part))
      .join('-');
    if (!isDay(date)) continue;
    // A date without a timezone cannot be shifted to the user's statistics timezone safely.
    // Preserve it as missing until confirmed. China-specific extractors now supply an offset timestamp.
    if (match[2]) {
      const appliedAt = `${date}T${match[2].padStart(5, '0')}:00+08:00`;
      if (isInstant(appliedAt)) return { appliedAt, dateSource: 'website' };
    }
  }
  return {};
}

export function applicationDay(meta: ApplicationMeta, timezone: string): string | null {
  return meta.appliedAt ? dayInZone(meta.appliedAt, timezone) || null : meta.appliedOn;
}
