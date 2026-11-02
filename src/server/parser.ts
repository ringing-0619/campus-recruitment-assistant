import type { CandidateInput, EventType } from '../shared/types.js';
import { isUsefulCompanyCandidate, isUsefulPositionCandidate } from './candidate-fields.js';
import { canonicalCompany, companyFromAddress } from './company-identity.js';

// 拒信是终态信号：即使同一封邮件同时回顾了“感谢投递”，也应由明确的未通过结论决定类型。
const REJECTION_RULE =
  /(?:很|非常|十分)?遗憾(?:地)?(?:通知|告知)|(?:未能通过|未通过)(?:.{0,24}(?:筛选|评估|审核|考察|申请|应聘|面试|笔试|测评|选拔|流程))?|(?:筛选|评估|审核|考察|申请|应聘|面试|笔试|测评|选拔).{0,24}(?:未能通过|未通过)|(?:你|您|候选人|简历|申请|应聘|岗位|职位|需求).{0,40}(?:暂不匹配|不匹配|暂未达成.{0,12}匹配|未达成.{0,12}匹配)|(?:暂不匹配|不匹配).{0,24}(?:岗位|职位|需求|申请|应聘)|(?:不再|不会|无法).{0,24}(?:推进|进入).{0,24}(?:流程|环节)|无法进入后续|终止.{0,45}(?:招聘|应聘)流程|(?:被拒|拒绝|淘汰)(?:通知|邮件|申请|应聘)|拒信/i;

// 前程无忧回执用“简历已发送至简历数据库”确认投递，不一定出现“投递成功”。
const RESUME_RECEIPT_RULE =
  /(?:您|你)的简历(?:已经|已)(?:成功)?(?:被)?(?:发送|提交|收录|存入|录入)(?:至|到|进|于)?(?:我们|我司|本公司)?的?简历(?:数据库|库)/i;

const EVENT_RULES: Array<[EventType, RegExp]> = [
  ['rejection', REJECTION_RULE],
  [
    'application',
    /投递成功|感谢(?:你|您)?投递|简历(?:已|成功)?投递|简历已提交|简历.{0,12}(?:抵达|到达|收到).{0,8}招聘系统|我们已收到(?:你|您)?的?申请|已成功完成简历提交|申请成功/i,
  ],
  [
    'ai_interview',
    /(?:AI|人工智能|智能|数字人)[\s在线视频机器人]*(?:面试|面谈)|(?:面试|面谈)[\s在线视频机器人]*(?:AI|人工智能|数字人)|AI\s*interview/i,
  ],
  [
    'ai_assessment',
    /(?:AI|人工智能|智能)[\s在线]*(?:测评|评估|测试)|(?:测评|评估|测试)[\s在线]*(?:AI|人工智能)|AI\s*assessment/i,
  ],
  ['written_test', /笔试|在线考试|written\s*test/i],
  ['assessment', /测评|人才评估|性格测试|assessment/i],
  ['interview', /面试|面谈|interview/i],
  [
    'offer',
    /offer\s*(?:通知|已发放|已收到|阶段|状态)|(?:收到|获得|发放|接受|恭喜.{0,12})(?:正式\s*)?offer|录用通知|录取通知/i,
  ],
  ['ended', /流程结束|申请关闭|招聘结束/i],
];

const RECRUITMENT_HINT =
  /招聘|校招|校园招聘|应聘|候选人|职位|岗位|面试|笔试|测评|人才评估|投递|申请进度|简历|\b(?:job|career|recruit(?:ing|ment)?|candidate|interview|assessment|application)\b/i;

export function isLikelyRecruitmentMail(subject: string, from: string) {
  if (isNonProgressRecruitmentMail(subject, subject)) return false;
  // 头部只负责召回：泛化主题可由招聘发件人进入正文判断，但不能据此建档。
  return (
    RECRUITMENT_HINT.test(`${subject} ${from}`) ||
    /录用|录取通知|申请结果|application update|offer letter|thank you for applying|thank you for your application/i.test(
      subject,
    ) ||
    /(?:^|[<\s])(?:hr|careers?|recruit(?:ment|ing)?|jobs?|talent)[^@ <>]*@/i.test(from) ||
    /@(?:[a-z0-9-]+\.)*(?:ibeisen\.com|italent\.cn|mokahr\.com|hire\.feishu\.cn|myworkday\.com|greenhouse\.io|lever\.co|hrtools\.cn|51job\.com)[>\s,]/i.test(
      `${from} `,
    ) ||
    Boolean(companyFromAddress(from))
  );
}

export function classifyEvent(text: string): EventType {
  return (
    EVENT_RULES.find(
      ([type, rule]) =>
        rule.test(text) || (type === 'application' && RESUME_RECEIPT_RULE.test(text)),
    )?.[0] || 'other'
  );
}

export function parseRecruitmentMessage(input: {
  subject: string;
  from: string;
  text: string;
  receivedAt: Date;
  messageId: string;
  relatedMessageIds?: string[];
}): CandidateInput | null {
  const cleaned = currentMessageText(cleanup(input.text));
  const combined = `${input.subject}\n${cleaned}`;
  // 这些邮件与求职有关，但本身不代表岗位进度变化，不应占用“待确认”。
  if (isNonProgressRecruitmentMail(input.subject, combined)) return null;
  const subjectType = classifyEvent(input.subject);
  // 主题通常比正文中的“后续面试”等背景描述更可靠，但明确拒信必须覆盖主题中的“感谢投递”。
  const eventType = emailEvent(input.subject, cleaned, subjectType);
  // 求职内容不等于个人申请进度；没有实际阶段信号就不生成待确认。
  if (eventType === 'other') return null;
  if (
    eventType === 'application' &&
    !/招聘|校招|应聘|候选人|职位|岗位|面试|笔试|投递|简历|\b(?:job|career|recruit(?:ing|ment)?|candidate|interview|hiring|employment|position|role)\b/i.test(
      `${combined}\n${input.from}`,
    )
  )
    return null;
  const companyMatch = extractCompany(input.subject, cleaned, input.from);
  const company = companyMatch.value;
  // 独立解析主题和正文，避免主题末尾的“职位”把下一行模板说明当成字段值。
  const positionMatch = extractPosition(input.subject) || extractPosition(cleaned);
  const position = positionMatch?.value || '';
  const applicationId = extractApplicationId(combined);
  const dates = extractDates(combined, input.receivedAt, { relativeToReceipt: true });
  // 岗位缺省交给已有申请关联，不再把可靠的通知统一压到 82%。
  // 弱测评名称仍然只是线索，不能据其自动新建岗位。
  const baseConfidence = Math.min(0.95, companyMatch.confidence);
  return {
    source: 'email',
    sourceRef: `mail:${input.messageId}`,
    company,
    externalApplicationId: applicationId,
    eventType,
    title: eventTitle(eventType, input.subject),
    occurredAt: input.receivedAt.toISOString(),
    startsAt: dates.startsAt,
    dueAt: dates.dueAt,
    evidence: truncate(`${input.subject} · ${cleaned}`, 280),
    confidence: baseConfidence,
    positionHint: positionMatch?.confidence === 0.82 ? position : undefined,
    position: positionMatch?.confidence === 0.82 ? '' : position,
    matchingText: combined,
    relatedSourceRefs: input.relatedMessageIds?.map((id) => `mail:${id}`),
  };
}

function isNonProgressRecruitmentMail(subject: string, combined: string) {
  if (/^(?:自动答复|automatic reply|auto(?:matic)? reply|out of office)[:：]/i.test(subject))
    return true;
  if (
    /租房申请|贷款申请|信用卡申请|签证申请|入学申请|账号申请|loan application|credit card application|rental application|visa application|admission (?:application|offer)|property assessment|tax assessment|health assessment/i.test(
      subject,
    )
  )
    return true;
  if (/survey.{0,30}reward|reward.{0,30}survey/i.test(subject)) return true;
  // 按邮件目的排除。课程广告和宣讲中也会大量出现“面试/测评/offer”。
  if (
    /宣讲会|空中宣讲|直播|岗位专场|招聘专场|雇主品牌活动|验证候选人账户|关联.{0,15}候选人.{0,15}账户|候选人账户(?:设置|验证|激活)|验证码|密码重置|重置密码|账户激活|job alerts?|recommended jobs?|jobs? (?:for you|recommendations)|newsletter|招聘周报|职位推荐|岗位推荐|招聘资讯|求职资讯/i.test(
      subject,
    )
  )
    return true;
  if (
    /special offer|bonus offer|cash back|lease renewal|earn.{0,12}points|会员优惠|限时优惠|限时折扣|促销|优惠券|免费试听|课程(?:优惠|报名|推荐)|面试(?:攻略|技巧|宝典)|笔试(?:攻略|题库)|测评(?:攻略|题库)|求职(?:课程|训练营)|offer收割|如何.{0,12}(?:面试|offer)|survey.{0,30}reward|reward.{0,30}survey/i.test(
      subject,
    )
  )
    return true;
  return (
    /(?:测评|面试|笔试).{0,12}(?:课程|培训(?!生)|训练营|备考|辅导)|(?:课程|培训(?!生)|训练营).{0,12}(?:测评|面试|笔试)/i.test(
      subject,
    ) ||
    /(?:立即购买|扫码购买|限时特惠|购买课程|buy now|shop now)|(?:survey|问卷).{0,40}(?:reward|gift card|奖励|红包|积分)/i.test(
      combined,
    )
  );
}

function emailEvent(subject: string, body: string, subjectType: EventType): EventType {
  // 通用须知中的“未通过则结束”不是拒信；引用的旧通知也不决定当前进度。
  const current = body
    .split(/\n/)
    .flatMap((line) => line.split(/(?<=[。；;！!])/))
    .filter(
      (line) =>
        !/^(?:\s*(?:如果|若|如未|如您|注意|说明|温馨提示))|(?:if you|candidates? who).{0,50}(?:fail|unsuccessful)|(?:后续|未来).{0,12}(?:安排|通知)|(?:未通过|不匹配).{0,16}(?:则|将会|将被)/i.test(
          line,
        ),
    )
    .join('\n');
  const combined = `${subject}\n${current}`;
  const employmentContext =
    /简历|应聘|岗位|职位|投递|申请|招聘|校招|面试|笔试|测评|筛选|选拔|候选人|\b(?:application|candidate|position|role|interview|recruit(?:ing|ment)?|hiring|employment)\b/i.test(
      combined,
    );
  if (
    employmentContext &&
    (REJECTION_RULE.test(combined) ||
      /(?:we regret|unfortunately).{0,160}(?:application|candidate|proceed|move forward|selected)|(?:not|no longer).{0,25}(?:mov(?:e|ing) forward|proceed(?:ing)?|selected)|application.{0,40}unsuccessful|(?:decided|chosen).{0,35}(?:move forward|proceed).{0,25}(?:another|other) candidate|(?:position|role).{0,20}has been filled/is.test(
        combined,
      ))
  )
    return 'rejection';
  if (
    /录用通知|录取通知|offer\s*(?:letter|of employment)|(?:pleased|delighted).{0,35}offer you.{0,30}(?:position|role)/i.test(
      combined,
    ) ||
    (employmentContext &&
      /offer\s*(?:通知|已发放)|(?:收到|获得|发放|接受).{0,6}offer/i.test(combined))
  )
    return 'offer';
  const strongSubject =
    /(?:测评|评估|笔试|考试|面试|面谈).{0,8}(?:通知|邀请|安排|提醒|链接)|(?:邀请|请参加|请完成).{0,60}(?:测评|笔试|面试)|(?:invitation|invite|reminder).{0,45}(?:assessment|interview|test)|(?:assessment|interview).{0,25}(?:invitation|scheduled|reminder)/i.test(
      subject,
    );
  if (strongSubject && subjectType !== 'other' && subjectType !== 'application') return subjectType;
  const action =
    combined.match(
      /(?:邀请(?:你|您)?|请(?:你|您)?|您(?:已|已经)?(?:进入|通过)|你(?:已|已经)?进入|现通知).{0,70}(?:完成|参加|参与|进入|预约|安排|接受|进行|测评|笔试|面试)[^。；;\n]{0,90}|(?:you (?:are invited|have been invited)|(?:please|we invite you to).{0,40}(?:complete|take|attend|schedule|participate))[^.\n]{0,130}/gi,
    ) || [];
  for (const text of action) {
    const type = classifyEvent(text);
    if (['assessment', 'ai_assessment', 'written_test', 'interview', 'ai_interview'].includes(type))
      return type;
  }
  if (
    subjectType === 'application' ||
    /thank you for (?:applying|your application)|application (?:received|submitted|confirmation)/i.test(
      subject,
    ) ||
    RESUME_RECEIPT_RULE.test(current) ||
    /投递成功|简历(?:已|成功)?投递|简历已提交|已成功完成简历提交|(?:我们|我司).{0,8}(?:已|已经)?收到.{0,12}(?:申请|简历)|感谢(?:你|您)?.{0,3}投递|感谢您申请|thank you for applying|we (?:have )?received.{0,35}(?:your )?application|application (?:has been )?(?:received|submitted)/i.test(
      combined,
    )
  )
    return 'application';
  if (
    subjectType === 'ended' ||
    /(?:您的|你的|your).{0,30}(?:申请.{0,8}关闭|流程.{0,8}结束|application.{0,8}closed)/i.test(
      combined,
    )
  )
    return 'ended';
  return 'other';
}

function currentMessageText(value: string) {
  return (
    value
      .split(
        /\n\s*(?:[-_]{2,}\s*(?:Original Message|原始邮件|转发邮件)|On [^\n]+wrote:|在[^\n]+写道[:：]|原邮件内容[:：]|(?:From|发件人)[:：][^\n]+\n\s*(?:Sent|发送时间|Date)[:：])/i,
      )[0]
      .split('\n')
      .filter((line) => !/^\s*>/.test(line))
      .join('\n')
      // 回执后的推荐区不属于本次申请；HTML转文本后标题也可能跟在句末。
      .split(
        /(?:^|\n|[。.!！][ \t]+)(?:猜你喜欢|推荐职位|推荐岗位|recommended jobs(?: for you)?|jobs you may like)(?=[ \t:：\n]|$)/i,
      )[0]
      .trim()
  );
}

export function parseWebsiteSnapshot(input: {
  url: string;
  title: string;
  text: string;
  capturedAt?: string;
  company?: string;
  position?: string;
}): CandidateInput | null {
  const cleaned = cleanup(input.text);
  const eventType = classifyEvent(`${input.title}\n${cleaned}`);
  if (eventType === 'other') return null;
  const titleCompany = canonicalCompany(
    input.title.match(/^([^|_\-]{2,60})\s*[|_-]/)?.[1]?.trim() || '',
  );
  // 显式雇主字段优先，标题片段仅兜底；“投递进程_我的校园_智联招聘”不代表公司。
  const usefulCompany = (value: string) =>
    isUsefulCompanyCandidate(value) &&
    !/^(?:投递进程|投递结果|申请进程|申请结果|我的校园|我的投递|我的申请|个人中心|投递记录|申请记录|首页)$/.test(
      value.trim(),
    );
  const parsedCompany = extractCompany('', cleaned, '').value;
  const company =
    [
      input.company || '',
      parsedCompany,
      extractCompany(input.title, '', '').value,
      titleCompany,
    ].find(usefulCompany) || '';
  const position =
    input.position || (extractPosition(input.title) || extractPosition(cleaned))?.value || '';
  const dates = extractDates(cleaned, new Date(input.capturedAt || Date.now()));
  return {
    source: 'website',
    sourceRef: '',
    company,
    position,
    url: input.url,
    eventType,
    title: eventTitle(eventType),
    occurredAt: input.capturedAt || new Date().toISOString(),
    startsAt: dates.startsAt,
    dueAt: dates.dueAt,
    evidence: truncate(cleaned, 280),
    confidence: eventType === 'application' && company && position ? 0.96 : company ? 0.9 : 0.72,
  };
}

export function extractDates(
  text: string,
  reference = new Date(),
  options: { relativeToReceipt?: boolean } = {},
) {
  const year = reference.getFullYear();
  const range = text.match(
    /(?:测评|笔试|面试|考试)?时间[：:\s]*从\s*([^\s。；;]{4,22}(?:\s+\d{1,2}[:：]\d{2})?)\s*到\s*([^\s。；;]{4,22}(?:\s+\d{1,2}[:：]\d{2})?)/i,
  );
  const deadlineContext =
    text.match(/(?:截止(?:时间|日期)?|请于|有效期至|完成时间)[：:\s]*([^。；;\n]{0,45})/i)?.[1] ||
    '';
  // “开始测评”是入口按钮，不能从它后面的项目落款提取开始日期。
  const startContext =
    text.match(
      /(?:开始(?:时间|日期)|开放时间|面试时间|考试时间|测评时间|开始(?=[：:]))[：: \t]*([^。；;\n]{0,45})/i,
    )?.[1] || '';
  return {
    startsAt: parseDate(range?.[1] || startContext, reference, year),
    dueAt:
      parseDate(range?.[2] || deadlineContext, reference, year) ||
      (options.relativeToReceipt ? relativeMailDeadline(text, reference) : null),
  };
}

function relativeMailDeadline(text: string, receivedAt: Date): string | null {
  // 只用邮件明确给出的完成期限；作答时长、客服响应和点击后才起算的期限均不能锚定收件时刻。
  for (const sentence of text.split(/[。；;！!\n]/)) {
    if (
      /^\s*(?:如果|若|假如)|(?:点击|开始|进入|登录|激活|作答|答题).{0,15}(?:后|起)/i.test(sentence)
    )
      continue;
    const duration =
      sentence.match(
        /(?:测评|笔试|考试|面试|链接)(?:的)?有效期(?:限)?(?:为|是)?[：: \t]*(\d{1,3}(?:\.\d+)?)[ \t]*(小时|天)/,
      ) ||
      sentence.match(
        /(?:请|需|须|务必)(?:你|您)?(?:于|在)[：: \t]*(\d{1,3}(?:\.\d+)?)[ \t]*(小时|天)内[^。；;\n]{0,20}(?:完成|提交)[^。；;\n]{0,10}(?:测评|笔试|考试|面试|答题|答卷|问卷)/,
      );
    if (!duration) continue;
    const elapsed = Number(duration[1]) * (duration[2] === '小时' ? 3600_000 : 864e5);
    if (elapsed > 0 && Number.isFinite(receivedAt.getTime()))
      return new Date(receivedAt.getTime() + elapsed).toISOString();
  }
  return null;
}

function parseDate(value: string, reference: Date, fallbackYear: number): string | null {
  if (!value) return null;
  const iso = value.match(
    /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:\s*(\d{1,2})[:：](\d{2}))?/,
  );
  const short = value.match(/(?<!\d)(\d{1,2})[-/.月](\d{1,2})(?:日)?(?:\s*(\d{1,2})[:：](\d{2}))?/);
  const match = iso || short;
  if (!match) return null;
  const explicitYear = Boolean(iso);
  const y = explicitYear ? Number(match[1]) : fallbackYear;
  const offset = explicitYear ? 0 : -1;
  const month = Number(match[2 + offset]);
  const day = Number(match[3 + offset]);
  const hour = Number(match[4 + offset] || 23);
  const minute = Number(match[5 + offset] || 59);
  let result = new Date(y, month - 1, day, hour, minute, 0);
  if (!explicitYear && result.getTime() < reference.getTime() - 60 * 864e5)
    result = new Date(y + 1, month - 1, day, hour, minute, 0);
  return Number.isNaN(result.getTime()) ? null : result.toISOString();
}

function extractCompany(subject: string, body: string, from: string) {
  // 明确的雇主字段优先于招聘平台放在主题里的品牌。
  for (const match of `${subject}\n${body}`.matchAll(
    /(?:^|[\n,，。；; ])(?:(?:公司|雇主)[：: \t]+|(?:company|employer)[ \t]*[：:][ \t]*)([^\n,，。；;]{2,60}?)(?=\s+(?:职位|岗位|position|job title|role)[:：]|$|\n|[,，。；;])/gim,
  )) {
    const value = canonicalCompany(match[1]);
    if (isUsefulCompanyCandidate(value)) return { value, confidence: 0.95 };
  }
  const title = employerSubject(subject);
  const patterns = [
    /[【\[]\s*([^】\]]{2,30})\s*[】\]]/g,
    // 招聘平台模板常以“公司名 + 2027届 + 校园招聘”开头；年份不应让公司提取落到页脚的“更多校园招聘”。
    /^([A-Za-z\u4e00-\u9fa5·&（）()\-]{2,30}?)(?=(?:20\d{2}|\d{2}\/\d{2})届?(?:春季|秋季)?(?:校园招聘|校招)|(?:校园招聘|校招))/g,
    /(?:^|[】\]：:])\s*([\p{L}\p{N}·&（）() -]{2,40}?)(?=邀请(?:你|您)(?:参加|参与|完成))/gu,
  ];
  const bodyPatterns = [
    /(?:来自|(?:感谢)?投递|(?:感谢你|感谢您)对)([\u4e00-\u9fa5A-Za-z&· ]{2,35}?)(?=邀请(?:你|您)|的应聘|校园招聘|校招|\s*[,，]现邀请)/g,
    /公司[：: \t]+([A-Za-z一-龥&· ]{2,40}?)(?=\s+职位|[,，。；;\n]|$)/gi,
    /(?:感谢您(?:申请|投递|关注)|欢迎参加|来自)[「“]?([\u4e00-\u9fa5A-Za-z0-9·&（）()\-]{2,30})[」”]?(?:公司|集团)?(?:的|校园招聘|招聘)/g,
    /(?:请参加|感谢.{0,8}?投递|感谢(?:你|您)?(?:应聘|申请)|投递|参加|申请|应聘)[ \t]*([\u4e00-\u9fa5A-Za-z·&]{2,24}?)(?=20\d{2})/g,
    /([\u4e00-\u9fa5A-Za-z·&]{2,24}?)(?=校园招聘|校招)/g,
  ];
  for (const [text, rules] of [
    [title, patterns],
    [title, bodyPatterns],
    [body, bodyPatterns],
  ] as const) {
    for (const pattern of rules) {
      for (const match of text.matchAll(pattern)) {
        const value = canonicalCompany(match[1].replace(/(?:校园招聘|校招|招聘)$/, '').trim());
        if (isUsefulCompanyCandidate(value)) return { value, confidence: 0.95 };
      }
    }
  }
  const englishContext = `${subject}\n${body}`;
  const careerCompany = englishContext.match(
    /(?:a career at|working at)[ \t]+([A-Za-z][A-Za-z0-9 &.'-]{1,55}?)(?=[.!\n]|$|\s+(?:for|has|is|was)\b)/i,
  )?.[1];
  const applicationCompany =
    careerCompany ||
    englishContext.match(
      /(?:thank you for applying to|your application to)[ \t]+([A-Za-z][A-Za-z0-9 &.'-]{1,55}?)(?=[.!\n]|$|\s+(?:for|has|is|was)\b)/i,
    )?.[1];
  if (
    applicationCompany &&
    !/^(?:the|our|a|an)\b|\b(?:position|role|associate|analyst|engineer|internship|program|programme)\b/i.test(
      applicationCompany,
    ) &&
    isUsefulCompanyCandidate(applicationCompany)
  )
    return { value: canonicalCompany(applicationCompany), confidence: 0.95 };
  const englishCompany = `${subject}\n${body}`
    .match(
      /(?:company|employer)[ \t]*[：:][ \t]*([^\n,，;；]{2,60}?)(?=\s+(?:position|job title|role)[:：]|$|\n)/im,
    )?.[1]
    ?.trim();
  if (englishCompany && isUsefulCompanyCandidate(englishCompany))
    return { value: canonicalCompany(englishCompany), confidence: 0.95 };
  const signature = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      /^(?:[\p{L}\p{N}·&（）() -]{2,45})(?:股份有限公司|有限责任公司|有限公司)$/u.test(line),
    );
  if (signature.length === 1) return { value: canonicalCompany(signature[0]), confidence: 0.95 };
  const sender = from.match(/^\s*"?([^"<>]{2,60}?)"?\s*</)?.[1]?.trim() || '';
  if (/(?:校园招聘|校招|招聘团队|招聘|\bcareers?\b|\brecruit(?:ment|ing)?\b)/i.test(sender)) {
    const value = canonicalCompany(
      sender.replace(/\b(?:careers?|recruitment|recruiting|team)\b/gi, '').trim(),
    );
    if (
      isUsefulCompanyCandidate(value) &&
      !/^(?:校园|人才|人力资源|hr|notice|italent|workday|greenhouse|moka|beisen)$/i.test(value)
    )
      return { value, confidence: 0.95 };
  }
  const known = companyFromAddress(from);
  if (known) return { value: known, confidence: 0.95 };
  return { value: '', confidence: 0.68 };
}

function employerSubject(subject: string) {
  let value = subject.trim();
  while (value) {
    const reply = value.match(/^(?:re|fw|fwd|回复|转发)[：:]\s*/i);
    const label = value.match(/^[【\[]([^】\]\n]{1,60})[】\]]\s*/);
    if (reply) value = value.slice(reply[0].length);
    else if (label && !isUsefulCompanyCandidate(canonicalCompany(label[1])))
      value = value.slice(label[0].length);
    else break;
  }
  return value;
}

function extractPosition(text: string) {
  const patterns = [
    /(?:job title|position|role)(?: applied for)?[ \t]*[：:][ \t]*([^\n,，;；]{2,120}?)(?=\s+(?:company|application (?:id|number))[:：]|$|\n)/im,
    /(?:applying for|applying to the|your application for|you applied for)\s+(?:the\s+)?([^.!;]{2,200}?)\s+(?:position|role)\b/is,
    /(?:你|您)(?:与|和)(?:本次(?:秋招|校招)\s*)?[「“【]?([^」”】，,。；;\n]{2,45}?)[」”】]?\s*(?:岗位|职位)?(?:的)?(?:需求)?(?:暂未达成|未达成|暂不匹配|不匹配)/i,
    /职位[：: \t]+([^，,。；;\n]{2,45}?)(?=\s+(?:结果|岗位编号|申请编号)|$)/i,
    /(?:投递|应聘|申请)[^\n。！!？?]{0,100}?[【「“]([^】」”\n]{2,120})[】」”]\s*(?:职位|岗位)/i,
    /(?:申请|应聘|投递)(?:了)?(?:我公司|本公司)(?:的)?[ \t]*([^，,。；;！!\n]{2,45}?(?:职位|岗位))(?=\s|[,，。；;！!]|$)/i,
    /(?:申请|应聘|投递)(?:了)?(?:的)?[：:\s「“【]*([^」”】,，。；;！!\n]{2,45}?(?:职位|岗位))(?=\s|[,，。；;！!]|$)/i,
    /(?:职位|岗位)(?:名称)?[：: \t]+([^，,。；;\n]{2,45})/i,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(new RegExp(pattern.source, 'gi'))) {
      const cleaned = match[1]
        .replace(/(?:已成功|的申请|[ \t]+(?:您|你)的简历).*$/, '')
        .replace(/\*+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (isUsefulPositionCandidate(cleaned)) return { value: cleaned, confidence: 0.95 };
    }
  }
  // 测评/考试名称可能只是题库或招聘项目名，保留线索但不当成可靠岗位。
  const assessmentName = text
    .match(
      /(?:面试名称|测评名称|考试名称)[：: \t]*(?:\d{2}[A-Za-z]+[-_—])?([^，,。；;\n]{2,45})/i,
    )?.[1]
    ?.trim();
  return assessmentName && isUsefulPositionCandidate(assessmentName)
    ? { value: assessmentName, confidence: 0.82 }
    : null;
}

function extractApplicationId(text: string) {
  return (
    text.match(
      /(?:(?:申请|应聘)(?:编号|ID|号)|application (?:id|number))[：: \t#]*([A-Z0-9_-]{4,40})/i,
    )?.[1] || ''
  );
}

function eventTitle(type: EventType, fallback = '') {
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
    other: fallback || '招聘进度更新',
  }[type];
}

function cleanup(value: string) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n(?: *\n){2,}/g, '\n\n')
    .trim();
}
function truncate(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}
