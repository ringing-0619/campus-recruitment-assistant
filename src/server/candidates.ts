import { randomUUID } from 'node:crypto';
import type {
  Candidate,
  CandidateInput,
  EventType,
  Job,
  JobStatus,
  TaskEventType,
} from '../shared/types.js';
import { Store, stableHash } from './db.js';
import {
  isUsefulCompanyCandidate,
  isUsefulPositionCandidate,
  isWebsitePositionMetadata,
  isRecruitmentPlatformCompany,
} from './candidate-fields.js';
import { normalizeMarket } from '../shared/types.js';
import { resolveEmailJob } from './email-matching.js';
import { isDay, isInstant } from '../shared/time.js';
import { canonicalCompany } from './company-identity.js';

const AUTO_APPLY_CONFIDENCE = 0.9;

export class CandidateService {
  constructor(private store: Store) {}

  ingest(input: CandidateInput) {
    return this.store.transaction(() => this.ingestAtomic(input));
  }

  private ingestAtomic(input: CandidateInput) {
    const now = new Date().toISOString();
    const verifiedStoredCompany =
      input.companySource === 'saved-job' &&
      this.store
        .listJobs(normalizeMarket(input.market))
        .some(
          (job) =>
            job.company === input.company &&
            job.position === input.position &&
            Boolean(input.url && job.progressUrls.includes(input.url)),
        );
    const normalized = normalizeInput(input, now, verifiedStoredCompany);
    const market = normalizeMarket(normalized.market);
    const rawRef =
      normalized.sourceRef ||
      `${normalized.source}:${stableHash(
        [
          normalized.url,
          normalized.company,
          normalized.position,
          normalized.eventType,
          normalized.evidence,
        ].join('|'),
      )}`;
    // 保留国内历史去重键；美国记录使用独立命名空间，避免跨模块合并同一申请。
    const sourceRef =
      market === 'us' && !rawRef.startsWith('market:us:') ? `market:us:${rawRef}` : rawRef;
    const jobs = this.store.listJobs(market);
    const emailDecision = normalized.source === 'email' ? resolveEmailJob(jobs, normalized) : null;
    const match = emailDecision ? emailDecision.match : matchJob(jobs, normalized);
    // 匹配分只表达关联把握，不能把低置信度邮件解析提升为自动采纳。
    const invalidWebsitePosition =
      normalized.source === 'website' && isWebsitePositionMetadata(input.position || '');
    const confidence =
      normalized.source === 'email' ||
      invalidWebsitePosition ||
      (normalized.source === 'website' && !normalized.company)
        ? Math.min(normalized.confidence!, match?.score ?? 1)
        : (match?.score ?? normalized.confidence ?? 0.7);
    const candidate: Candidate = {
      id: randomUUID(),
      market,
      source: normalized.source,
      sourceRef,
      company: normalized.company || '',
      position: normalized.position || '',
      externalApplicationId: normalized.externalApplicationId || '',
      url: normalized.url || '',
      eventType: normalized.eventType,
      title: normalized.title || titleFor(normalized.eventType),
      occurredAt: normalized.occurredAt || now,
      startsAt: normalized.startsAt || null,
      dueAt: normalized.dueAt || null,
      evidence: normalized.evidence || '',
      confidence,
      parsingConfidence: normalized.confidence,
      reviewReason:
        normalized.source === 'email'
          ? normalized.confidence! < AUTO_APPLY_CONFIDENCE
            ? '邮件缺少可靠的公司或阶段证据，需要人工核对'
            : emailDecision?.reason || ''
          : !normalized.company
            ? '网页缺少可靠的雇主信息；招聘平台名称不能作为公司，需要补全真实公司'
            : '',
      suggestedJobId: match?.job.id || null,
      status: 'pending',
      createdAt: now,
      application: normalized.application,
    };
    const saved = this.store.insertCandidate(candidate);
    if (saved.status !== 'pending')
      return { candidate: saved, autoApplied: saved.status === 'applied' };

    const mayCreateApplication =
      candidate.eventType === 'application' &&
      candidate.company &&
      candidate.position &&
      candidate.confidence >= AUTO_APPLY_CONFIDENCE &&
      (!emailDecision || emailDecision.allowCreate);
    if (
      (candidate.suggestedJobId &&
        candidate.confidence >= AUTO_APPLY_CONFIDENCE &&
        candidate.eventType !== 'other') ||
      mayCreateApplication
    ) {
      // sourceRef 已存在且仍待确认时，使用数据库中的真实 id；这样规则升级后重放同一封邮件也能自动归档。
      // null 表示明确新建；不能回退使用旧待确认记录里已经过时的 suggestedJobId。
      this.apply(saved.id, candidate.suggestedJobId || null);
      return { candidate: this.store.getCandidate(saved.id)!, autoApplied: true };
    }
    return { candidate: saved, autoApplied: false };
  }

  apply(candidateId: string, selectedJobId?: string | null, overrides: Partial<Candidate> = {}) {
    return this.store.transaction(() => this.applyAtomic(candidateId, selectedJobId, overrides));
  }

  // 同步结束再尝试尚未处理的邮件，解决“通知先到、投递记录后到”的情况。
  reconcilePendingEmails(market: 'cn' | 'us') {
    let applied = 0;
    for (const candidate of this.store
      .listCandidates('pending', market)
      .filter((item) => item.source === 'email')) {
      if (
        this.ingest({
          ...candidate,
          confidence: candidate.parsingConfidence ?? candidate.confidence,
        }).autoApplied
      )
        applied++;
    }
    return applied;
  }

  private applyAtomic(
    candidateId: string,
    selectedJobId?: string | null,
    overrides: Partial<Candidate> = {},
  ) {
    const original = this.store.getCandidate(candidateId);
    if (!original) throw new Error('CANDIDATE_NOT_FOUND');
    if (original.status !== 'pending') throw new Error('CANDIDATE_ALREADY_HANDLED');
    const candidate = {
      ...original,
      ...overrides,
      market: original.market,
      sourceRef: original.sourceRef,
    };
    let job =
      selectedJobId === null
        ? null
        : selectedJobId
          ? this.store.getJob(selectedJobId)
          : candidate.suggestedJobId
            ? this.store.getJob(candidate.suggestedJobId)
            : null;
    if (selectedJobId && !job) throw new Error('JOB_NOT_FOUND');
    if (job && job.market !== candidate.market) throw new Error('CROSS_MARKET_JOB');
    const jobBefore = job ? structuredClone(job) : null;
    let createdJob = false;
    if (!job) {
      if (!candidate.company || !candidate.position)
        throw new Error('COMPANY_AND_POSITION_REQUIRED');
      job = this.store.createJob({
        market: candidate.market,
        company: candidate.company,
        position: candidate.position,
        status: '已投递',
        source: candidate.source,
        externalApplicationId: candidate.externalApplicationId,
        progressUrls: candidate.url ? [candidate.url] : [],
      });
      createdJob = true;
    }
    const event = this.store.addEvent(job.id, {
      type: candidate.eventType,
      title: candidate.title,
      source: candidate.source,
      occurredAt: candidate.occurredAt,
      startsAt: candidate.startsAt,
      dueAt: candidate.dueAt,
      confidence: candidate.confidence,
      evidence: candidate.evidence,
      dedupeKey: candidate.sourceRef,
    });
    let taskId: string | null = null;
    const isReminder = /提醒|催办|再次通知|reminder|follow[- ]?up/i.test(
      `${candidate.title} ${candidate.evidence}`,
    );
    const matchingTask =
      isReminder && (candidate.dueAt || candidate.startsAt)
        ? job.tasks.find(
            (task) =>
              task.type === candidate.eventType &&
              task.dueAt === candidate.dueAt &&
              task.startsAt === candidate.startsAt,
          )
        : undefined;
    const nextStatus = matchingTask?.completedAt
      ? job.status
      : statusFor(candidate.eventType, job.status);
    const newerEvent = job.events.some(
      (item) =>
        Date.parse(item.occurredAt) > Date.parse(candidate.occurredAt) ||
        (item.completedAt && Date.parse(item.completedAt) > Date.parse(candidate.occurredAt)),
    );
    const obsolete =
      newerEvent ||
      ['已offer', '已拒绝', '流程结束'].includes(job.status) ||
      (nextStatus === job.status &&
        (candidate.eventType === 'application' ||
          (['面试中', 'AI面试中'].includes(job.status) &&
            ['assessment', 'ai_assessment', 'written_test'].includes(candidate.eventType))));
    if (
      event &&
      !obsolete &&
      ['assessment', 'ai_assessment', 'written_test', 'interview', 'ai_interview'].includes(
        candidate.eventType,
      )
    ) {
      if (!matchingTask) {
        const task = this.store.addTask(job.id, {
          eventId: event.id,
          type: candidate.eventType as TaskEventType,
          title: candidate.title,
          startsAt: candidate.startsAt,
          dueAt: candidate.dueAt,
        });
        taskId = task.id;
      }
    }
    const urls =
      candidate.url && !job.progressUrls.includes(candidate.url)
        ? [...job.progressUrls, candidate.url]
        : job.progressUrls;
    this.store.updateJob(job.id, {
      // 邮件标题和正文中的公司、岗位字段只是匹配线索，不能反向覆盖已维护好的岗位主数据。
      // 新建岗位时这些字段已经写入；命中已有岗位时始终保留原名称。
      company: job.company,
      position: job.position,
      externalApplicationId: candidate.externalApplicationId || job.externalApplicationId,
      progressUrls: urls,
      status: newerEvent ? job.status : nextStatus,
      ...((job.application?.dateSource === 'unknown' || !job.application?.dateSource) &&
      candidate.application &&
      (candidate.application.appliedAt || candidate.application.appliedOn)
        ? { application: { ...job.application!, ...candidate.application } }
        : {}),
      lastSyncedAt: new Date().toISOString(),
      syncHealth: 'ok',
    });
    this.store.setCandidateStatus(candidateId, 'applied');
    const after = this.store.getJob(job.id)!;
    this.store.audit('candidate_apply', 'job', job.id, jobBefore, after, {
      kind: 'undo_candidate',
      candidateId,
      jobId: job.id,
      createdJob,
      jobBefore,
      eventId: event?.id || null,
      taskId,
    });
    return after;
  }
}

function normalizeInput(
  input: CandidateInput,
  now: string,
  verifiedStoredCompany = false,
): CandidateInput {
  let company = input.company?.trim() || '';
  let position = input.position?.trim() || '';
  let confidence = Number.isFinite(input.confidence)
    ? Math.max(0, Math.min(1, input.confidence!))
    : 0.7;
  let externalApplicationId = input.externalApplicationId?.trim() || '';
  let sourceRef = input.sourceRef?.trim();
  // 兼容尚未重新加载的旧插件，移除从网页布局容器误提取的编号，并按岗位恢复独立去重键。
  if (input.source === 'website' && isPageContainerId(externalApplicationId)) {
    sourceRef = sourceRef?.replace(`:${externalApplicationId}:`, `:${position || company}:`);
    externalApplicationId = '';
  }
  if (input.source === 'email') {
    company = isUsefulCompanyCandidate(company) ? canonicalCompany(company) : '';
    position = isUsefulPositionCandidate(position) ? position : '';
    // 缺少岗位不等于通知不可靠；无效的显式字段仍降低解析置信度。
    confidence = Math.min(
      confidence,
      company ? (input.position?.trim() && !position ? 0.82 : 1) : 0.68,
    );
  }
  if (input.source === 'website' && isWebsitePositionMetadata(position)) {
    position = '';
    confidence = Math.min(confidence, 0.65);
  }
  const explicitEmployer =
    input.companySource === 'employer-field' ||
    input.companySource === 'manual' ||
    verifiedStoredCompany;
  if (
    input.source === 'website' &&
    (!company || (isRecruitmentPlatformCompany(company) && !explicitEmployer))
  ) {
    company = '';
    confidence = Math.min(confidence, 0.65);
  }
  return {
    ...input,
    company,
    position,
    externalApplicationId,
    url: input.url?.trim(),
    sourceRef,
    occurredAt: input.occurredAt || now,
    application:
      input.source === 'website' &&
      input.application &&
      (isInstant(input.application.appliedAt) || isDay(input.application.appliedOn))
        ? {
            appliedAt: isInstant(input.application.appliedAt) ? input.application.appliedAt : null,
            appliedOn: isDay(input.application.appliedOn) ? input.application.appliedOn : null,
            dateSource: 'website',
          }
        : undefined,
    confidence,
  };
}

function matchJob(jobs: Job[], input: CandidateInput): { job: Job; score: number } | null {
  // 公司身份不足时，即使旧记录、申请编号或整页 evidence 命中，也不能自动写入。
  if (input.source === 'website' && !input.company) return null;
  const isWebsiteListItem =
    input.source === 'website' &&
    (input.eventType === 'application' ||
      /^(?:application-card|beisen|alibaba):/.test(input.sourceRef || ''));
  const active = jobs
    .filter((job) => !['已拒绝', '流程结束'].includes(job.status))
    // 同公司同名岗位仍可对应不同志愿/申请。可信编号冲突时，后面的
    // 岗位名称匹配也不能把两条记录合并并覆盖原编号。
    .filter(
      (job) =>
        !(
          isWebsiteListItem &&
          input.externalApplicationId &&
          job.externalApplicationId &&
          !isPageContainerId(job.externalApplicationId) &&
          input.externalApplicationId !== job.externalApplicationId &&
          (!job.progressUrls.length ||
            Boolean(input.url && job.progressUrls.some((url) => sameOrigin(url, input.url!))))
        ),
    );
  if (input.externalApplicationId) {
    const exact = active.filter(
      (job) =>
        job.externalApplicationId &&
        job.externalApplicationId === input.externalApplicationId &&
        !isPageContainerId(job.externalApplicationId) &&
        (!input.company || sameCompany(job.company, input.company)) &&
        (input.source !== 'website' ||
          !input.url ||
          !job.progressUrls.length ||
          job.progressUrls.some((url) => sameOrigin(url, input.url!))) &&
        (input.eventType !== 'application' ||
          !input.position ||
          sameApplicationPosition(job, input.position)),
    );
    if (exact.length === 1) return { job: exact[0], score: 0.99 };
  }
  // 同一申请记录页可以同时列出多个岗位。已有外部申请编号时，
  // 编号不同就不能仅因 URL 相同而合并。
  if (
    input.url &&
    !input.externalApplicationId &&
    !isSharedProgressUrl(input.url) &&
    !isWebsiteListItem
  ) {
    const exactUrl = active.find((job) =>
      job.progressUrls.some((url) => stripUrl(url) === stripUrl(input.url!)),
    );
    if (exactUrl) return { job: exactUrl, score: 0.98 };
  }
  // 投递列表页可能同时包含多个岗位和不同进度；岗位缺失时，不能仅凭整页文本
  // 将拒绝、流程结束或 Offer 关联到旧岗位。明确的申请编号或单岗位 URL 已在上方处理。
  const unscopedTerminalWebsite =
    input.source === 'website' &&
    !input.position?.trim() &&
    ['rejection', 'ended', 'offer'].includes(input.eventType);
  if (unscopedTerminalWebsite) return null;
  const evidence = normalize(
    `${input.company || ''} ${input.position || ''} ${input.title || ''} ${input.evidence || ''}`,
  );
  const extractedCompany = normalizeCompany(input.company || '');
  const extractedPosition = normalizePosition(input.position || '');
  const scored = active
    .map((job) => {
      const aliases = companyAliases(job.company).map(normalize);
      const companyMention = aliases.some((alias) => alias.length >= 2 && evidence.includes(alias));
      const companySimilarity = Math.max(
        0,
        ...aliases.map((alias) => similarity(extractedCompany, alias)),
      );
      const jobPositions = positionAliases(job.position);
      const positionMention = jobPositions.some(
        (position) => position.length >= 3 && evidence.includes(position),
      );
      // 招聘系统常把公司/项目名前缀一起塞进“岗位名称”，比较前先剥离公司别名。
      const comparablePosition = aliases.reduce(
        (value, alias) => value.replaceAll(alias, ''),
        extractedPosition,
      );
      const inputPositions = [
        ...new Set([comparablePosition, ...positionAliases(input.position || '')]),
      ].filter(Boolean);
      const positionSimilarity = Math.max(
        positionMention ? 1 : 0,
        ...inputPositions.flatMap((candidate) =>
          jobPositions.map((position) => similarity(candidate, position)),
        ),
      );
      return { job, companyMention, companySimilarity, positionMention, positionSimilarity };
    })
    .sort(
      (a, b) =>
        Number(b.companyMention) - Number(a.companyMention) ||
        b.companySimilarity - a.companySimilarity ||
        b.positionSimilarity - a.positionSimilarity,
    );

  const companyMatched = scored.filter(
    (item) => item.companyMention || item.companySimilarity >= 0.94,
  );
  if (!companyMatched.length) return null;
  if (input.eventType === 'application') {
    // “商务管培生-研发方向”和“商务管培生-综合方向”共享前半段，仍是两个申请。
    // 新投递仅按完整岗位名称（清理公司/招聘批次后）关联，不能靠公共片段或模糊分数合并。
    const exact = companyMatched.filter((item) =>
      sameApplicationPosition(item.job, input.position || ''),
    );
    return exact.length === 1 ? { job: exact[0].job, score: 0.99 } : null;
  }
  if (companyMatched.length === 1) {
    const only = companyMatched[0];
    // 公司在正文中明确出现且只有一个未终结岗位时提供建议，解析置信度门槛由 ingest 检查。
    if (only.companyMention)
      return {
        job: only.job,
        score: only.positionMention ? 0.99 : only.positionSimilarity >= 0.55 ? 0.97 : 0.94,
      };
    if (only.companySimilarity >= 0.97 && only.positionSimilarity >= 0.65)
      return { job: only.job, score: 0.94 };
    return null;
  }
  const ranked = companyMatched.sort((a, b) => b.positionSimilarity - a.positionSimilarity);
  const best = ranked[0],
    second = ranked[1];
  if (best.positionMention && !second.positionMention) return { job: best.job, score: 0.99 };
  if (
    best.positionSimilarity >= 0.58 &&
    best.positionSimilarity - second.positionSimilarity >= 0.16
  )
    return { job: best.job, score: 0.95 };
  return null;
}

function isPageContainerId(value: string) {
  return /^(?:midas-view-content|root|app|__next|main|content|page|container)$/i.test(value);
}
function sameOrigin(a: string, b: string) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
function sameCompany(a: string, b: string) {
  const first = companyAliases(a).map(normalize),
    second = companyAliases(b).map(normalize);
  return first.some(
    (x) =>
      x.length >= 2 &&
      second.some((y) => y.length >= 2 && (x === y || x.includes(y) || y.includes(x))),
  );
}
function sameApplicationPosition(job: Job, position: string) {
  const aliases = companyAliases(job.company).map(normalize);
  const comparable = (value: string) =>
    aliases.reduce((result, alias) => result.replaceAll(alias, ''), normalizePosition(value));
  return Boolean(comparable(position)) && comparable(job.position) === comparable(position);
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/(?:有限责任)?公司|集团|校园招聘|招聘/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}
function normalizeCompany(value: string) {
  return normalize(companyCanonical(value));
}
function normalizePosition(value: string) {
  return normalize(value).replace(
    /20\d{2}届?|二七届|岗位|职位|校招|秋招|方向|北京|上海|深圳|杭州/g,
    '',
  );
}
function positionAliases(value: string) {
  const full = normalizePosition(value);
  const segments = (value.match(/[\p{Script=Han}]{3,}|[A-Za-z][A-Za-z0-9 ]{4,}/gu) || [])
    .map(normalizePosition)
    .filter((part) => part.length >= 3);
  return [...new Set([full, ...segments].filter(Boolean))];
}
function companyCanonical(value: string) {
  const key = normalize(value);
  const map: Record<string, string> = {
    jd: '京东',
    kuaishou: '快手',
    shopee: '虾皮',
    roche: '罗氏',
    alibabainc: '阿里巴巴',
    magictavern: '麦吉太文',
    mihoyo: 'mihoyo',
    米哈游: 'mihoyo',
    oppo: 'oppo',
    miniso名创优品: '名创优品',
  };
  return map[key] || value;
}
function companyAliases(value: string) {
  const canonical = companyCanonical(value);
  const key = normalize(canonical);
  const map: Record<string, string[]> = {
    mihoyo: ['mihoyo', '米哈游'],
    虾皮: ['虾皮', 'shopee'],
    麦吉太文: ['麦吉太文', 'magic tavern'],
    柠檬微趣: ['柠檬微趣', '北京柠檬微趣科技股份有限公司'],
    宝洁: ['宝洁', 'p&g', 'procter gamble'],
    京东: ['京东', 'jd'],
    快手: ['快手', 'kuaishou'],
    罗氏: ['罗氏', 'roche'],
    名创优品: ['名创优品', 'miniso'],
  };
  return map[key] || [canonical];
}
function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a))
    return Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.15;
  const setA = new Set(a),
    setB = new Set(b);
  const intersection = [...setA].filter((char) => setB.has(char)).length;
  return (intersection * 2) / (setA.size + setB.size);
}
function stripUrl(value: string) {
  try {
    const u = new URL(value);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return value;
  }
}
function isSharedProgressUrl(value: string) {
  try {
    const url = new URL(value);
    const route = `${url.pathname}${url.hash}`.toLowerCase();
    return (
      /\/personal\/(?:applications|deliveryrecord)\/?$/.test(url.pathname.toLowerCase()) ||
      url.pathname === '/personal' ||
      url.pathname === '/personal/' ||
      /(?:^|[/#])(?:mydeliver|applications?|deliveryrecord|scrd\/phase\/process|scrd\/delivery\/record)(?:[/?#]|$)/.test(
        route,
      )
    );
  } catch {
    return false;
  }
}
function titleFor(type: EventType) {
  return {
    application: '投递成功',
    assessment: '测评通知',
    ai_assessment: 'AI测评通知',
    written_test: '笔试通知',
    interview: '面试通知',
    ai_interview: 'AI面试通知',
    offer: 'Offer 通知',
    rejection: '未通过',
    ended: '流程结束',
    other: '进度更新',
  }[type];
}
function statusFor(type: EventType, current: JobStatus): JobStatus {
  if (
    ['已offer', '已拒绝', '流程结束'].includes(current) &&
    !['offer', 'rejection', 'ended'].includes(type)
  )
    return current;
  const ranks: Partial<Record<JobStatus, number>> = {
    待投递: 0,
    已投递: 1,
    测评中: 2,
    AI测评中: 2,
    笔试中: 3,
    面试中: 4,
    AI面试中: 4,
  };
  const stages: Partial<Record<EventType, JobStatus>> = {
    application: '已投递',
    assessment: '测评中',
    ai_assessment: 'AI测评中',
    written_test: '笔试中',
    interview: '面试中',
    ai_interview: 'AI面试中',
  };
  const target = stages[type];
  if (target && (ranks[current] ?? 0) > (ranks[target] ?? 0)) return current;
  return {
    application: '已投递',
    assessment: '测评中',
    ai_assessment: 'AI测评中',
    written_test: '笔试中',
    interview: '面试中',
    ai_interview: 'AI面试中',
    offer: '已offer',
    rejection: '已拒绝',
    ended: '流程结束',
    other: current,
  }[type] as JobStatus;
}
