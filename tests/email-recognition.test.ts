import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/db.js';
import { CandidateService } from '../src/server/candidates.js';
import { isLikelyRecruitmentMail, parseRecruitmentMessage } from '../src/server/parser.js';
import type { CandidateInput } from '../src/shared/types.js';
import { yonyouAssessment } from './fixtures/recruitment-mails.js';

const sample = {
  subject: '【星河科技】AI测评邀请',
  from: '星河科技招聘 <notice@mail.mokahr.com>',
  text: '同学您好！邀请您参加AI测评，请于2026年11月3日 18:00前完成。',
  receivedAt: new Date('2026-10-30T10:00:00Z'),
  messageId: 'ai-assessment',
};
let directory: string, store: Store, service: CandidateService;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'campus-recognition-'));
  store = new Store(join(directory, 'test.sqlite'));
  store.db.exec(
    'DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM events; DELETE FROM candidates; DELETE FROM jobs;',
  );
  service = new CandidateService(store);
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
function ingest(fields: Partial<CandidateInput> = {}) {
  return service.ingest({ ...parseRecruitmentMessage(sample)!, ...fields });
}

describe('邮件目的与阶段识别', () => {
  it.each([
    '招聘周报：本周岗位推荐',
    'AI面试训练营限时优惠',
    '招聘宣讲会：测评与面试全攻略',
    'AI测评题库免费领取',
    '面试技巧分享',
    '职位推荐：Data Analyst',
    'Special Offer for your career',
    'Earn 125,000 Points',
    'Jobs for you: analyst',
    'Job Alert: your next opportunity',
    'Interview course newsletter',
    '请验证候选人账户',
    '校园招聘验证码',
    '密码重置',
    '自动答复: AI面试邀请',
    '招聘资讯：如何拿到offer',
    'Loan application received',
    'Rental application received',
    '信用卡申请成功',
    'Health assessment invitation',
    'Property assessment notice',
  ])('带有招聘发件人或阶段词的无关邮件被过滤：%s', (subject) => {
    expect(isLikelyRecruitmentMail(subject, sample.from)).toBe(false);
    expect(
      parseRecruitmentMessage({
        ...sample,
        subject,
        text: '公司：星河科技。岗位：数据分析师。面试、笔试、AI测评课程正在限时促销，立即购买。',
      }),
    ).toBeNull();
  });

  it.each(['欢迎加入人才社区', '本周招聘动态', '候选人服务使用说明'])(
    '无个人进度的招聘相关邮件不生成待确认：%s',
    (subject) => {
      expect(
        parseRecruitmentMessage({
          ...sample,
          subject,
          text: '欢迎了解我们的职位。我们提供面试、测评等招聘服务。',
        }),
      ).toBeNull();
    },
  );

  it('普通账户的申请成功不等于投递成功', () => {
    expect(
      parseRecruitmentMessage({
        ...sample,
        subject: '申请成功',
        from: 'notice@ordinary.example',
        text: '您的试用申请成功。',
      }),
    ).toBeNull();
  });

  it('管理培训生的测评邀请不会被课程过滤误伤', () => {
    expect(
      parseRecruitmentMessage({
        ...sample,
        subject: '请参加联合利华2027UFLP管理培训生项目在线测评',
      }),
    ).toMatchObject({ company: '联合利华', eventType: 'assessment' });
  });

  it('本次测评邀请不受条件说明和后续面试文字干扰', () => {
    expect(
      parseRecruitmentMessage({
        ...sample,
        text: `${sample.text}\n如果测评未通过，则无法进入后续流程。\n后续面试安排另行通知。`,
      }),
    ).toMatchObject({ eventType: 'ai_assessment' });
  });

  it('引用的旧拒信不会把本次面试邀请改成拒绝', () => {
    expect(
      parseRecruitmentMessage({
        ...sample,
        subject: '【星河科技】面试邀请',
        text: '邀请您参加面试。\n-----Original Message-----\n很遗憾，您的申请未通过。',
      }),
    ).toMatchObject({ eventType: 'interview' });
  });

  it('Offer正文回顾申请和面试时仍识别为Offer', () => {
    expect(
      parseRecruitmentMessage({
        ...sample,
        subject: '【星河科技】录用通知',
        text: '感谢您投递数据分析师岗位并参与面试，现向您发放正式Offer。',
      }),
    ).toMatchObject({ eventType: 'offer' });
  });

  it('职位编号不再冒充个人申请编号', () => {
    expect(
      parseRecruitmentMessage({
        ...sample,
        text: '岗位：数据分析师。职位编号：J12345。邀请您参加AI测评。',
      }),
    ).toMatchObject({ externalApplicationId: '' });
  });

  it('公司字段优先于招聘平台主题品牌，英文岗位独立提取', () => {
    expect(
      parseRecruitmentMessage({
        ...sample,
        subject: '【北森】AI测评邀请',
        text: '公司：星河科技。岗位：数据分析师。请完成AI测评。',
      }),
    ).toMatchObject({ company: '星河科技', position: '数据分析师' });
    expect(
      parseRecruitmentMessage({
        ...sample,
        subject: 'Interview Invitation',
        from: 'Acme Labs Careers <notice@platform.example>',
        text: 'Please attend the interview.\nJob title: Data Analyst\nCompany: Acme Labs',
      }),
    ).toMatchObject({ company: 'Acme Labs', position: 'Data Analyst', eventType: 'interview' });
  });

  it('完整官方域名可恢复品牌，伪装和未知域名不作为公司', () => {
    expect(
      parseRecruitmentMessage({ ...sample, subject: 'AI测评邀请', from: 'hr@campus.jd.com' }),
    ).toMatchObject({ company: '京东', confidence: 0.95 });
    expect(
      parseRecruitmentMessage({ ...sample, subject: 'AI测评邀请', from: 'hr@jd.com.evil.example' }),
    ).toMatchObject({ company: '', confidence: 0.68 });
  });

  it('英文申请回执从职业站上下文恢复公司并提取换行岗位', () => {
    expect(
      parseRecruitmentMessage({
        ...sample,
        subject: 'Thank you for applying',
        from: 'Acme Careers <notice@platform.example>',
        text: 'Thank you for your interest in a career at Acme Labs. Thank you for applying for the 2027 Quantitative Modeling\nRotational Program position.',
      }),
    ).toMatchObject({
      company: 'Acme Labs',
      position: '2027 Quantitative Modeling Rotational Program',
      eventType: 'application',
    });
  });

  it('英文背景中的感谢申请本身不是新的投递进度，也不把岗位当公司', () => {
    expect(
      parseRecruitmentMessage({
        ...sample,
        subject: 'Acme Labs - Business Solutions Associate',
        from: 'Acme Labs Recruiting Team <notice@platform.example>',
        text: 'Thank you for your application to the Business Solutions Associate\nposition. We are unable to provide sponsorship for this role.',
      }),
    ).toBeNull();
    expect(
      parseRecruitmentMessage({
        ...sample,
        subject: 'Thank you for applying',
        from: 'Acme Labs Careers <notice@platform.example>',
        text: 'Thank you for applying to the Business Solutions Associate\nposition.',
      }),
    ).toMatchObject({ company: 'Acme Labs' });
  });

  it.each([
    {
      subject: 'Thank you for applying to TikTok!',
      from: 'TikTok Recruiting <jobs@platform.example>',
      text: 'We have received your application for the Data Business Analyst Graduate (GBS) - 2027 Start role within TikTok.\nCompany updates\nCompany news',
      company: 'TikTok',
      position: 'Data Business Analyst Graduate (GBS) - 2027 Start',
    },
    {
      subject: 'Thank you for applying to TopDog Law LLC',
      from: 'Recruiting <notice@platform.example>',
      text: 'Thank you for your interest in **TopDog Law LLC**! We’ve received your application for the Analyst, Underwriting Analytics **** role and our team will be reviewing it shortly.',
      company: 'TopDog Law LLC',
      position: 'Analyst, Underwriting Analytics',
    },
    {
      subject: 'Thank You for Applying to EquipmentShare',
      from: 'Recruiting <notice@platform.example>',
      text: 'Thanks for your interest in EquipmentShare and for applying to the MDM (Master Data Management) Parts Specialist role in Corporate.',
      company: 'EquipmentShare',
      position: 'MDM (Master Data Management) Parts Specialist',
    },
  ])('真实英文模板提取岗位本身，排除role后的说明：$company', ({ company, position, ...mail }) => {
    const parsed = parseRecruitmentMessage({ ...sample, ...mail });
    expect(parsed).toMatchObject({ company, position, eventType: 'application' });
    expect(service.ingest(parsed!).autoApplied).toBe(true);
    expect(store.listJobs()).toMatchObject([{ company, position }]);
  });

  it('英文position后的条件说明不是岗位，公司新闻页脚不是雇主字段', () => {
    const parsed = parseRecruitmentMessage({
      ...sample,
      subject: 'Thank you for applying to Judi Health',
      from: 'Recruiting <notice@platform.example>',
      text: 'Thanks for applying to Judi Health. Your application has been received. If your application seems like a good fit for the position we will contact you soon.\nCompany updates',
    });
    expect(parsed).toMatchObject({ company: 'Judi Health', position: '' });
    expect(service.ingest(parsed!).autoApplied).toBe(false);
    expect(store.listJobs()).toHaveLength(0);
  });

  it('先感谢申请后说明已选择其他候选人，必须识别为拒信', () => {
    expect(
      parseRecruitmentMessage({
        ...sample,
        subject: 'Thank You for Applying to EquipmentShare',
        from: 'Recruiting <notice@platform.example>',
        text: 'Thanks for your interest in EquipmentShare and for applying to the MDM (Master Data Management) Parts Specialist role in Corporate.\nAfter careful review, we’ve decided to move forward with another candidate at this time.',
      }),
    ).toMatchObject({
      company: 'EquipmentShare',
      position: 'MDM (Master Data Management) Parts Specialist',
      eventType: 'rejection',
    });
  });
});

describe('正确岗位自动关联', () => {
  it.each(['cn', 'us'] as const)(
    '带提醒标签的测评在 %s 精确关联正确地区岗位，不覆盖公司名称，不重复事件或待办',
    (market) => {
      const job = store.createJob({
        market,
        company: '用友',
        position: '售前解决方案管培生-江苏区',
        status: '已投递',
      });
      const other = store.createJob({
        market,
        company: '用友',
        position: '售前解决方案管培生-上海区',
        status: '已投递',
      });
      const isolated = store.createJob({
        market: market === 'cn' ? 'us' : 'cn',
        company: '用友',
        position: '售前解决方案管培生-江苏区',
        status: '已投递',
      });
      const parsed = { ...parseRecruitmentMessage(yonyouAssessment)!, market };
      expect(service.ingest(parsed).autoApplied).toBe(true);
      expect(service.ingest(parsed).autoApplied).toBe(true);
      expect(store.getJob(job.id)).toMatchObject({
        company: '用友',
        position: job.position,
        status: '测评中',
        events: [{ type: 'assessment' }],
        tasks: [{ type: 'assessment', startsAt: null, dueAt: '2026-10-04T09:00:00.000Z' }],
      });
      expect(store.getJob(other.id)).toMatchObject({ status: '已投递', events: [], tasks: [] });
      expect(store.getJob(isolated.id)).toMatchObject({ status: '已投递', events: [], tasks: [] });
      expect(store.listJobs(market)).toHaveLength(2);
      expect(store.listCandidates('pending', market)).toHaveLength(0);
    },
  );

  it.each(['cn', 'us'] as const)(
    '公司明确且唯一的 %s 岗位，无岗位名AI测评直接更新并创建待办',
    (market) => {
      const job = store.createJob({ market, company: '星河科技', position: '数据分析师' });
      const other = store.createJob({
        market: market === 'cn' ? 'us' : 'cn',
        company: '星河科技',
        position: '数据分析师',
      });
      expect(ingest({ market })).toMatchObject({
        autoApplied: true,
        candidate: { status: 'applied', suggestedJobId: job.id },
      });
      expect(store.getJob(job.id)).toMatchObject({
        company: '星河科技',
        position: '数据分析师',
        status: 'AI测评中',
        tasks: [{ type: 'ai_assessment' }],
      });
      expect(store.getJob(other.id)).toMatchObject({ status: '已投递', events: [], tasks: [] });
      expect(store.listCandidates('pending', market)).toHaveLength(0);
      expect(store.listJobs(market)).toHaveLength(1);
      expect(ingest({ market }).autoApplied).toBe(true);
      expect(store.getJob(job.id)?.tasks).toHaveLength(1);
      expect(store.getJob(job.id)?.events).toHaveLength(1);
    },
  );

  it('同公司多岗位无岗位线索时保留歧义并说明原因', () => {
    store.createJob({ company: '星河科技', position: '数据分析师' });
    store.createJob({ company: '星河科技', position: '产品经理' });
    const result = ingest();
    expect(result).toMatchObject({
      autoApplied: false,
      candidate: { status: 'pending', suggestedJobId: null },
    });
    expect(result.candidate.reviewReason).toContain('多个申请');
    expect(store.listJobs().every((job) => job.events.length === 0 && job.tasks.length === 0)).toBe(
      true,
    );
  });

  it('明确岗位只更新对应条目，招聘批次和岗位标签不造成重复建档', () => {
    const target = store.createJob({ company: '星河科技', position: '【27届校招】风控数据分析师' });
    const other = store.createJob({ company: '星河科技', position: '交易PMO' });
    expect(ingest({ position: '风控数据分析师岗位' })).toMatchObject({
      autoApplied: true,
      candidate: { suggestedJobId: target.id },
    });
    expect(store.getJob(other.id)?.events).toHaveLength(0);
    expect(store.getJob(target.id)?.position).toBe('【27届校招】风控数据分析师');
  });

  it('只有一个公司岗位也不能无视另一个明确岗位', () => {
    const job = store.createJob({ company: '星河科技', position: '数据分析师' });
    const result = ingest({ position: '海外销售' });
    expect(result.autoApplied).toBe(false);
    expect(result.candidate.reviewReason).toContain('不一致');
    expect(store.getJob(job.id)).toMatchObject({ status: '已投递', events: [], tasks: [] });
  });

  it('完整岗位和城市区分同公司申请，公共子串不能触发自动合并', () => {
    const shanghai = store.createJob({ company: '星河科技', position: '数据分析师（上海）' });
    const beijing = store.createJob({ company: '星河科技', position: '数据分析师（北京）' });
    expect(ingest({ position: '数据分析师', eventType: 'application' }).autoApplied).toBe(false);
    expect(store.listJobs()).toHaveLength(2);
    expect(ingest({ sourceRef: 'mail:beijing', position: '数据分析师（北京）' })).toMatchObject({
      autoApplied: true,
      candidate: { suggestedJobId: beijing.id },
    });
    expect(store.getJob(shanghai.id)?.events).toHaveLength(0);
  });

  it('同名重复记录不会触发新建第三条', () => {
    store.createJob({ company: '星河科技', position: '数据分析师' });
    store.createJob({ company: '星河科技', position: '数据分析师' });
    expect(ingest({ position: '数据分析师', eventType: 'application' }).autoApplied).toBe(false);
    expect(store.listJobs()).toHaveLength(2);
  });

  it.each([
    [
      'Data Business Analyst Graduate (GBS) - 2027 Start',
      'Data Analyst Graduate (Supply Chain and Logistics) - 2027 Start',
    ],
    ['数据分析师（上海）', '数据分析师（北京）'],
  ])('完整投递回执的业务或城市限定明确不同时分别建档：%s / %s', (first, second) => {
    const job = store.createJob({ company: '星河科技', position: first });
    expect(ingest({ position: second, eventType: 'application' }).autoApplied).toBe(true);
    expect(store.listJobs()).toHaveLength(2);
    expect(store.getJob(job.id)?.events).toHaveLength(0);
    expect(store.listJobs().some((item) => item.position === second)).toBe(true);
  });

  it('结束的历史岗位参与消歧，不把旧通知自动关联到剩余在途岗位', () => {
    store.createJob({ company: '星河科技', position: '数据分析师', status: '已拒绝' });
    const active = store.createJob({ company: '星河科技', position: '产品经理' });
    expect(ingest().autoApplied).toBe(false);
    expect(store.getJob(active.id)?.events).toHaveLength(0);
  });

  it('已拒绝岗位的旧投递回执只记录历史，不重新建档或回退状态', () => {
    const job = store.createJob({ company: '星河科技', position: '数据分析师', status: '已拒绝' });
    expect(ingest({ position: '数据分析师', eventType: 'application' }).autoApplied).toBe(true);
    expect(store.listJobs()).toHaveLength(1);
    expect(store.getJob(job.id)?.status).toBe('已拒绝');
  });

  it('岗位末尾的届别和招聘编号不造成同一岗位重复', () => {
    const job = store.createJob({ company: '星河科技', position: '经营分析管培生【2027届】' });
    expect(ingest({ position: '经营分析管培生 (J12345)', eventType: 'application' })).toMatchObject(
      { autoApplied: true, candidate: { suggestedJobId: job.id } },
    );
    expect(store.listJobs()).toHaveLength(1);
  });

  it('关联已终结岗位的迟到测评不生成待完成事项', () => {
    const job = store.createJob({ company: '星河科技', position: '数据分析师', status: '已拒绝' });
    expect(ingest({ position: '数据分析师' }).autoApplied).toBe(true);
    expect(store.getJob(job.id)).toMatchObject({ status: '已拒绝', events: [{}], tasks: [] });
  });

  it('不同子公司不因公共品牌和岗位相同而串档', () => {
    const parent = store.createJob({ company: '阿里巴巴控股集团', position: '数据分析师' });
    const cloud = store.createJob({ company: '阿里云', position: '数据分析师' });
    expect(ingest({ company: '阿里国际数字商业集团', position: '数据分析师' }).autoApplied).toBe(
      false,
    );
    expect(store.getJob(parent.id)?.events).toHaveLength(0);
    expect(store.getJob(cloud.id)?.events).toHaveLength(0);
  });

  it('品牌别名匹配已有条目时保留界面原名', () => {
    const job = store.createJob({ company: 'miHoYo', position: '国际化数据分析' });
    expect(ingest({ company: '米哈游', position: '国际化数据分析' }).autoApplied).toBe(true);
    expect(store.getJob(job.id)).toMatchObject({ company: 'miHoYo', position: '国际化数据分析' });
  });

  it('相同编号不能跨公司，编号和明确岗位冲突时不能强行关联', () => {
    const job = store.createJob({
      company: '星河科技',
      position: '数据分析师',
      externalApplicationId: 'AP12345',
    });
    store.createJob({
      company: '另一科技',
      position: '产品经理',
      externalApplicationId: 'AP12345',
    });
    expect(ingest({ position: '产品经理', externalApplicationId: 'AP12345' }).autoApplied).toBe(
      false,
    );
    expect(store.getJob(job.id)?.events).toHaveLength(0);
  });

  it('邮件引用已关联的Message-ID时，多岗位也能唯一更新', () => {
    const job = store.createJob({ company: '星河科技', position: '数据分析师' });
    const other = store.createJob({ company: '星河科技', position: '产品经理' });
    store.addEvent(job.id, {
      type: 'application',
      source: 'email',
      dedupeKey: 'mail:<application@example.com>',
    });
    expect(ingest({ relatedSourceRefs: ['mail:<application@example.com>'] })).toMatchObject({
      autoApplied: true,
      candidate: { suggestedJobId: job.id },
    });
    expect(store.getJob(other.id)?.events).toHaveLength(0);
  });

  it.each([true, false])('历史引用或正文岗位也不能掩盖申请编号冲突（历史引用：%s）', (history) => {
    const job = store.createJob({
      company: '星河科技',
      position: '数据分析师',
      externalApplicationId: 'OLD12345',
    });
    store.addEvent(job.id, {
      type: 'application',
      source: 'email',
      dedupeKey: 'mail:<old@example.com>',
    });
    expect(
      ingest({
        externalApplicationId: 'NEW12345',
        relatedSourceRefs: history ? ['mail:<old@example.com>'] : [],
        matchingText: '本次数据分析师测评邀请',
      }).autoApplied,
    ).toBe(false);
    expect(store.getJob(job.id)).toMatchObject({
      status: '已投递',
      externalApplicationId: 'OLD12345',
      tasks: [],
    });
  });

  it('不因前280字只有说明而遗漏正文后面的明确岗位', () => {
    const job = store.createJob({ company: '星河科技', position: '数据分析师' });
    const other = store.createJob({ company: '星河科技', position: '产品经理' });
    const parsed = parseRecruitmentMessage({
      ...sample,
      text: `${'请阅读作答说明。'.repeat(70)}\n本次申请的数据分析师岗位，请参加AI测评。`,
    })!;
    expect(parsed.evidence).not.toContain('数据分析师');
    expect(service.ingest(parsed)).toMatchObject({
      autoApplied: true,
      candidate: { suggestedJobId: job.id },
    });
    expect(store.getJob(other.id)?.events).toHaveLength(0);
  });

  it('解析低置信度不被精确匹配抬高', () => {
    const job = store.createJob({ company: '星河科技', position: '数据分析师' });
    expect(ingest({ position: '数据分析师', confidence: 0.68 })).toMatchObject({
      autoApplied: false,
      candidate: { confidence: 0.68, suggestedJobId: job.id },
    });
  });

  it('先到的测评在建立岗位后可自动消化，原始解析分不被旧匹配分污染', () => {
    const pending = ingest();
    expect(pending.autoApplied).toBe(false);
    const job = store.createJob({ company: '星河科技', position: '数据分析师' });
    expect(service.reconcilePendingEmails('cn')).toBe(1);
    expect(store.getCandidate(pending.candidate.id)?.status).toBe('applied');
    expect(store.getJob(job.id)?.status).toBe('AI测评中');
    expect(service.reconcilePendingEmails('cn')).toBe(0);
  });

  it('用户已忽略的邮件不因重识别或出现岗位而被重新应用', () => {
    const pending = ingest();
    store.setCandidateStatus(pending.candidate.id, 'ignored');
    const job = store.createJob({ company: '星河科技', position: '数据分析师' });
    expect(ingest()).toMatchObject({ autoApplied: false, candidate: { status: 'ignored' } });
    expect(service.reconcilePendingEmails('cn')).toBe(0);
    expect(store.getJob(job.id)?.events).toHaveLength(0);
  });

  it('较早的投递回执和测评不会覆盖后来的面试', () => {
    const job = store.createJob({ company: '星河科技', position: '数据分析师', status: '面试中' });
    store.addEvent(job.id, {
      type: 'interview',
      source: 'email',
      occurredAt: '2026-10-30T12:00:00Z',
    });
    expect(ingest({ position: '数据分析师' }).autoApplied).toBe(true);
    expect(store.getJob(job.id)).toMatchObject({ status: '面试中', tasks: [] });
  });

  it('相同测评的提醒只补充进度记录，不重复待办或重开已完成测评', () => {
    const job = store.createJob({ company: '星河科技', position: '数据分析师' });
    ingest();
    expect(
      ingest({ sourceRef: 'mail:reminder-1', evidence: '【星河科技】AI测评完成提醒' }).autoApplied,
    ).toBe(true);
    expect(store.getJob(job.id)?.tasks).toHaveLength(1);
    store.completeTask(store.getJob(job.id)!.tasks[0].id);
    expect(
      ingest({ sourceRef: 'mail:reminder-2', evidence: '【星河科技】AI测评完成提醒' }).autoApplied,
    ).toBe(true);
    expect(store.getJob(job.id)).toMatchObject({
      status: '等待结果',
      tasks: [{ completedAt: expect.any(String) }],
    });
  });

  it('已完成的无日期测评不被回溯读取的旧通知重新打开', () => {
    const job = store.createJob({ company: '星河科技', position: '数据分析师' });
    ingest({ startsAt: null, dueAt: null });
    store.completeTask(store.getJob(job.id)!.tasks[0].id, '2026-10-30T11:00:00Z');
    expect(
      ingest({
        sourceRef: 'mail:old-rescan',
        startsAt: null,
        dueAt: null,
        occurredAt: '2026-10-30T10:00:00Z',
      }).autoApplied,
    ).toBe(true);
    expect(store.getJob(job.id)).toMatchObject({
      status: '等待结果',
      tasks: [{ completedAt: '2026-10-30T11:00:00Z' }],
    });
  });

  it('自动写入出现异常时整体回滚，不留下半个岗位或待办', () => {
    vi.spyOn(store, 'addTask').mockImplementation(() => {
      throw new Error('模拟待办写入失败');
    });
    const job = store.createJob({ company: '星河科技', position: '数据分析师' });
    expect(() => ingest({ position: '数据分析师' })).toThrow('模拟待办写入失败');
    expect(store.getJob(job.id)).toMatchObject({ status: '已投递', events: [], tasks: [] });
    expect(store.listCandidates()).toHaveLength(0);
  });

  it('自动更新保留可撤销审计', () => {
    const job = store.createJob({ company: '星河科技', position: '数据分析师' });
    const result = ingest();
    const audit = store.db
      .prepare("SELECT id FROM audit_log WHERE action='candidate_apply' AND entity_id=?")
      .get(job.id)!;
    expect(store.undoAudit(String(audit.id))).toBe(true);
    expect(store.getJob(job.id)).toMatchObject({ status: '已投递', events: [], tasks: [] });
    expect(store.getCandidate(result.candidate.id)?.status).toBe('ignored');
    expect(service.reconcilePendingEmails('cn')).toBe(0);
    expect(ingest().autoApplied).toBe(false);
  });
});
