// 解析和匹配共用身份表；只收录明确的品牌/主体关系，平台域名不代表雇主。
const COMPANY_NAMES: Record<string, string[]> = {
  京东: ['京东', 'jd'],
  快手: ['快手', 'kuaishou'],
  虾皮: ['虾皮', 'shopee'],
  罗氏: ['罗氏', 'roche'],
  麦吉太文: ['麦吉太文', 'magic tavern', 'magictavern'],
  米哈游: ['米哈游', 'mihoyo'],
  名创优品: ['名创优品', 'miniso', 'MINISO名创优品'],
  宝洁: ['宝洁', 'P&G', 'Procter & Gamble'],
  库洛: ['库洛', '库洛游戏', 'kurogames'],
  华宝新能: ['华宝新能', '深圳市华宝新能源股份有限公司'],
  阿里巴巴: ['阿里巴巴', 'alibabainc'],
  叠纸游戏: ['叠纸游戏', 'papergames', 'papegames'],
  柠檬微趣: ['柠檬微趣', '北京柠檬微趣科技股份有限公司'],
};

export function companyKey(value: string) {
  return value
    .toLowerCase()
    .replace(/(?:20\d{2}|\d{2}\/\d{2})届?(?:春季|秋季)?(?:校园招聘|校园|校招).*$/g, '')
    .replace(/(?:校园招聘|校园招募|校招|招聘团队|招聘|人才招聘)$/g, '')
    .replace(
      /(?:股份有限公司|有限责任公司|有限公司|集团|公司|\b(?:incorporated|inc|llc|ltd|limited)\b)[.。]?$/gi,
      '',
    )
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function canonicalCompany(value: string) {
  const key = companyKey(value);
  for (const [name, aliases] of Object.entries(COMPANY_NAMES)) {
    if (aliases.some((alias) => companyKey(alias) === key)) return name;
  }
  return value
    .trim()
    .replace(/(?:20\d{2}|\d{2}\/\d{2})届?(?:春季|秋季)?(?:校园招聘|校园|校招).*$/g, '')
    .replace(/(?:校园招聘|校招|招聘团队|招聘)$/g, '');
}

export function equalCompany(a: string, b: string) {
  const key = companyKey(canonicalCompany(a));
  return key.length >= 2 && key === companyKey(canonicalCompany(b));
}

export function identityAliases(value: string) {
  const canonical = canonicalCompany(value);
  return COMPANY_NAMES[canonical] || [value];
}

export function companyFromAddress(from: string) {
  const host = from.match(/@([a-z0-9.-]+\.[a-z]{2,})(?:[>\s,]|$)/i)?.[1]?.toLowerCase() || '';
  const domains: Record<string, string> = {
    'jd.com': '京东',
    'kuaishou.com': '快手',
    'shopee.com': '虾皮',
    'roche.com': '罗氏',
    'kurogames.com': '库洛',
    'mihoyo.com': '米哈游',
    'miniso.com': '名创优品',
    'pg.com': '宝洁',
    'papergames.com': '叠纸游戏',
    'papegames.com': '叠纸游戏',
  };
  return (
    Object.entries(domains).find(
      ([domain]) => host === domain || host.endsWith(`.${domain}`),
    )?.[1] || ''
  );
}
