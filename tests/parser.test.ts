import { describe, expect, it } from 'vitest';
import {
  classifyEvent,
  extractDates,
  isLikelyRecruitmentMail,
  parseRecruitmentMessage,
  parseWebsiteSnapshot,
} from '../src/server/parser.js';
import { normalizeAuthorizationCode } from '../src/server/keychain.js';
import {
  asiainfoApplication,
  dewuApplication,
  huabaoApplication,
  kpmgAssessments,
  yonyouAssessment,
} from './fixtures/recruitment-mails.js';

describe('招聘内容解析', () => {
  it('用友测评通知剥离重要标签，提取应聘岗位，按72小时有效期记录截止时间，按钮和落款日期不当开始时间', () => {
    expect(parseRecruitmentMessage(yonyouAssessment)).toMatchObject({
      company: '用友集团',
      position: '售前解决方案管培生-江苏区',
      eventType: 'assessment',
      confidence: 0.95,
      startsAt: null,
      dueAt: '2026-10-04T09:00:00.000Z',
    });
  });

  it.each([
    '【重要】',
    '【紧急】',
    '【必读】',
    '【请查收】',
    '【温馨提示】',
    '[External]',
    '[IMPORTANT]',
    '[Action Required]',
    'Re: [External] 【重要】',
  ])('通用主题标签 %s 不充当公司名，也不挡住后面的雇主', (prefix) => {
    expect(
      parseRecruitmentMessage({
        ...yonyouAssessment,
        subject: `${prefix}星河科技2027届校园招聘-测评通知`,
        text: '请完成测评。',
      }),
    ).toMatchObject({ company: '星河科技', eventType: 'assessment', confidence: 0.95 });
    expect(
      parseRecruitmentMessage({
        ...yonyouAssessment,
        subject: `${prefix}测评通知`,
        text: '请完成测评。',
      }),
    ).toMatchObject({ company: '', confidence: 0.68 });
  });

  it('公司名称中含有重要仍保留真实公司，显式雇主字段仍优先', () => {
    expect(
      parseRecruitmentMessage({
        ...yonyouAssessment,
        subject: '【重要科技】测评邀请',
        text: '请完成测评。',
      }),
    ).toMatchObject({ company: '重要科技' });
    expect(
      parseRecruitmentMessage({
        ...yonyouAssessment,
        text: '公司：星河科技。岗位：数据分析师。请完成测评。',
      }),
    ).toMatchObject({ company: '星河科技', position: '数据分析师' });
  });

  it('平台发件人只帮助召回泛化主题，平台名不能被当雇主，伪装域名不能绕过召回', () => {
    const from = 'Wintalent招聘系统信函 <notice@mail.hrtools.cn>';
    expect(isLikelyRecruitmentMail('通知函', 'notice@mail.hrtools.cn')).toBe(true);
    expect(isLikelyRecruitmentMail('通知函', 'notice@mail.hrtools.cn.evil.example')).toBe(false);
    expect(parseRecruitmentMessage({ ...yonyouAssessment, subject: '通知函', from })).toMatchObject(
      { company: '用友集团', position: '售前解决方案管培生-江苏区', eventType: 'assessment' },
    );
    expect(
      parseRecruitmentMessage({
        ...yonyouAssessment,
        subject: '测评通知',
        from,
        text: '请完成测评。',
      }),
    ).toMatchObject({ company: '', confidence: 0.68 });
    expect(
      parseRecruitmentMessage({
        ...yonyouAssessment,
        subject: '通知函',
        from,
        text: '欢迎了解招聘服务。',
      }),
    ).toBeNull();
  });

  it.each(
    ['应聘', '投递', '申请'].flatMap((verb) =>
      [
        ['【', '】'],
        ['「', '」'],
        ['“', '”'],
      ].map(([open, close]) => ({ verb, open, close })),
    ),
  )('$verb 雇主和招聘批次后的 $open 岗位 $close 职位可通用提取', ({ verb, open, close }) => {
    expect(
      parseRecruitmentMessage({
        ...yonyouAssessment,
        subject: '【星河科技】测评通知',
        text: `感谢您${verb}星河科技2027届校园招聘${open} 数据分析师（上海） ${close}职位，现邀请您完成测评。`,
      }),
    ).toMatchObject({
      company: '星河科技',
      position: '数据分析师（上海）',
      eventType: 'assessment',
    });
  });

  it.each(['测评有效期72小时', '测评有效期为 3 天', '请在72小时内完成该测评问卷'])(
    '邮件明确的相对完成期限 %s 可转换成截止时刻',
    (duration) => {
      expect(
        parseRecruitmentMessage({ ...yonyouAssessment, text: `请完成测评。${duration}。` }),
      ).toMatchObject({ startsAt: null, dueAt: '2026-10-04T09:00:00.000Z' });
    },
  );

  it.each([
    '作答时间30-60分钟。',
    '我们会在24小时内回复您。',
    '开始答题后，测评有效期2小时。',
    '如果获邀，测评有效期72小时。',
  ])('作答时长、客服响应或有条件的有效期不是当前截止时间：%s', (text) => {
    expect(
      parseRecruitmentMessage({ ...yonyouAssessment, text: `请完成测评。${text}` }),
    ).toMatchObject({ startsAt: null, dueAt: null });
  });

  it('显式截止日期优先于相对有效期，网页发现时间不能作为相对有效期起点', () => {
    const text = '开始时间：2026年11月2日 09:00。截止时间：2026年11月5日 18:00。测评有效期72小时。';
    const result = parseRecruitmentMessage({ ...yonyouAssessment, text });
    expect(result?.startsAt).toBe(extractDates(text, yonyouAssessment.receivedAt).startsAt);
    expect(result?.dueAt).toBe(extractDates(text, yonyouAssessment.receivedAt).dueAt);
    expect(result?.startsAt).toBeTruthy();
    expect(result?.dueAt).not.toBe('2026-10-04T09:00:00.000Z');
    expect(
      parseWebsiteSnapshot({
        url: 'https://jobs.example.com',
        title: '星河科技 - 测评邀请',
        text: '测评有效期72小时',
      }),
    ).toMatchObject({ startsAt: null, dueAt: null });
  });

  it('前程无忧亚信回执识别简历入库，只提取本次雇主，不把推荐职位和简历编号当申请信息', () => {
    expect(isLikelyRecruitmentMail(asiainfoApplication.subject, asiainfoApplication.from)).toBe(
      true,
    );
    expect(classifyEvent(asiainfoApplication.text)).toBe('application');
    const result = parseRecruitmentMessage(asiainfoApplication);
    expect(result).toMatchObject({
      company: '亚信科技',
      position: '',
      externalApplicationId: '',
      eventType: 'application',
      confidence: 0.95,
    });
    expect(result?.evidence).toContain('简历已经被发送至我们的简历数据库');
    expect(result?.matchingText).not.toMatch(/猜你喜欢|算法工程师|推荐企业/);
  });

  it('前程无忧回执提供明确岗位时保留岗位，推荐区的拒绝和面试文字不改变当前投递状态', () => {
    const text = asiainfoApplication.text
      .replace('感谢您应聘本公司。', '感谢您应聘本公司。岗位：数据分析师。')
      .replace(
        '岗位：算法工程师。公司：推荐企业。立刻投递',
        '岗位：算法工程师。公司：推荐企业。很遗憾未通过面试。',
      );
    expect(parseRecruitmentMessage({ ...asiainfoApplication, text })).toMatchObject({
      company: '亚信科技',
      position: '数据分析师',
      eventType: 'application',
    });
  });

  it('未来入库说明和已发出拒绝结论不能被当成投递成功', () => {
    expect(
      parseRecruitmentMessage({
        ...asiainfoApplication,
        text: '如果您的简历已经被发送至我们的简历数据库，请等待通知。',
      }),
    ).toBeNull();
    expect(
      parseRecruitmentMessage({
        ...asiainfoApplication,
        text: '您的简历已经被发送至我们的简历数据库。很遗憾，您的申请未通过。',
      }),
    ).toMatchObject({ eventType: 'rejection' });
  });

  it.each(['智联招聘', '智联', '前程无忧', 'Workday'])(
    '网页快照不将平台 %s 或页面导航当公司，正文雇主字段优先',
    (platform) => {
      const input = {
        url: 'https://xiaoyuan.zhaopin.com/scrd/phase/process?projectId=104576',
        title: `投递进程_我的校园_${platform}`,
        text: '投递成功。岗位：战略规划专员。',
      };
      expect(parseWebsiteSnapshot({ ...input, company: platform })?.company).toBe('');
      expect(
        parseWebsiteSnapshot({
          ...input,
          text: '公司：赛尔网络有限公司。岗位：战略规划专员。投递成功。',
        })?.company,
      ).toBe('赛尔网络有限公司');
    },
  );
  it('华宝新能模板不把我公司和系统说明当公司或岗位', () => {
    const result = parseRecruitmentMessage(huabaoApplication);
    expect(result).toMatchObject({
      company: '华宝新能',
      position: '研发管培生(J90002) 职位',
      eventType: 'application',
      confidence: 0.95,
    });
  });

  it.each(kpmgAssessments)('$subject 不把年度当公司或岗位', (mail) => {
    const result = parseRecruitmentMessage(mail);
    expect(result).toMatchObject({ company: '毕马威', position: '', eventType: 'assessment' });
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it.each([
    '我公司',
    '本公司',
    '年度',
    '2026-2027年度',
    '此邮件由系统发出',
    '请勿直接回复',
    '流程可能因此推迟',
  ])('所有公司和岗位提取分支都过滤无效值：%s', (value) => {
    for (const subject of [`【${value}】测评通知`, '测评通知']) {
      const result = parseRecruitmentMessage({
        ...huabaoApplication,
        subject,
        text: `公司：${value}，岗位名称：${value}。测评名称：${value}。感谢您投递${value}的职位。`,
      });
      expect(result).toMatchObject({ company: '', position: '', eventType: 'assessment' });
      expect(result?.confidence).toBeLessThan(0.9);
    }
  });

  it('跳过无效的首个字段，继续查找正文中明确的公司和岗位', () => {
    const result = parseRecruitmentMessage({
      ...huabaoApplication,
      subject: '【我公司】投递成功',
      text: '公司：我公司，岗位：年度。公司：得物，岗位：数据分析师。',
    });
    expect(result).toMatchObject({ company: '得物', position: '数据分析师', confidence: 0.95 });
  });

  it('字段标签不能跨行吞入邮件模板或其他字段', () => {
    const result = parseRecruitmentMessage({
      ...huabaoApplication,
      subject: '【华宝新能】测评通知',
      text: '岗位：\n此邮件由系统发出\n请勿回复。',
    });
    expect(result).toMatchObject({ company: '华宝新能', position: '', eventType: 'assessment' });
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('我公司的年度职位也不能绕过无效词过滤', () => {
    const result = parseRecruitmentMessage({
      ...huabaoApplication,
      text: '感谢您投递我公司的 年度 职位，我们已经收到您的简历。',
    });
    expect(result).toMatchObject({ company: '', position: '' });
    expect(result?.confidence).toBeLessThan(0.9);
  });

  it('测评名称保留为弱线索，未知域名不能证明公司身份', () => {
    const assessment = parseRecruitmentMessage({
      ...huabaoApplication,
      subject: '【星河科技】测评通知',
      text: '测评名称：秋季校园综合能力。',
    });
    expect(assessment).toMatchObject({
      position: '',
      positionHint: '秋季校园综合能力',
      confidence: 0.95,
    });
    const domainOnly = parseRecruitmentMessage({
      ...huabaoApplication,
      from: 'hr@unknown-platform.example',
      subject: '投递成功',
      text: '岗位：数据分析师。',
    });
    expect(domainOnly?.confidence).toBeLessThan(0.9);
  });

  it('得物正常投递成功邮件保留可靠的公司、岗位与高置信度', () => {
    expect(parseRecruitmentMessage(dewuApplication)).toMatchObject({
      company: '得物',
      position: '数据分析师',
      eventType: 'application',
      confidence: 0.95,
    });
  });

  it('识别测评邮件并提取公司、岗位和截止时间', () => {
    const result = parseRecruitmentMessage({
      subject: '【星河科技】在线测评通知',
      from: '校园招聘 <recruit@example.com>',
      text: '感谢您申请数据分析师岗位，请于2026年9月20日 18:00前完成测评。',
      receivedAt: new Date('2026-09-16T10:00:00+08:00'),
      messageId: '<assessment-1@example.com>',
    });
    expect(result).toMatchObject({
      company: '星河科技',
      position: '数据分析师岗位',
      eventType: 'assessment',
    });
    expect(result?.dueAt).toBeTruthy();
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('没有明确截止时间时绝不推测截止时间', () => {
    const result = parseRecruitmentMessage({
      subject: '面试通知',
      from: '招聘团队 <hr@acme.com>',
      text: '请参加产品经理岗位面试，具体时间稍后通知。',
      receivedAt: new Date('2026-09-16T00:00:00Z'),
      messageId: 'm2',
    });
    expect(result?.dueAt).toBeNull();
  });

  it('识别投递成功网页', () => {
    const result = parseWebsiteSnapshot({
      url: 'https://jobs.example.com/success',
      title: '星河科技 - 申请成功',
      text: '职位名称：商业分析师 您的简历已提交',
    });
    expect(result?.eventType).toBe('application');
    expect(result?.confidence).toBeGreaterThan(0.9);
  });

  it('区分 Offer 和普通招聘文字', () => {
    expect(classifyEvent('恭喜，Offer 通知')).toBe('offer');
    expect(classifyEvent('欢迎访问招聘官网')).toBe('other');
  });

  it('短日期跨年时使用下一个合理年份', () => {
    const dates = extractDates('截止时间：1月5日 12:00', new Date('2026-12-20T00:00:00'));
    expect(dates.dueAt?.startsWith('2027-01-05')).toBe(true);
  });

  it('授权码粘贴时自动去除空格与分组符号', () => {
    expect(normalizeAuthorizationCode('Ab3d efGh-ij7L mnOp')).toBe('Ab3defGhij7LmnOp');
  });

  it('联合利华邀请测评邮件优先识别为测评并解析时间范围', () => {
    const result = parseRecruitmentMessage({
      subject: '请参加联合利华2027UFLP管理培训生项目在线测评',
      from: 'iTalent <notice@italent.cn>',
      text: '感谢你投递联合利华2027UFLP管理培训生项目！现邀请你参与第一轮在线测评。测评时间：从 2026年09月17日 00:57 到 2026年09月20日 00:57 完成。后续面试安排另行通知。',
      receivedAt: new Date('2026-09-16T16:57:45Z'),
      messageId: 'unilever-assessment',
    });
    expect(result).toMatchObject({ company: '联合利华', eventType: 'assessment' });
    expect(result?.startsAt).toBeTruthy();
    expect(result?.dueAt).toBeTruthy();
  });

  it('普通页面中单独出现 offer 不应被当作录用通知', () => {
    expect(classifyEvent('求职帮助：如何谈 offer')).toBe('other');
  });

  it('区分 AI 测评、AI 面试和普通流程', () => {
    expect(classifyEvent('请在 72 小时内完成 AI 测评')).toBe('ai_assessment');
    expect(classifyEvent('邀请你参加在线AI面试')).toBe('ai_interview');
    expect(classifyEvent('邀请你参加在线测评')).toBe('assessment');
    expect(classifyEvent('面试安排通知')).toBe('interview');
  });

  it('邮件中的 AI 面试使用独立类型和标题', () => {
    const result = parseRecruitmentMessage({
      subject: 'AI面试邀请',
      from: '招聘 <hr@example.com>',
      text: '邀请你参加在线AI面试，岗位：数据分析师',
      receivedAt: new Date('2026-09-17T10:00:00Z'),
      messageId: 'ai-interview',
    });
    expect(result).toMatchObject({ eventType: 'ai_interview', title: 'AI面试通知' });
  });

  it('招聘邮件保留，商业 Offer 促销邮件直接过滤', () => {
    expect(
      isLikelyRecruitmentMail('P&G - Invitation to Online Assessment', 'careers@example.com'),
    ).toBe(true);
    expect(
      isLikelyRecruitmentMail('Special Offer: Earn 125,000 Points', 'offers@hotel.example'),
    ).toBe(false);
    expect(isLikelyRecruitmentMail('Lease renewal offer', 'leasing@managebuilding.example')).toBe(
      false,
    );
  });

  it('邮件主题的明确阶段优先于正文中的后续流程描述', () => {
    const written = parseRecruitmentMessage({
      subject: '【笔试邀请】美团邀请您参加在线笔试',
      from: 'batch@example.com',
      text: '笔试结果将作为进入面试的重要参考',
      receivedAt: new Date(),
      messageId: 'written-priority',
    });
    expect(written?.eventType).toBe('written_test');
    const applied = parseRecruitmentMessage({
      subject: '【滴滴招聘】简历成功投递通知',
      from: 'hr@example.com',
      text: '如简历状态显示非【流程结束】，请耐心等待',
      receivedAt: new Date(),
      messageId: 'application-priority',
    });
    expect(applied?.eventType).toBe('application');
  });

  it('宣讲会和候选人账户邮件不进入待确认', () => {
    const common = {
      from: '校园招聘 <career@example.com>',
      text: '欢迎了解我们的岗位和招聘流程',
      receivedAt: new Date(),
      messageId: 'non-progress',
    };
    expect(
      parseRecruitmentMessage({ ...common, subject: '秋季校园招聘空中宣讲会直播' }),
    ).toBeNull();
    expect(
      parseRecruitmentMessage({ ...common, subject: '请验证候选人账户', messageId: 'account' }),
    ).toBeNull();
    expect(
      parseRecruitmentMessage({
        ...common,
        subject: '自动答复: AI面试手机号问题',
        text: '原邮件内容：AI面试通知',
        messageId: 'auto-reply',
      }),
    ).toBeNull();
  });

  it('长岗位名中的流程终止仍识别为拒绝', () => {
    expect(classifyEvent('很遗憾，我们将终止你本次（27届秋招）数据分析-上海岗位的招聘流程')).toBe(
      'rejection',
    );
  });

  it('库洛拒信中的强终止语义优先于感谢投递', () => {
    const text =
      '亲爱的测试同学，你好！感谢你对库洛游戏2027届秋季校园招聘的关注与支持。很遗憾，经过慎重评估和考虑，你与本次秋招 数据运营 岗位的需求暂未达成最佳匹配，我们将不再继续推进后续应聘流程。';
    const subject = '【库洛游戏】感谢你投递库洛游戏2027届秋季校园招聘';
    expect(classifyEvent(`${subject}\n${text}`)).toBe('rejection');
    const result = parseRecruitmentMessage({
      subject,
      from: '库洛游戏招聘 <kurogames@mail.hire.feishu.cn>',
      text,
      receivedAt: new Date('2026-09-20T02:41:11.000Z'),
      messageId: 'kuro-rejection',
    });
    expect(result).toMatchObject({
      company: '库洛',
      position: '数据运营',
      eventType: 'rejection',
      title: '未通过',
    });
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('名创优品模板拒信不把页脚和投递动作误当公司、岗位', () => {
    const result = parseRecruitmentMessage({
      subject: '名创优品集团2027届校园招聘简历筛选结果反馈',
      from: '名创优品招聘 <notice@shmail.ibeisen.com>',
      text: '此邮件由系统发出，请勿直接回复或转发他人。亲爱的测试同学同学：您好，感谢您对名创优品集团2027届校园招聘的关注。您投递的简历已收到。我们在对您简历经过多方面评估后，很遗憾地通知你，目前您的简历和本次投递的岗位暂不匹配。更多校园招聘动态可关注“MINISO名创优品招聘”公众号。',
      receivedAt: new Date('2026-09-22T00:59:53.000Z'),
      messageId: '<1000000000003_10001_20001_30003.fixture-mail-a@shmail.ibeisen.com>',
    });

    expect(result).toMatchObject({
      company: '名创优品',
      position: '',
      eventType: 'rejection',
      title: '未通过',
    });
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('真正的库洛简历提交通知仍识别为投递成功', () => {
    const result = parseRecruitmentMessage({
      subject: '【库洛游戏】2027届秋季校园招聘投递进度查询通知',
      from: '库洛游戏招聘 <kurogames@mail.hire.feishu.cn>',
      text: '感谢你投递库洛游戏2027届秋季校园招聘，目前你所投递的【数据运营】职位，已成功完成简历提交。',
      receivedAt: new Date('2026-08-26T15:32:52.000Z'),
      messageId: 'kuro-application',
    });
    expect(result?.eventType).toBe('application');
  });

  it('公司提取不会把邮件问候语并入公司名', () => {
    const result = parseRecruitmentMessage({
      subject: '美团2027校园招聘笔试邀请',
      from: 'recruit@example.com',
      text: '亲爱的测试同学，感谢投递美团2027校园招聘，现邀请您参加笔试。',
      receivedAt: new Date(),
      messageId: 'meituan',
    });
    expect(result?.company).toBe('美团');
  });
});
