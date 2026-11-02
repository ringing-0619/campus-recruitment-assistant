import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/db.js';
import { CandidateService } from '../src/server/candidates.js';
import { parseRecruitmentMessage } from '../src/server/parser.js';
import {
  dewuApplication,
  huabaoApplication,
  kpmgAssessments,
} from './fixtures/recruitment-mails.js';

let dir: string, store: Store, service: CandidateService;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'campus-assistant-'));
  store = new Store(join(dir, 'test.sqlite'));
  store.db.exec(
    'DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM events; DELETE FROM candidates; DELETE FROM jobs;',
  );
  service = new CandidateService(store);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('候选更新与去重', () => {
  it.each(['employer-field', 'manual'] as const)(
    '平台自己招聘时，%s 身份证据允许明确雇主建档',
    (companySource) => {
      const result = service.ingest({
        source: 'website',
        sourceRef: `self-hire:${companySource}`,
        company: '北森',
        companySource,
        position: '服务管培生',
        eventType: 'application',
        confidence: 0.99,
      });
      expect(result.autoApplied).toBe(true);
      expect(store.listJobs()[0].company).toBe('北森');
    },
  );
  it('已保存的真实平台雇主可正常监控，saved-job 必须与当前模块的公司、岗位和网址一致', () => {
    const url = 'https://beisen.zhiye.com/personal/deliveryRecord';
    const job = store.createJob({
      company: '北森',
      position: '服务管培生',
      status: '已投递',
      progressUrls: [url],
    });
    const invalid = service.ingest({
      source: 'website',
      sourceRef: 'monitor:wrong-url',
      company: '北森',
      companySource: 'saved-job',
      position: '服务管培生',
      url: 'https://other.example.com/',
      eventType: 'interview',
      confidence: 0.99,
    });
    expect(invalid.autoApplied).toBe(false);
    const result = service.ingest({
      source: 'website',
      sourceRef: 'monitor:valid',
      company: '北森',
      companySource: 'saved-job',
      position: '服务管培生',
      url,
      eventType: 'interview',
      confidence: 0.99,
    });
    expect(result.autoApplied).toBe(true);
    expect(store.getJob(job.id)?.status).toBe('面试中');
  });
  it.each([
    '智联',
    '智联招聘',
    '智联校园招聘',
    '前程无忧',
    '51job',
    'BOSS直聘',
    '猎聘',
    'Workday',
    'Greenhouse',
    'Moka',
    '北森',
  ])('旧插件传入平台 %s 时禁止建档、编号关联和高分证据绕过', (company) => {
    const job = store.createJob({
      company: '赛尔网络有限公司',
      position: '战略规划专员',
      status: '已投递',
      externalApplicationId: 'ZP12345',
      progressUrls: ['https://xiaoyuan.zhaopin.com/scrd/phase/process?projectId=104576'],
    });
    for (const eventType of ['application', 'interview', 'rejection'] as const) {
      const result = service.ingest({
        source: 'website',
        sourceRef: `legacy:${company}:${eventType}`,
        company,
        position: '战略规划专员',
        externalApplicationId: 'ZP12345',
        url: 'https://xiaoyuan.zhaopin.com/scrd/phase/process?projectId=104576',
        eventType,
        evidence: '赛尔网络有限公司 战略规划专员',
        confidence: 0.99,
      });
      expect(result.autoApplied).toBe(false);
      expect(result.candidate).toMatchObject({
        company: '',
        status: 'pending',
        suggestedJobId: null,
      });
      expect(result.candidate.confidence).toBeLessThan(0.9);
      expect(result.candidate.reviewReason).toContain('雇主');
    }
    expect(store.listJobs()).toHaveLength(1);
    expect(store.getJob(job.id)).toMatchObject({ status: '已投递', events: [], tasks: [] });
  });
  it.each([false, true])(
    '签名恢复公司，缺省岗位的测评仅在已有唯一申请时自动更新（已有岗位：%s）',
    (existing) => {
      if (existing) {
        store.createJob({ company: '华宝新能', position: '研发管培生', status: '面试中' });
        store.createJob({ company: '毕马威', position: '咨询顾问', status: '已投递' });
      }
      for (const mail of [huabaoApplication, ...kpmgAssessments]) {
        const parsed = parseRecruitmentMessage(mail)!;
        const result = service.ingest(parsed);
        expect(result.autoApplied).toBe(mail === huabaoApplication || existing);
        expect(result.candidate.status).toBe(
          mail === huabaoApplication || existing ? 'applied' : 'pending',
        );
        expect(service.ingest(parsed).candidate.id).toBe(result.candidate.id);
      }
      expect(store.listCandidates()).toHaveLength(existing ? 0 : 2);
      expect(store.listJobs()).toHaveLength(existing ? 2 : 1);
      expect(store.listJobs().find((job) => job.company === '华宝新能')?.status).toBe(
        existing ? '面试中' : '已投递',
      );
      if (existing)
        expect(store.listJobs().find((job) => job.company === '毕马威')).toMatchObject({
          status: '测评中',
          tasks: [{}, {}],
        });
    },
  );

  it.each([0.68, 0.82, 0.899, 0.9])('邮件自动采纳必须满足解析置信度门槛：%s', (confidence) => {
    const job = store.createJob({
      company: '得物',
      position: '数据分析师',
      status: '已投递',
      externalApplicationId: 'DW12345',
    });
    const result = service.ingest({
      source: 'email',
      sourceRef: 'mail:confidence-gate',
      company: '得物',
      position: '数据分析师',
      eventType: 'assessment',
      externalApplicationId: 'DW12345',
      confidence,
    });
    expect(result.autoApplied).toBe(confidence >= 0.9);
    expect(result.candidate).toMatchObject({
      confidence,
      suggestedJobId: job.id,
      status: confidence >= 0.9 ? 'applied' : 'pending',
    });
    expect(store.getJob(job.id)?.status).toBe(confidence >= 0.9 ? '测评中' : '已投递');
    expect(store.getJob(job.id)?.events).toHaveLength(confidence >= 0.9 ? 1 : 0);
    expect(store.getJob(job.id)?.tasks).toHaveLength(confidence >= 0.9 ? 1 : 0);
  });

  it.each([
    { company: '我公司', position: '此邮件由系统发出' },
    { company: '年度', position: '年度' },
    { company: '得物', position: '请勿直接回复' },
    { company: '', position: '数据分析师' },
  ])('外部传入的无效邮件字段也不能靠高分自动采纳：$company / $position', (fields) => {
    const job = store.createJob({
      company: '得物',
      position: '数据分析师',
      status: '已投递',
      externalApplicationId: 'DW12345',
    });
    const result = service.ingest({
      ...fields,
      source: 'email',
      sourceRef: 'mail:invalid-fields',
      eventType: 'assessment',
      evidence: '得物 数据分析师 测评通知',
      externalApplicationId: 'DW12345',
      confidence: 0.99,
    });
    expect(result.autoApplied).toBe(false);
    expect(result.candidate.status).toBe('pending');
    expect(result.candidate.confidence).toBeLessThan(0.9);
    expect(store.getJob(job.id)).toMatchObject({ status: '已投递', events: [], tasks: [] });
  });

  it('低置信度投递邮件不会新建岗位，但允许人工确认', () => {
    const result = service.ingest({
      ...parseRecruitmentMessage(dewuApplication)!,
      confidence: 0.82,
    });
    expect(result.autoApplied).toBe(false);
    expect(store.listJobs()).toHaveLength(0);
    const job = service.apply(result.candidate.id, null);
    expect(job).toMatchObject({ company: '得物', position: '数据分析师', status: '已投递' });
    expect(store.getCandidate(result.candidate.id)?.status).toBe('applied');
  });

  it('得物投递成功邮件自动创建岗位，重放仍只保留一条记录', () => {
    const parsed = parseRecruitmentMessage(dewuApplication)!;
    const first = service.ingest(parsed);
    expect(first.autoApplied).toBe(true);
    expect(first.candidate).toMatchObject({
      company: '得物',
      position: '数据分析师',
      status: 'applied',
      confidence: 0.95,
    });
    expect(service.ingest(parsed).candidate.id).toBe(first.candidate.id);
    expect(store.listJobs()).toHaveLength(1);
    expect(store.listJobs()[0]).toMatchObject({
      company: '得物',
      position: '数据分析师',
      status: '已投递',
      source: 'email',
    });
    expect(store.listJobs()[0].events).toHaveLength(1);
  });

  it('得物其他岗位的投递成功邮件不会合并到已有岗位', () => {
    const existing = store.createJob({
      company: '得物',
      position: '后端开发工程师',
      status: '面试中',
    });
    expect(service.ingest(parseRecruitmentMessage(dewuApplication)!).autoApplied).toBe(true);
    expect(store.listJobs()).toHaveLength(2);
    expect(store.getJob(existing.id)).toMatchObject({
      position: '后端开发工程师',
      status: '面试中',
      events: [],
    });
  });

  it('高置信度测评邮件没有匹配岗位时仍待确认', () => {
    const result = service.ingest({
      ...parseRecruitmentMessage(dewuApplication)!,
      eventType: 'assessment',
    });
    expect(result.autoApplied).toBe(false);
    expect(result.candidate.status).toBe('pending');
    expect(store.listJobs()).toHaveLength(0);
  });

  it('高置信投递成功页自动创建岗位且重复提交不重复', () => {
    const input = {
      source: 'website' as const,
      sourceRef: 'web:one',
      company: '星河科技',
      position: '数据分析师',
      eventType: 'application' as const,
      title: '投递成功',
      confidence: 0.96,
    };
    expect(service.ingest(input).autoApplied).toBe(true);
    expect(service.ingest(input).autoApplied).toBe(true);
    expect(store.listJobs()).toHaveLength(1);
    expect(store.listJobs()[0].events).toHaveLength(1);
  });

  it('同公司多个岗位且邮件缺少岗位时进入待确认', () => {
    store.createJob({ company: '星河科技', position: '数据分析师', status: '已投递' });
    store.createJob({ company: '星河科技', position: '产品经理', status: '已投递' });
    const result = service.ingest({
      source: 'email',
      sourceRef: 'mail:ambiguous',
      company: '星河科技',
      eventType: 'assessment',
      title: '测评通知',
      confidence: 0.95,
    });
    expect(result.autoApplied).toBe(false);
    expect(store.listCandidates()).toHaveLength(1);
  });

  it('精确公司岗位邮件自动产生任务，完成后进入等待结果', () => {
    store.createJob({ company: '星河科技', position: '数据分析师', status: '已投递' });
    const result = service.ingest({
      source: 'email',
      sourceRef: 'mail:exact',
      company: '星河科技',
      position: '数据分析师',
      eventType: 'assessment',
      title: '测评通知',
      dueAt: '2026-09-20T10:00:00Z',
      confidence: 0.95,
    });
    expect(result.autoApplied).toBe(true);
    const job = store.listJobs()[0];
    expect(job.status).toBe('测评中');
    expect(job.tasks).toHaveLength(1);
    store.completeTask(job.tasks[0].id, '2026-09-17T12:00:00Z');
    expect(store.listJobs()[0].status).toBe('等待结果');
    expect(store.listJobs()[0].tasks[0].completedAt).toBe('2026-09-17T12:00:00Z');
  });

  it('终态不会被普通进度覆盖', () => {
    store.createJob({ company: '星河科技', position: '数据分析师', status: '已offer' });
    service.ingest({
      source: 'email',
      sourceRef: 'mail:late',
      company: '星河科技',
      position: '数据分析师',
      eventType: 'interview',
      title: '面试通知',
      confidence: 0.95,
    });
    expect(store.listJobs()[0].status).toBe('已offer');
  });

  it('同一进度页上的不同申请编号不会被合并', () => {
    const common = {
      source: 'website' as const,
      url: 'https://campus.example.com/personal/applications',
      eventType: 'application' as const,
      title: '投递成功',
      confidence: 0.99,
    };
    service.ingest({
      ...common,
      sourceRef: 'web:a',
      company: '云业务',
      position: '数据分析师',
      externalApplicationId: '10001',
    });
    service.ingest({
      ...common,
      sourceRef: 'web:b',
      company: '国际业务',
      position: '数据分析师',
      externalApplicationId: '10002',
    });
    expect(store.listJobs()).toHaveLength(2);
    expect(new Set(store.listJobs().map((job) => job.externalApplicationId))).toEqual(
      new Set(['10001', '10002']),
    );
  });

  it('同公司同名岗位但申请编号不同仍单独建档，后续进度只更新自己的编号', () => {
    const common = {
      source: 'website' as const,
      url: 'https://wecruit.hotjob.cn/SU123/pb/account.html#/myDeliver',
      company: '云尖信息',
      position: '2027届-海外市场拓展',
      eventType: 'application' as const,
      confidence: 0.99,
    };
    service.ingest({
      ...common,
      sourceRef: 'application-card:yunjian:one',
      externalApplicationId: 'AP10001',
    });
    service.ingest({
      ...common,
      sourceRef: 'application-card:yunjian:two',
      externalApplicationId: 'AP10002',
    });
    service.ingest({
      ...common,
      sourceRef: 'application-card:yunjian:one:assessment',
      externalApplicationId: 'AP10001',
      eventType: 'assessment',
    });
    const jobs = store.listJobs().filter((job) => job.company === '云尖信息');
    expect(jobs).toHaveLength(2);
    expect(jobs.find((job) => job.externalApplicationId === 'AP10001')).toMatchObject({
      status: '测评中',
    });
    expect(jobs.find((job) => job.externalApplicationId === 'AP10002')).toMatchObject({
      status: '已投递',
    });
  });

  it.each(['志愿：', '志愿：第2志愿', '招聘项目：2027届校招', '2027届校招', '简历名称：测试简历'])(
    '旧插件误把 %s 当岗位时不自动建档或更新',
    (position) => {
      const common = {
        source: 'website' as const,
        url: 'https://wecruit.hotjob.cn/SU123/pb/account.html#/myDeliver',
        company: '云尖信息',
        externalApplicationId: 'AP10001',
        eventType: 'application' as const,
        confidence: 0.99,
      };
      const existing = store.createJob({
        company: '云尖信息',
        position: '2027届-海外市场拓展',
        externalApplicationId: 'AP10001',
        progressUrls: [common.url],
      });
      const result = service.ingest({ ...common, sourceRef: `old-web:${position}`, position });
      expect(result.autoApplied).toBe(false);
      expect(result.candidate).toMatchObject({ position: '', status: 'pending' });
      expect(store.listJobs()).toHaveLength(1);
      expect(store.getJob(existing.id)?.events).toHaveLength(0);
    },
  );
  it('招聘项目经理是有效岗位名称，不能因以“招聘项目”开头拦截', () => {
    const result = service.ingest({
      source: 'website',
      sourceRef: 'web:recruiting-pm',
      company: '云尖信息',
      position: '招聘项目经理',
      eventType: 'application',
      confidence: 0.99,
    });
    expect(result.autoApplied).toBe(true);
    expect(store.listJobs()[0].position).toBe('招聘项目经理');
  });

  it('共享投递记录页中同公司不同岗位不会按 URL 或公司合并', () => {
    const common = {
      source: 'website' as const,
      url: 'https://miniso.zhiye.com/personal/deliveryRecord',
      company: '名创优品',
      eventType: 'application' as const,
      title: '简历初筛进行中',
      confidence: 0.99,
    };
    service.ingest({
      ...common,
      sourceRef: 'beisen:miniso:J90003',
      position: '商品运营创优生',
      externalApplicationId: 'J90003',
    });
    service.ingest({
      ...common,
      sourceRef: 'beisen:miniso:dark-horse',
      position: '黑马工程 The Dark Horse Program',
    });
    expect(store.listJobs()).toHaveLength(2);
    expect(new Set(store.listJobs().map((job) => job.position))).toEqual(
      new Set(['商品运营创优生', '黑马工程 The Dark Horse Program']),
    );
  });

  it('一汽哈希列表页中没有申请编号的同公司多岗位也不会合并', () => {
    const common = {
      source: 'website' as const,
      url: 'https://faw-zhaopin.hotjob.cn/SU123/pb/account.html#/myDeliver',
      company: '一汽红旗',
      eventType: 'application' as const,
      title: '投递成功',
      confidence: 0.99,
    };
    service.ingest({
      ...common,
      sourceRef: 'application-card:faw:first',
      position: '战略规划架构师',
    });
    service.ingest({
      ...common,
      sourceRef: 'application-card:faw:second',
      position: '海外营销管理员',
    });
    expect(store.listJobs()).toHaveLength(2);
    expect(new Set(store.listJobs().map((job) => job.position))).toEqual(
      new Set(['战略规划架构师', '海外营销管理员']),
    );
  });

  it('旧插件共用容器编号和 sourceRef 时，两条叠纸方向仍分别建档且不会污染得物', () => {
    const dewu = store.createJob({
      company: '得物',
      position: '风控数据分析师',
      externalApplicationId: 'midas-view-content',
    });
    const common = {
      source: 'website' as const,
      company: '叠纸游戏',
      url: 'https://career.papegames.com/campus/position/application',
      externalApplicationId: 'midas-view-content',
      sourceRef:
        'application-card:career.papegames.com:midas-view-content:2026-10-29:application:已投递',
      eventType: 'application' as const,
      confidence: 0.99,
    };
    const first = service.ingest({ ...common, position: '商务管培生-研发方向（2027届秋招）' });
    const second = service.ingest({ ...common, position: '商务管培生-综合方向（2027届秋招）' });
    expect(first.candidate.id).not.toBe(second.candidate.id);
    expect(first.candidate.externalApplicationId).toBe('');
    expect(second.candidate.externalApplicationId).toBe('');
    expect(store.listJobs()).toHaveLength(3);
    expect(store.getJob(dewu.id)?.events).toHaveLength(0);
    service.ingest({ ...common, position: '商务管培生-研发方向（2027届秋招）' });
    expect(store.listJobs()).toHaveLength(3);
  });

  it('同公司岗位共享名称前缀时完整方向不同不能合并，精确重放仍关联原岗位', () => {
    const common = {
      source: 'website' as const,
      company: '叠纸游戏',
      eventType: 'application' as const,
      confidence: 0.99,
    };
    service.ingest({
      ...common,
      sourceRef: 'paper:rd',
      position: '商务管培生-研发方向（2027届秋招）',
    });
    service.ingest({
      ...common,
      sourceRef: 'paper:general',
      position: '商务管培生-综合方向（2027届秋招）',
    });
    service.ingest({
      ...common,
      sourceRef: 'paper:rd:other-source',
      position: '商务管培生-研发方向（2027届秋招）',
    });
    expect(store.listJobs()).toHaveLength(2);
  });

  it('真实编号也必须在公司和网站范围内匹配，跨公司同编号不能串档', () => {
    const dewu = store.createJob({
      company: '得物',
      position: '数据分析师',
      externalApplicationId: '12345678',
      progressUrls: ['https://poizon.jobs.feishu.cn/position/application'],
    });
    service.ingest({
      source: 'website',
      sourceRef: 'paper:real-id',
      company: '叠纸游戏',
      position: '数据分析师',
      eventType: 'application',
      externalApplicationId: '12345678',
      url: 'https://career.papegames.com/campus/position/application',
      confidence: 0.99,
    });
    expect(store.listJobs()).toHaveLength(2);
    expect(store.getJob(dewu.id)?.events).toHaveLength(0);
  });

  it.each(['rejection', 'ended', 'offer'] as const)(
    '共享网页中岗位为空的 %s 终态不会仅凭整页证据关联旧岗位',
    (eventType) => {
      const url =
        'https://app.mokahr.com/campus-recruitment/ninebot/45627?locale=zh-CN#/candidateHome/applications';
      const job = store.createJob({
        company: '九号公司',
        position: '助理数据分析工程师',
        status: '已投递',
        progressUrls: [url],
      });

      const result = service.ingest({
        source: 'website',
        sourceRef: `web:moka-empty-${eventType}`,
        company: '九号公司',
        position: '',
        url,
        eventType,
        title: '页面级终态',
        evidence: '会员运营专员 状态: 简历筛选；助理数据分析工程师 状态: 暂不匹配',
        confidence: 0.99,
      });

      expect(result.autoApplied).toBe(false);
      expect(result.candidate).toMatchObject({ status: 'pending', suggestedJobId: null });
      expect(store.getJob(job.id)).toMatchObject({ status: '已投递' });
      expect(store.getJob(job.id)?.events).toHaveLength(0);
    },
  );

  it('共享网页终态带明确岗位时仍可自动关联', () => {
    const url =
      'https://app.mokahr.com/campus-recruitment/ninebot/45627?locale=zh-CN#/candidateHome/applications';
    const job = store.createJob({
      company: '九号公司',
      position: '助理数据分析工程师',
      status: '已投递',
      progressUrls: [url],
    });

    const result = service.ingest({
      source: 'website',
      sourceRef: 'moka:ninebot:old-role',
      company: '九号公司',
      position: '助理数据分析工程师（电动车）',
      url,
      eventType: 'rejection',
      title: '未通过',
      evidence: '助理数据分析工程师（电动车） 状态: 暂不匹配',
      confidence: 0.99,
    });

    expect(result.autoApplied).toBe(true);
    expect(store.getJob(job.id)?.status).toBe('已拒绝');
  });

  it('网页终态岗位为空但申请编号精确时仍可自动关联', () => {
    const job = store.createJob({
      company: '九号公司',
      position: '会员运营专员',
      status: '已投递',
      externalApplicationId: '900000001',
    });

    const result = service.ingest({
      source: 'website',
      sourceRef: 'moka:ninebot:900000001',
      company: '九号公司',
      position: '',
      externalApplicationId: '900000001',
      eventType: 'ended',
      title: '流程结束',
      evidence: '申请流程已结束',
      confidence: 0.99,
    });

    expect(result.autoApplied).toBe(true);
    expect(store.getJob(job.id)?.status).toBe('流程结束');
  });

  it('AI 测评和 AI 面试生成独立任务与状态', () => {
    const job = store.createJob({ company: '星河科技', position: '数据分析师', status: '已投递' });
    service.ingest({
      source: 'email',
      sourceRef: 'mail:ai-assessment',
      company: '星河科技',
      position: '数据分析师',
      eventType: 'ai_assessment',
      title: 'AI测评通知',
      confidence: 0.95,
    });
    expect(store.getJob(job.id)?.status).toBe('AI测评中');
    expect(store.getJob(job.id)?.tasks[0].type).toBe('ai_assessment');
    service.ingest({
      source: 'email',
      sourceRef: 'mail:ai-interview',
      company: '星河科技',
      position: '数据分析师',
      eventType: 'ai_interview',
      title: 'AI面试通知',
      confidence: 0.95,
    });
    expect(store.getJob(job.id)?.status).toBe('AI面试中');
    expect(store.getJob(job.id)?.tasks.some((task) => task.type === 'ai_interview')).toBe(true);
  });

  it('低置信度模板即使正文明确命中唯一公司也不改状态', () => {
    const job = store.createJob({ company: '快手', position: '数据分析师', status: '已投递' });
    const result = service.ingest({
      source: 'email',
      sourceRef: 'mail:kuaishou',
      company: 'kuaishou',
      position: '流程可能因此推迟',
      eventType: 'assessment',
      title: '测评通知',
      evidence: '【快手校园招聘】邀请您完成在线人才测评',
      confidence: 0.82,
    });
    expect(result.autoApplied).toBe(false);
    expect(result.candidate).toMatchObject({
      position: '',
      status: 'pending',
      confidence: 0.82,
      suggestedJobId: job.id,
    });
    expect(store.getJob(job.id)?.status).toBe('已投递');
    expect(store.getJob(job.id)?.company).toBe('快手');
    expect(store.getJob(job.id)?.position).toBe('数据分析师');
  });

  it.each([0.82, 0.95])('只有部分相似的岗位即使解析置信度 %s 也只给出建议', (confidence) => {
    const amazon = store.createJob({
      company: '图拉斯',
      position: '亚马逊电商运营',
      status: '已投递',
    });
    store.createJob({ company: '图拉斯', position: '数据产品经理', status: '已投递' });
    const result = service.ingest({
      source: 'email',
      sourceRef: 'mail:torras-amazon',
      company: '图拉斯2027届校园',
      position: '图拉斯2027届校园招聘-亚马逊运营管培生-英语方向',
      eventType: 'assessment',
      title: '在线测评',
      evidence: '图拉斯2027届校园招聘 亚马逊运营管培生 英语方向 在线测评',
      confidence,
    });
    expect(result.candidate.suggestedJobId).toBe(amazon.id);
    expect(result.autoApplied).toBe(false);
    expect(store.getJob(amazon.id)?.status).toBe('已投递');
    expect(store.getJob(amazon.id)?.position).toBe('亚马逊电商运营');
  });

  it.each([0.82, 0.95])(
    '同公司多岗位时根据正文岗位唯一匹配，置信度 %s 决定是否采纳',
    (confidence) => {
      const data = store.createJob({
        company: '图拉斯',
        position: '数据产品经理',
        status: '已投递',
      });
      store.createJob({ company: '图拉斯', position: '亚马逊电商运营', status: '已投递' });
      const result = service.ingest({
        source: 'email',
        sourceRef: 'mail:torras',
        company: '图拉斯2027届校园',
        position: '图拉斯2027届校园招聘 数据产品经理 岗位',
        eventType: 'assessment',
        title: '性格测评',
        evidence: '感谢您投递图拉斯数据产品经理岗位，请完成性格测评',
        confidence,
      });
      expect(result.candidate.suggestedJobId).toBe(data.id);
      expect(result.autoApplied).toBe(confidence >= 0.9);
      expect(store.getJob(data.id)?.status).toBe(confidence >= 0.9 ? '测评中' : '已投递');
    },
  );

  it('无明确阶段的其他邮件不自动写入', () => {
    store.createJob({ company: '罗氏', position: 'MCE', status: '已投递' });
    const result = service.ingest({
      source: 'email',
      sourceRef: 'mail:account',
      company: 'roche',
      eventType: 'other',
      title: '关联候选人账户',
      evidence: '罗氏 Workday 候选人账户设置',
      confidence: 0.82,
    });
    expect(result.autoApplied).toBe(false);
  });

  it('库洛拒信解析后自动将数据运营岗位更新为已拒绝', () => {
    const job = store.createJob({ company: '库洛', position: '数据运营', status: '已投递' });
    const parsed = parseRecruitmentMessage({
      subject: '【库洛游戏】感谢你投递库洛游戏2027届秋季校园招聘',
      from: '库洛游戏招聘 <kurogames@mail.hire.feishu.cn>',
      text: '感谢你对库洛游戏2027届秋季校园招聘的关注与支持。很遗憾，经过慎重评估和考虑，你与本次秋招 数据运营 岗位的需求暂未达成最佳匹配，我们将不再继续推进后续应聘流程。',
      receivedAt: new Date('2026-09-20T02:41:11.000Z'),
      messageId: 'kuro-rejection-integration',
    });
    expect(parsed).not.toBeNull();
    const result = service.ingest(parsed!);
    expect(result.autoApplied).toBe(true);
    expect(result.candidate).toMatchObject({
      eventType: 'rejection',
      title: '未通过',
      status: 'applied',
    });
    expect(store.getJob(job.id)).toMatchObject({ status: '已拒绝' });
    expect(store.getJob(job.id)?.events.at(-1)).toMatchObject({
      type: 'rejection',
      title: '未通过',
    });
  });

  it.each([0.82, 0.95])(
    '中英双语岗位片段可匹配同公司岗位，置信度 %s 决定是否采纳',
    (confidence) => {
      const darkHorse = store.createJob({
        company: '名创优品',
        position: '黑马工程 The Dark Horse Program',
        status: '已投递',
      });
      const operations = store.createJob({
        company: '名创优品',
        position: '商品运营创优生',
        status: '已投递',
      });

      const result = service.ingest({
        source: 'email',
        sourceRef: 'mail:miniso-dark-horse-explicit',
        company: 'MINISO名创优品集团',
        position: '黑马工程',
        eventType: 'rejection',
        title: '未通过',
        evidence: 'MINISO名创优品黑马工程筛选未通过',
        confidence,
      });

      expect(result.candidate.suggestedJobId).toBe(darkHorse.id);
      expect(result.autoApplied).toBe(confidence >= 0.9);
      expect(store.getJob(darkHorse.id)?.status).toBe(confidence >= 0.9 ? '已拒绝' : '已投递');
      expect(store.getJob(operations.id)?.status).toBe('已投递');
    },
  );

  it('北森无岗位名拒信通过公司与唯一历史邮件流自动关联，重放沿用原待确认记录', () => {
    const darkHorse = store.createJob({
      company: '名创优品',
      position: '黑马工程 The Dark Horse Program',
      status: '已投递',
    });
    const operations = store.createJob({
      company: '名创优品',
      position: '商品运营创优生',
      status: '已投递',
    });
    store.addEvent(darkHorse.id, {
      type: 'application',
      title: '投递成功',
      source: 'email',
      occurredAt: '2026-09-18T10:00:00Z',
      dedupeKey: 'mail:<1000000000001_10001_20001_30001.fixture-mail-a@shmail.ibeisen.com>',
    });
    store.addEvent(operations.id, {
      type: 'application',
      title: '投递成功',
      source: 'email',
      occurredAt: '2026-09-18T11:00:00Z',
      dedupeKey: 'mail:<1000000000002_10001_20002_30002.fixture-mail-b@shmail.ibeisen.com>',
    });
    const sourceRef = 'mail:<1000000000003_10001_20001_30003.fixture-mail-a@shmail.ibeisen.com>';
    const bad = service.ingest({
      source: 'email',
      sourceRef,
      company: '更多',
      position: '简历已收到',
      eventType: 'rejection',
      title: '未通过',
      confidence: 0.95,
    });
    expect(bad.autoApplied).toBe(false);

    const parsed = parseRecruitmentMessage({
      subject: '名创优品集团2027届校园招聘简历筛选结果反馈',
      from: '名创优品招聘 <notice@shmail.ibeisen.com>',
      text: '感谢您对名创优品集团2027届校园招聘的关注。您投递的简历已收到。我们在对您简历经过多方面评估后，很遗憾地通知你，目前您的简历和本次投递的岗位暂不匹配。更多校园招聘动态请关注 MINISO名创优品招聘。',
      receivedAt: new Date('2026-09-22T00:59:53.000Z'),
      messageId: sourceRef.slice(5),
    });
    expect(parsed).not.toBeNull();
    const result = service.ingest(parsed!);

    expect(result.autoApplied).toBe(true);
    expect(result.candidate).toMatchObject({
      id: bad.candidate.id,
      company: '名创优品',
      position: '',
      confidence: 0.95,
      suggestedJobId: darkHorse.id,
      status: 'applied',
    });
    expect(store.getJob(darkHorse.id)?.status).toBe('已拒绝');
    expect(store.getJob(operations.id)?.status).toBe('已投递');
    expect(
      store.getJob(darkHorse.id)?.events.filter((event) => event.type === 'rejection'),
    ).toHaveLength(1);
    expect(store.getJob(operations.id)?.events.some((event) => event.type === 'rejection')).toBe(
      false,
    );
  });

  it('北森邮件流同时命中多个岗位时仍保持待确认', () => {
    const first = store.createJob({ company: '名创优品', position: '黑马工程', status: '已投递' });
    const second = store.createJob({ company: '名创优品', position: '商品运营', status: '已投递' });
    store.addEvent(first.id, {
      type: 'application',
      source: 'email',
      dedupeKey: 'mail:<1000000000004_10001_20001_1000.sc-a@shmail.ibeisen.com>',
    });
    store.addEvent(second.id, {
      type: 'application',
      source: 'email',
      dedupeKey: 'mail:<1000000000005_10001_20001_1001.sc-b@shmail.ibeisen.com>',
    });

    const result = service.ingest({
      source: 'email',
      sourceRef: 'mail:<1000000000003_10001_20001_30003.sc-c@shmail.ibeisen.com>',
      company: '名创优品',
      position: '',
      eventType: 'rejection',
      title: '未通过',
      evidence: '名创优品简历筛选未通过',
      confidence: 0.82,
    });

    expect(result.autoApplied).toBe(false);
    expect(result.candidate.status).toBe('pending');
    expect(store.getJob(first.id)?.status).toBe('已投递');
    expect(store.getJob(second.id)?.status).toBe('已投递');
  });
});
