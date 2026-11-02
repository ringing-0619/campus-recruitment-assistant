import type { CandidateInput, Job } from '../shared/types.js';
import { canonicalCompany, equalCompany, identityAliases } from './company-identity.js';

export interface EmailDecision {
  match: { job: Job; score: number } | null;
  allowCreate: boolean;
  reason: string;
}

// 岗位归一化只清理标签和招聘批次，保留城市、业务、研发/综合等区分申请的内容。
export function emailPositionKey(value: string, company = '') {
  let text = value
    .toLowerCase()
    .replace(/^(?:投递|申请|应聘)?(?:岗位|职位)(?:名称)?[：: \t]*/g, '')
    .replace(/[（(]\s*(?:j\d{3,}|job[-_ ]?\d+)\s*[）)]/gi, '')
    .replace(
      /(?:20)?\d{2}(?:\/\d{2})?届?(?:年)?(?:春季|秋季)?(?:校园招聘|校园|校招|秋招|春招)/g,
      '',
    )
    .replace(/(?:20)?\d{2}届/g, '')
    .replace(/^(?:20)?\d{2}\/\d{2}(?=\s|[-_])/g, '')
    .replace(/(?:校园招聘|校招|秋招)(?:岗位)?/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/(?:岗位|职位)$/g, '');
  for (const alias of identityAliases(company)) {
    const key = compact(alias);
    if (key && text.startsWith(key)) text = text.slice(key.length);
  }
  return text;
}

function compact(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
function flowKey(value: string) {
  const match = value
    .replace(/^market:us:/, '')
    .match(/^mail:<?\d+_(\d{2,})_(\d{4,})_\d+\.[^@>]+@shmail\.ibeisen\.com>?$/i);
  return match ? `ibeisen:${match[1]}:${match[2]}` : '';
}
function bilingualAliases(value: string, company: string) {
  const full = emailPositionKey(value, company);
  // “黑马工程 The Dark Horse Program”可与完整中文名对应，不能把“研发方向”切成独立岗位。
  const han = value.match(/[\p{Script=Han}]{3,}/gu) || [];
  return [
    ...new Set(
      [
        full,
        ...(/[A-Za-z]{3}/.test(value) && han.length === 1
          ? han.map((v) => emailPositionKey(v, company))
          : []),
      ].filter(Boolean),
    ),
  ];
}
function positionSimilarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a))
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const first = new Set(a),
    second = new Set(b);
  return ([...first].filter((char) => second.has(char)).length * 2) / (first.size + second.size);
}

function distinctRoleQualifiers(first: string, second: string) {
  const qualifiers = (value: string) =>
    [...value.matchAll(/[（(]([^）)]+)[）)]/g)]
      .map((match) => compact(match[1]))
      .filter((key) => key && !/^(?:j\d+|(?:20)?\d{2}(?:届|年)?(?:秋招|春招|校招)?)$/i.test(key));
  const a = qualifiers(first),
    b = qualifiers(second);
  return a.length > 0 && b.length > 0 && !a.some((key) => b.includes(key));
}

export function resolveEmailJob(jobs: Job[], input: CandidateInput): EmailDecision {
  const pending = (reason: string, job?: Job): EmailDecision => ({
    match: job ? { job, score: 0.85 } : null,
    allowCreate: false,
    reason,
  });
  if (!input.company) return pending('邮件缺少可靠的公司身份，无法确定所属申请');
  // 已终结的岗位也参与身份消歧，避免从候选集中删掉旧申请后错配到剩下的一个岗位。
  const scoped = jobs.filter((job) => equalCompany(job.company, input.company!));
  const inputKey = emailPositionKey(input.position || '', input.company);
  const exactRole = (job: Job) =>
    Boolean(inputKey) && bilingualAliases(job.position, job.company).includes(inputKey);
  const compatibleRole = (job: Job) => !inputKey || exactRole(job);
  const conflictingId = (job: Job) =>
    Boolean(
      input.externalApplicationId &&
      job.externalApplicationId &&
      input.externalApplicationId !== job.externalApplicationId,
    );
  if (input.externalApplicationId) {
    const byId = scoped.filter((job) => job.externalApplicationId === input.externalApplicationId);
    if (byId.length > 1) return pending('同公司多个岗位使用了相同编号，无法唯一关联');
    if (byId.length === 1) {
      if (!compatibleRole(byId[0])) return pending('申请编号与邮件中的岗位名称冲突');
      return { match: { job: byId[0], score: 0.99 }, allowCreate: false, reason: '' };
    }
  }
  const flow = flowKey(input.sourceRef || '');
  const refs = new Set(
    (input.relatedSourceRefs || []).map((ref) => ref.replace(/^market:us:/, '')),
  );
  const history = scoped.filter((job) =>
    job.events.some(
      (event) =>
        (flow && flowKey(event.dedupeKey) === flow) ||
        refs.has(event.dedupeKey.replace(/^market:us:/, '')),
    ),
  );
  if (history.length > 1) return pending('邮件会话同时关联多个岗位，需要选择具体申请');
  if (history.length === 1) {
    if (conflictingId(history[0])) return pending('历史邮件会话与本次申请编号冲突');
    if (!compatibleRole(history[0])) return pending('历史邮件会话与本次岗位名称冲突');
    return { match: { job: history[0], score: 0.99 }, allowCreate: false, reason: '' };
  }
  if (inputKey) {
    const exact = scoped.filter(exactRole);
    if (exact.length > 1) return pending('公司和岗位命中多条申请，无法唯一关联');
    if (exact.length === 1) {
      if (conflictingId(exact[0])) return pending('岗位相同但申请编号不同，需要核对申请');
      return { match: { job: exact[0], score: 0.99 }, allowCreate: false, reason: '' };
    }
    const ranked = scoped
      .map((job) => ({
        job,
        score: Math.max(
          ...bilingualAliases(job.position, job.company).map((key) =>
            positionSimilarity(inputKey, key),
          ),
        ),
      }))
      .sort((a, b) => b.score - a.score);
    // 模糊匹配只给建议；明确写了另一个岗位时绝不能降级为“公司唯一”自动更新。
    if (ranked[0]?.score >= 0.45) {
      // 完整投递回执明确给出不同业务/城市限定时，属于另一申请；
      // 不能因 Data Analyst 等公共词又把它卡成旧岗位的模糊匹配。
      if (
        input.eventType === 'application' &&
        scoped.every((job) => distinctRoleQualifiers(input.position!, job.position))
      )
        return { match: null, allowCreate: true, reason: '' };
      return pending('岗位名称只有部分相似，需要确认是否为同一申请', ranked[0].job);
    }
    if (scoped.length && input.eventType !== 'application')
      return pending('邮件中的岗位与已有岗位不一致');
    return {
      match: null,
      allowCreate: input.eventType === 'application',
      reason: input.eventType === 'application' ? '' : '未找到该公司和岗位的投递记录',
    };
  }
  // 用完整正文查找已有岗位，避免签名、长须知把岗位线索挤出 280 字摘要。
  const evidence = compact(input.positionHint || input.matchingText || input.evidence || '');
  const mentioned = scoped.filter((job) =>
    bilingualAliases(job.position, job.company).some(
      (key) => key.length >= 3 && evidence.includes(key),
    ),
  );
  if (mentioned.length === 1) {
    if (conflictingId(mentioned[0])) return pending('正文岗位与本次申请编号冲突');
    return { match: { job: mentioned[0], score: 0.97 }, allowCreate: false, reason: '' };
  }
  if (mentioned.length > 1) return pending('邮件提及同公司多个岗位，无法确定更新哪一条');
  if (input.eventType === 'application')
    return pending('投递回执缺少明确岗位，不能据此新建或合并申请');
  if (
    scoped.length === 1 &&
    !['待投递', '已拒绝', '流程结束', '已offer'].includes(scoped[0].status)
  ) {
    if (conflictingId(scoped[0])) return pending('申请编号与已有记录不一致');
    return { match: { job: scoped[0], score: 0.94 }, allowCreate: false, reason: '' };
  }
  return pending(
    scoped.length > 1
      ? `${canonicalCompany(input.company)}存在多个申请，邮件未提供可唯一关联的岗位或编号`
      : '未找到可关联的投递记录',
  );
}
