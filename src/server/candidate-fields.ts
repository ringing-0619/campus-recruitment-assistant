// 这些值描述邮件模板、招聘周期或流程，不是可用于建档的公司/岗位名称。
const GENERIC_NAME =
  /^(?:(?:我|本|贵|该|我们|你们|您)(?:的)?(?:公司|集团|企业|单位)(?:的)?(?:职位|岗位)?|公司|集团|企业|职位|岗位|年度|本年度|今年|本次|本次投递的岗位|相关岗位|招聘|校招|校园招聘|秋招|春招|反馈|筛选结果|简历|更多|相关|你好|您好|同学|关注|感谢|邀请|请|现|招聘动态|校园招聘动态)$/i;
const CAMPAIGN_ONLY =
  /^(?:20)?\d{2}(?:[-/—](?:20)?\d{2})?(?:届|年|年度)?(?:春季|秋季)?(?:招聘|校园招聘|校招)?$/;
const GENERIC_EMPLOYER = /^(?:我|本|贵|该|我们|你们|您)(?:的)?(?:公司|集团|企业|单位)/;
const TEMPLATE_TEXT =
  /此邮件|本邮件|系统(?:自动)?(?:发出|发送)|请勿|请不要|请注意|保密信息|声明[：:]|感谢|欢迎|您好|亲爱的|作答指引|问卷链接|完成(?:该|本次)?测评|流程.{0,12}(?:推迟|通知)|简历.{0,8}(?:收到|投递|提交|筛选)/i;
const MAIL_LABEL =
  /^(?:重要(?:邮件|提醒)?|紧急(?:邮件|提醒)?|必读|请查收|温馨提示|提示|提醒|通知|招聘系统|招聘平台|招聘通知|系统信函|系统通知|external(?: email)?|urgent|important|action required|(?:wintalent|hrtools)(?:[ ·-]*(?:招聘)?系统(?:信函|通知)?)?)$/i;

// 旧版网页插件可能把申请卡片的元数据当岗位提交；这些字段不能自动建档。
export function isWebsitePositionMetadata(value: string) {
  const text = value.trim();
  return (
    /^(?:第\s*\d+\s*志愿|志愿(?:信息|序号|顺序)?(?:[：:]|$)|(?:(?:招聘|投递|申请)(?:类型|项目|批次|编号|记录)|简历(?:名称|版本|信息))(?:[：:]|$))/.test(
      text,
    ) || /^20\d{2}(?:届|年)?(?:校园招聘|校招|春招|秋招|春季招聘|秋季招聘)$/.test(text)
  );
}

function isUsefulName(value: string) {
  const normalized = value.replace(/[\s「」“”【】\[\]]/g, '');
  return (
    normalized.length >= 2 &&
    /[\p{L}]/u.test(normalized) &&
    !GENERIC_NAME.test(normalized) &&
    !GENERIC_EMPLOYER.test(normalized) &&
    !CAMPAIGN_ONLY.test(normalized) &&
    !TEMPLATE_TEXT.test(normalized)
  );
}

export function isUsefulCompanyCandidate(value: string) {
  return (
    isUsefulName(value) &&
    !isRecruitmentPlatformCompany(value) &&
    !/通知|邀请|外部邮件|面试|笔试|测评|投递成功/.test(value) &&
    !MAIL_LABEL.test(value.trim()) &&
    !/^(?:external|no[- ]?reply|notification|updates?|news|careers?|recruitment|recruiting|workday|greenhouse|beisen|ibeisen|mokahr|italent)$/i.test(
      value.trim(),
    )
  );
}

// 与 extension/content.js 保持相同的精确平台身份规则。清理后再次校验，
// 避免“智联招聘”剥掉招聘二字后以“智联”绕过校验；不按子串误伤真实企业。
export function isRecruitmentPlatformCompany(value: string) {
  const name = value
    .trim()
    .replace(/[\s._·-]/g, '')
    .replace(/(?:官网|网站|平台|网)$/, '')
    .replace(/(?:(?:校园|社会)?招聘|校招)$/, '')
    .toLowerCase();
  return /^(?:智联(?:校园)?|zhaopin(?:com)?|前程无忧|51job(?:com)?|应届生(?:求职)?|yingjiesheng(?:com)?|boss直聘|boss|zhipin(?:com)?|猎聘|liepin(?:com)?|拉勾|lagou(?:com)?|实习僧|牛客|nowcoder(?:com)?|workday|myworkdayjobs|greenhouse|lever|ashby|moka|mokahr|北森|beisen|ibeisen|italent|hotjob|飞书|feishu|smartrecruiters|icims|taleo|successfactors)$/.test(
    name,
  );
}

export function isUsefulPositionCandidate(value: string) {
  const normalized = value.replace(/\s/g, '');
  return (
    isUsefulName(value) &&
    isUsefulName(normalized.replace(/(?:的)?(?:职位|岗位)$/, '')) &&
    !/^(?:within\b|(?:and\s+)?(?:we|our team|you|your application)\b|(?:if|please|thank you)\b|in\s+(?:corporate|our|the)\b)/i.test(
      value.trim(),
    ) &&
    !/^(?:在线|综合|通用|人才|性格|能力|年度|校招)*(?:测评|评估|测试|问卷)(?:通知|邀请)?$/.test(
      normalized,
    )
  );
}
