export const JOB_STATUSES = [
  '待投递',
  '已投递',
  '测评中',
  'AI测评中',
  '笔试中',
  '面试中',
  'AI面试中',
  '等待结果',
  '已offer',
  '已拒绝',
  '流程结束',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const EVENT_TYPES = [
  'application',
  'assessment',
  'ai_assessment',
  'written_test',
  'interview',
  'ai_interview',
  'offer',
  'rejection',
  'ended',
  'other',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type TaskEventType =
  'assessment' | 'ai_assessment' | 'written_test' | 'interview' | 'ai_interview' | 'other';
export type EventSource = 'manual' | 'website' | 'email';

export interface Job {
  id: string;
  market: Market;
  company: string;
  position: string;
  status: JobStatus;
  notes: string;
  source: string;
  externalApplicationId: string;
  progressUrls: string[];
  lastSyncedAt: string | null;
  syncHealth: 'ok' | 'needs_login' | 'error' | 'never';
  createdAt: string;
  updatedAt: string;
  nextDeadline: string | null;
  events: JobEvent[];
  tasks: JobTask[];
  application?: ApplicationMeta;
}

export interface ApplicationMeta {
  appliedOn: string | null;
  appliedAt: string | null;
  dateSource: 'unknown' | 'manual' | 'website' | 'email';
  direction: string;
  channel: string;
  resumeVersion: string;
  archived: boolean;
  excluded: boolean;
  followupPaused: boolean;
}
export const EMPTY_APPLICATION: ApplicationMeta = {
  appliedOn: null,
  appliedAt: null,
  dateSource: 'unknown',
  direction: '',
  channel: '',
  resumeVersion: '',
  archived: false,
  excluded: false,
  followupPaused: false,
};
export type StageOutcome = 'unknown' | 'passed' | 'failed' | 'cancelled';

export interface JobEvent {
  id: string;
  jobId: string;
  type: EventType;
  title: string;
  source: EventSource;
  occurredAt: string;
  startsAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  confidence: number;
  evidence: string;
  dedupeKey: string;
  createdAt: string;
  round?: string;
  outcome?: StageOutcome;
  resultAt?: string | null;
}

export interface JobTask {
  id: string;
  jobId: string;
  eventId: string | null;
  type: TaskEventType;
  title: string;
  startsAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  cancelledAt?: string | null;
  resolvedAt?: string | null;
}

export interface Candidate {
  id: string;
  market: Market;
  source: 'website' | 'email';
  sourceRef: string;
  company: string;
  position: string;
  externalApplicationId: string;
  url: string;
  eventType: EventType;
  title: string;
  occurredAt: string;
  startsAt: string | null;
  dueAt: string | null;
  evidence: string;
  confidence: number;
  parsingConfidence?: number;
  reviewReason?: string;
  suggestedJobId: string | null;
  status: 'pending' | 'applied' | 'ignored';
  createdAt: string;
  application?: Partial<ApplicationMeta>;
}

export interface SyncStatus {
  service: 'online';
  routing: { email: Market; website: Market };
  email: {
    configured: boolean;
    connected: boolean;
    syncing: boolean;
    lastSyncAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
    nextRetryAt: string | null;
    retryAttempt: number;
    address: string | null;
  };
  extension: { paired: boolean; lastSeenAt: string | null };
  pendingCandidates: number;
  unrecognizedDomains: Array<{ domain: string; count: number; lastSeenAt: string }>;
}

export interface CandidateInput {
  source: 'website' | 'email';
  market?: Market;
  sourceRef?: string;
  company?: string;
  // 平台也可能自己招聘：只有明确雇主字段或用户填写的名称才能作为该类雇主。
  companySource?: 'employer-field' | 'manual' | 'saved-job';
  position?: string;
  externalApplicationId?: string;
  url?: string;
  eventType: EventType;
  title?: string;
  occurredAt?: string;
  startsAt?: string | null;
  dueAt?: string | null;
  evidence?: string;
  confidence?: number;
  // 仅在内存中用于关联；不保存邮件全文、访问链接或完整邮件头。
  matchingText?: string;
  positionHint?: string;
  relatedSourceRefs?: string[];
  application?: Partial<ApplicationMeta>;
}
export const MARKETS = ['cn', 'us'] as const;
export type Market = (typeof MARKETS)[number];
export const MARKET_LABELS: Record<Market, string> = { cn: '国内秋招', us: '美国求职' };
export function normalizeMarket(value: unknown): Market {
  return value === 'us' ? 'us' : 'cn';
}
