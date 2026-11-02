import {
  STAGE_TYPES,
  STAGE_LABELS,
  type AnalyticsResult,
  type Metric,
} from '../shared/productivity.js';
import { EMPTY_APPLICATION, type Job, type JobEvent } from '../shared/types.js';
import { dayInZone, isInstant } from '../shared/time.js';
import { applicationDay } from './application.js';

export function submitted(job: Job) {
  return (
    !job.application?.excluded &&
    (job.status !== '待投递' || job.events.some((event) => event.type === 'application'))
  );
}
export const isReminderEvent = (event: JobEvent) =>
  /提醒|催办|再次通知|reminder|follow[- ]?up/i.test(`${event.title}`);
export function usefulEvents(job: Job, asOf: string) {
  return job.events.filter(
    (event) =>
      event.type !== 'application' &&
      event.type !== 'other' &&
      event.type !== 'ended' &&
      event.outcome !== 'cancelled' &&
      !job.tasks.some((task) => task.eventId === event.id && task.cancelledAt) &&
      !isReminderEvent(event) &&
      Date.parse(event.occurredAt) <= Date.parse(asOf),
  );
}
export function stageEvents(job: Job, asOf: string) {
  const events = usefulEvents(job, asOf).filter(
    (event) =>
      (STAGE_TYPES as readonly string[]).includes(event.type) &&
      !job.tasks.some((task) => task.eventId === event.id && task.cancelledAt),
  );
  const grouped = new Map<string, JobEvent>();
  for (const event of events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    const key = event.round
      ? `${event.type}:round:${event.round}`
      : event.startsAt || event.dueAt
        ? `${event.type}:${event.startsAt}:${event.dueAt}`
        : `${event.type}:unspecified`;
    const previous = grouped.get(key);
    if (!previous) grouped.set(key, event);
    else
      grouped.set(key, {
        ...previous,
        completedAt: previous.completedAt || event.completedAt,
        outcome: event.outcome && event.outcome !== 'unknown' ? event.outcome : previous.outcome,
        resultAt: event.resultAt || previous.resultAt,
      });
  }
  return [...grouped.values()];
}
const median = (values: number[]) => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};
function reliableTime(event: JobEvent) {
  return event.source !== 'website' && !event.dedupeKey.startsWith('legacy:');
}
function hours(from: string, to: string) {
  return (Date.parse(to) - Date.parse(from)) / 36e5;
}
function responseHours(job: Job, asOf: string, type?: string) {
  const appliedAt = job.application?.appliedAt;
  if (!appliedAt) return null;
  const first = usefulEvents(job, asOf)
    .filter(
      (event) =>
        (!type || event.type === type) && Date.parse(event.occurredAt) >= Date.parse(appliedAt),
    )
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))[0];
  return first && reliableTime(first) ? hours(appliedAt, first.occurredAt) : null;
}

export function calculateAnalytics(
  allJobs: Job[],
  options: {
    timezone: string;
    from?: string;
    to?: string;
    asOf?: string;
    groupBy?: string;
    direction?: string;
    channel?: string;
    resumeVersion?: string;
  },
): AnalyticsResult {
  const asOf = options.asOf || new Date().toISOString(),
    today = dayInZone(asOf, options.timezone);
  const to = options.to || today,
    from = options.from || null;
  const eligible = allJobs
    .filter(submitted)
    .filter((job) => !options.direction || job.application?.direction === options.direction)
    .filter((job) => !options.channel || job.application?.channel === options.channel)
    .filter(
      (job) => !options.resumeVersion || job.application?.resumeVersion === options.resumeVersion,
    );
  const missing = eligible.filter(
    (job) => !applicationDay(job.application || EMPTY_APPLICATION, options.timezone),
  );
  const cohort = eligible.filter((job) => {
    const day = applicationDay(job.application || EMPTY_APPLICATION, options.timezone);
    if (!day) return !from && to === today;
    return (!from || day >= from) && day <= to && day <= today;
  });
  const has = (job: Job, type: string) =>
    usefulEvents(job, asOf).some((event) => event.type === type);
  const metric = (
    key: string,
    label: string,
    filter: (job: Job) => boolean,
    list = cohort,
  ): Metric => {
    const ids = list.filter(filter).map((job) => job.id);
    return {
      key,
      label,
      numerator: ids.length,
      denominator: list.length,
      rate: list.length ? ids.length / list.length : null,
      jobIds: ids,
    };
  };
  const feedback = (job: Job) => usefulEvents(job, asOf).length > 0;
  const metrics = [
    metric('feedback', '有效反馈率', feedback),
    ...STAGE_TYPES.map((type) =>
      metric(type, `${STAGE_LABELS[type]}到达率`, (job) => has(job, type)),
    ),
    metric('offer', 'Offer 到达率', (job) => has(job, 'offer')),
    metric('unanswered', '无有效反馈占比', (job) => !feedback(job)),
  ];
  const stageGroups = new Map<string, Array<{ job: Job; event: JobEvent }>>();
  for (const job of cohort)
    for (const event of stageEvents(job, asOf)) {
      const key = `${event.type}:${event.round || ''}`;
      stageGroups.set(key, [...(stageGroups.get(key) || []), { job, event }]);
    }
  const stages = [...stageGroups.values()]
    .map((entries) => {
      const reached = entries.length,
        completed = entries.filter(
          ({ event }) => event.completedAt && Date.parse(event.completedAt) <= Date.parse(asOf),
        ).length;
      const outcome = (event: JobEvent, value: string) =>
        event.outcome === value &&
        (!event.resultAt || Date.parse(event.resultAt) <= Date.parse(asOf));
      const passed = entries.filter(({ event }) => outcome(event, 'passed')).length,
        failed = entries.filter(({ event }) => outcome(event, 'failed')).length;
      return {
        type: entries[0].event.type,
        round: entries[0].event.round || '',
        reached,
        completed,
        passed,
        failed,
        unknown: reached - passed - failed,
        completionRate: reached ? completed / reached : null,
        passRate: passed + failed ? passed / (passed + failed) : null,
        coverage: reached ? (passed + failed) / reached : null,
        jobIds: [...new Set(entries.map((entry) => entry.job.id))],
      };
    })
    .sort(
      (a, b) =>
        STAGE_TYPES.indexOf(a.type as (typeof STAGE_TYPES)[number]) -
          STAGE_TYPES.indexOf(b.type as (typeof STAGE_TYPES)[number]) ||
        a.round.localeCompare(b.round),
    );
  const feedbackTimes = cohort
    .map((job) => responseHours(job, asOf))
    .filter((value): value is number => value !== null && value >= 0);
  const offerTimes = cohort
    .map((job) => responseHours(job, asOf, 'offer'))
    .filter((value): value is number => value !== null && value >= 0);
  const stageWaitTimes: number[] = [];
  for (const job of cohort)
    for (const stage of stageEvents(job, asOf)) {
      if (
        !stage.completedAt ||
        !isInstant(stage.completedAt) ||
        Date.parse(stage.completedAt) > Date.parse(asOf)
      )
        continue;
      const next = usefulEvents(job, asOf)
        .filter(
          (event) =>
            event.id !== stage.id && Date.parse(event.occurredAt) > Date.parse(stage.completedAt!),
        )
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))[0];
      const result =
        stage.resultAt &&
        Date.parse(stage.resultAt) > Date.parse(stage.completedAt) &&
        Date.parse(stage.resultAt) <= Date.parse(asOf)
          ? stage.resultAt
          : null;
      if (result && (!next || Date.parse(result) < Date.parse(next.occurredAt)))
        stageWaitTimes.push(hours(stage.completedAt, result));
      else if (next && reliableTime(next))
        stageWaitTimes.push(hours(stage.completedAt, next.occurredAt));
    }
  const groupBy = ['direction', 'channel', 'resumeVersion'].includes(options.groupBy || '')
    ? (options.groupBy as 'direction' | 'channel' | 'resumeVersion')
    : 'direction';
  const groupMap = new Map<string, Job[]>();
  for (const job of cohort) {
    const key = job.application?.[groupBy] || '未填写';
    groupMap.set(key, [...(groupMap.get(key) || []), job]);
  }
  const groups = [...groupMap.entries()]
    .map(([name, list]) => ({
      name,
      count: list.length,
      feedback: metric('feedback', '反馈', feedback, list),
      interview: metric('interview', '真人面试', (job) => has(job, 'interview'), list),
      offer: metric('offer', 'Offer', (job) => has(job, 'offer'), list),
      feedbackHours: median(
        list
          .map((job) => responseHours(job, asOf))
          .filter((value): value is number => value !== null),
      ),
      sampleSmall: list.length < 10,
    }))
    .sort((a, b) => b.count - a.count);
  return {
    asOf,
    timezone: options.timezone,
    from,
    to,
    cohortIds: cohort.map((job) => job.id),
    missingDateIds: missing.map((job) => job.id),
    metrics,
    stages,
    groups,
    medians: {
      feedbackHours: median(feedbackTimes),
      offerHours: median(offerTimes),
      stageWaitHours: median(stageWaitTimes),
      feedbackSample: feedbackTimes.length,
      offerSample: offerTimes.length,
      stageWaitSample: stageWaitTimes.length,
      waiting: cohort.filter((job) => !feedback(job)).length,
      dateOnly: cohort.filter((job) => !job.application?.appliedAt).length,
    },
  };
}
