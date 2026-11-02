import type { Market, EventType } from './types.js';
export const STAGE_TYPES = [
  'assessment',
  'ai_assessment',
  'written_test',
  'interview',
  'ai_interview',
] as const;
export type StageType = (typeof STAGE_TYPES)[number];
export const STAGE_LABELS: Record<string, string> = {
  assessment: '普通测评',
  ai_assessment: 'AI 测评',
  written_test: '笔试',
  interview: '真人面试',
  ai_interview: 'AI 面试',
  application: '投递',
  offer: 'Offer',
  rejection: '明确拒绝',
  ended: '流程结束',
  other: '其他',
};
export interface ProductivitySettings {
  timezone: string;
  staleDays: { application: number; assessment: number; interview: number };
  desktopEnabled: boolean;
  quietStart: number;
  quietEnd: number;
}
export const DEFAULT_PRODUCTIVITY_SETTINGS: ProductivitySettings = {
  timezone: 'America/Chicago',
  staleDays: { application: 10, assessment: 7, interview: 7 },
  desktopEnabled: false,
  quietStart: 21,
  quietEnd: 8,
};
export interface GoalRules {
  weekdays: Array<number | null>;
  weeklyTarget: number | null;
}
export type CurrentGoalChanges = Partial<Record<'day' | 'week', number | null>>;
export interface CurrentGoalTargetsInput {
  date: string;
  weekStart: string;
  timezone: string;
  changes: CurrentGoalChanges;
}
export interface GoalPoint {
  date: string;
  actual: number;
  target: number | null;
  remaining: number | null;
  jobIds: string[];
}
export interface GoalModule {
  market: Market;
  rules: GoalRules;
  day: GoalPoint;
  week: GoalPoint;
  days: GoalPoint[];
  weeks: GoalPoint[];
  missingDateIds: string[];
  dailyAdherence: { achieved: number; total: number };
  neededPerDay: number | null;
}
export interface GoalSummary {
  asOf: string;
  timezone: string;
  today: string;
  weekStart: string;
  modules: GoalModule[];
  total: { day: GoalPoint; week: GoalPoint };
}
export interface Metric {
  key: string;
  label: string;
  numerator: number;
  denominator: number;
  rate: number | null;
  jobIds: string[];
}
export interface AnalyticsResult {
  asOf: string;
  timezone: string;
  from: string | null;
  to: string;
  cohortIds: string[];
  missingDateIds: string[];
  metrics: Metric[];
  stages: Array<{
    type: string;
    round: string;
    reached: number;
    completed: number;
    passed: number;
    failed: number;
    unknown: number;
    completionRate: number | null;
    passRate: number | null;
    coverage: number | null;
    jobIds: string[];
  }>;
  medians: {
    feedbackHours: number | null;
    offerHours: number | null;
    stageWaitHours: number | null;
    feedbackSample: number;
    offerSample: number;
    stageWaitSample: number;
    waiting: number;
    dateOnly: number;
  };
  groups: Array<{
    name: string;
    count: number;
    feedback: Metric;
    interview: Metric;
    offer: Metric;
    feedbackHours: number | null;
    sampleSmall: boolean;
  }>;
}
export interface ActionItem {
  id: string;
  jobId: string;
  company: string;
  position: string;
  title: string;
  type: EventType;
  startsAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  resolvedAt: string | null;
  date: string | null;
  overdue: boolean;
  conflict: boolean;
  eventId: string | null;
}
export interface Reminder {
  key: string;
  market: Market;
  jobId: string;
  company: string;
  position: string;
  kind: 'stale' | 'deadline';
  title: string;
  reason: string;
  anchor: string;
  dueAt: string | null;
  snoozedUntil: string | null;
  dismissedAt: string | null;
  desktopSentAt: string | null;
}
