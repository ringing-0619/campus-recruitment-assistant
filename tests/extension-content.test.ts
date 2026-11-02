import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/db.js';
import { createServer } from '../src/server/app.js';

const contentSource = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');

interface ApplicationCardFixture {
  company: string;
  position: string;
  externalApplicationId: string;
  date: string;
}

interface CandidatePayload {
  market?: string;
  company: string;
  position: string;
  externalApplicationId?: string;
  sourceRef?: string;
  eventType?: string;
  title?: string;
}

interface RuntimeMessage {
  type: string;
  payloads?: CandidatePayload[];
}

interface PreviewItem {
  key: string;
  company: string;
  position: string;
  externalApplicationId: string;
  eventType?: string;
  title?: string;
  recruitmentType?: string;
}

type ContentMessageListener = (
  message: Record<string, unknown>,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | void;

class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;

  constructor(
    public textContent: string,
    public id = '',
    public tagName = 'DIV',
    public className = '',
    public attributes: Record<string, string> = {},
  ) {}

  querySelectorAll(selector = '*') {
    const descendants = this.allDescendants();
    return selector === '*'
      ? descendants
      : descendants.filter((element) => matchesSelector(element, selector));
  }

  closest(selector: string): FakeElement | null {
    if (selector !== '[id]') return null;
    for (let current: FakeElement | null = this; current; current = current.parentElement) {
      if (current.id) return current;
    }
    return null;
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  setDescendants(descendants: FakeElement[]) {
    this.children = descendants;
    for (const descendant of descendants) descendant.parentElement = this;
  }

  private allDescendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.allDescendants()]);
  }
}

function matchesSelector(element: FakeElement, selector: string) {
  return selector.split(',').some((part) => {
    const simple = part.trim().split(/\s+/).at(-1) || '';
    if (simple === '*') return true;
    if (/^h[1-6]$/i.test(simple)) return element.tagName.toLowerCase() === simple.toLowerCase();
    if (simple.startsWith('#')) return element.id === simple.slice(1);
    if (simple.startsWith('.')) return element.className.split(/\s+/).includes(simple.slice(1));
    const attr = simple.match(/^(?:([a-z]+))?\[([\w-]+)(?:="([^"]*)")?\]$/i);
    if (attr)
      return (
        (!attr[1] || element.tagName.toLowerCase() === attr[1].toLowerCase()) &&
        (attr[3] === undefined
          ? attr[2] in element.attributes
          : element.attributes[attr[2]] === attr[3])
      );
    const classContains = simple.match(/^\[class\*="([^"]+)"\]$/)?.[1];
    if (classContains) return element.className.includes(classContains);
    const classToken = simple.match(/^\[class~="([^"]+)"\]$/)?.[1];
    if (classToken) return element.className.split(/\s+/).includes(classToken);
    return false;
  });
}

function fakeNode(
  tagName: string,
  className: string,
  textContent = '',
  children: FakeElement[] = [],
  id = '',
  attributes: Record<string, string> = {},
) {
  const node = new FakeElement(
    textContent || children.map((child) => child.textContent).join(' '),
    id,
    tagName,
    className,
    attributes,
  );
  node.setDescendants(children);
  return node;
}

function applicationCard(fixture: ApplicationCardFixture) {
  const marker = new FakeElement('投递成功');
  const leaves = [
    marker,
    new FakeElement(`${fixture.position}【2027校园招聘】`),
    new FakeElement('待处理简历'),
    new FakeElement(`所属公司：${fixture.company}`),
    new FakeElement('所属部门：海外事业部'),
    new FakeElement('简历名称：测试简历'),
    new FakeElement(`投递时间：${fixture.date}`),
  ];
  const detail = new FakeElement(
    leaves.map((element) => element.textContent).join(''),
    fixture.externalApplicationId,
  );
  detail.setDescendants(leaves);
  return { detail, leaves };
}

function createPageHarness(page: {
  roots: FakeElement[];
  title: string;
  hostname: string;
  pathname: string;
  href: string;
  captureContext?: { enabled: boolean; market: string };
  captureOutcome?: 'applied' | 'pending';
  submitBatch?: (payloads: CandidatePayload[]) => Promise<unknown>;
}) {
  const allElements = page.roots.flatMap((root) => [root, ...root.querySelectorAll('*')]);
  const bodyText = page.roots.map((root) => root.textContent).join(' ');
  const runtimeMessages: RuntimeMessage[] = [];
  let listener: ContentMessageListener | undefined;
  let connectListener: ((port: unknown) => void) | undefined;

  const document = {
    title: page.title,
    body: { innerText: bodyText },
    documentElement: {},
    querySelectorAll(selector: string) {
      return selector === '*'
        ? allElements
        : allElements.filter((element) => matchesSelector(element, selector));
    },
    querySelector(selector: string) {
      return allElements.find((element) => matchesSelector(element, selector)) || null;
    },
    addEventListener() {},
  };

  const chrome = {
    runtime: {
      onConnect: {
        addListener(nextListener: (port: unknown) => void) {
          connectListener = nextListener;
        },
      },
      onMessage: {
        addListener(nextListener: ContentMessageListener) {
          listener = nextListener;
        },
      },
      async sendMessage(message: RuntimeMessage) {
        runtimeMessages.push(message);
        if (message.type === 'capture-context')
          return { ok: true, ...(page.captureContext || { enabled: true, market: 'cn' }) };
        if (message.type !== 'candidate-batch') return { ok: true };
        if (page.submitBatch) return page.submitBatch(message.payloads || []);
        return {
          ok: true,
          results: (message.payloads ?? []).map(() => ({
            ok: true,
            result: {
              autoApplied: page.captureOutcome !== 'pending',
              candidate: { status: page.captureOutcome || 'applied' },
            },
          })),
        };
      },
    },
  };

  class FakeMutationObserver {
    constructor(_callback: () => void) {}
    observe() {}
  }

  runInNewContext(
    contentSource,
    {
      window: {},
      document,
      chrome,
      location: {
        hostname: page.hostname,
        pathname: page.pathname,
        href: page.href,
        hash: new URL(page.href).hash,
      },
      MutationObserver: FakeMutationObserver,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    },
    { filename: 'extension/content.js' },
  );

  if (!listener) throw new Error('content.js did not register a runtime message listener');

  async function dispatch(message: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve) => {
      listener!(message, {}, resolve);
    });
  }

  function connectEditor() {
    let disconnectListener: (() => void) | undefined;
    connectListener?.({
      name: 'capture-editor',
      onDisconnect: {
        addListener(listener: () => void) {
          disconnectListener = listener;
        },
      },
    });
    return () => disconnectListener?.();
  }
  return { dispatch, runtimeMessages, connectEditor };
}

function createHarness(fixtures: ApplicationCardFixture[]) {
  const cards = fixtures.map(applicationCard);
  return createPageHarness({
    roots: cards.map((card) => card.detail),
    title: '中国一汽校园招聘 - 我的投递',
    hostname: 'faw-zhaopin.hotjob.cn',
    pathname: '/SU603374380dcad4635b836531/pb/account.html',
    href: 'https://faw-zhaopin.hotjob.cn/SU603374380dcad4635b836531/pb/account.html#/myDeliver',
  });
}

// 智联真实投递进程页的语义结构；默认只有展开的第三志愿渲染进度，无投递日期。
function zhaopinPhaseHarness(
  options: {
    expanded?: number;
    status?: string;
    href?: string;
    company?: string;
    submitBatch?: (payloads: CandidatePayload[]) => Promise<unknown>;
  } = {},
) {
  const company = options.company || '赛尔网络有限公司';
  const roles = ['战略规划专员', '国际贸易销售专员', '高管助理'];
  const roots = [
    fakeNode('DIV', 'phase-process', '', [
      fakeNode('DIV', 'company-info', '', [
        fakeNode('DIV', 'company-info__wrap', '', [
          fakeNode('DIV', 'company-info__wrap-name', company),
          fakeNode('DIV', 'company-info__wrap-info', '1000-9999人 产业互联网平台 国企'),
        ]),
      ]),
      ...roles.map((position, index) =>
        fakeNode('DIV', 'delivery-item', '', [
          fakeNode('DIV', 'delivery-item__wrap', '', [
            fakeNode('DIV', 'delivery-item__wrap-number', `第${index + 1}志愿`),
            fakeNode('DIV', 'delivery-item__wrap-job', position),
            fakeNode(
              'DIV',
              'delivery-item__wrap-company',
              `${company}${index === 1 ? '（浙江分公司）' : '(总部）'}`,
            ),
            fakeNode('DIV', 'delivery-item__wrap-btn', '展开'),
          ]),
          ...((options.expanded ?? 2) === index
            ? [
                fakeNode('DIV', 'delivery-item__timeline', '', [
                  fakeNode('DIV', 'phase-timeline', '', [
                    fakeNode(
                      'SPAN',
                      'phase-timeline__item-wrapper--success',
                      options.status || '投递成功',
                    ),
                  ]),
                ]),
              ]
            : []),
        ]),
      ),
    ]),
    fakeNode('FOOTER', '', '智联招聘网版权所有'),
  ];
  return createPageHarness({
    roots,
    title: '投递进程_我的校园_智联校园招聘_智联招聘',
    hostname: 'xiaoyuan.zhaopin.com',
    pathname: '/scrd/phase/process',
    href: options.href || 'https://xiaoyuan.zhaopin.com/scrd/phase/process?projectId=104576',
    captureContext: { enabled: false, market: 'cn' },
    submitBatch: options.submitBatch,
  });
}

describe('智联多志愿与平台、雇主身份隔离', () => {
  it('展开状态不影响三个岗位的识别，保留各自招聘主体，不伪造日期或申请编号', async () => {
    for (const expanded of [0, 1, 2, -1]) {
      const harness = zhaopinPhaseHarness({ expanded });
      const preview = (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
        items: PreviewItem[];
      };
      expect(
        preview.items.map((item) => [item.company, item.position, item.externalApplicationId]),
      ).toEqual([
        ['赛尔网络有限公司(总部）', '战略规划专员', ''],
        ['赛尔网络有限公司（浙江分公司）', '国际贸易销售专员', ''],
        ['赛尔网络有限公司(总部）', '高管助理', ''],
      ]);
      expect(new Set(preview.items.map((item) => item.key)).size).toBe(3);
      await harness.dispatch({ type: 'record-current', market: 'cn', items: preview.items });
      const payloads = harness.runtimeMessages.flatMap((message) => message.payloads || []);
      expect(payloads).toHaveLength(3);
      expect(payloads.every((payload) => !('application' in payload))).toBe(true);
    }
  });
  it('进度仅作用于所属卡片，其他收起的志愿保持已投递', async () => {
    const harness = zhaopinPhaseHarness({ expanded: 1, status: '面试中' });
    const preview = (await harness.dispatch({ type: 'preview-current' })) as {
      items: PreviewItem[];
    };
    expect(preview.items.map((item) => item.eventType)).toEqual([
      'application',
      'interview',
      'application',
    ]);
  });
  it('使用页面公司字段而非硬编码企业名称，项目参数纳入来源身份', async () => {
    const first = zhaopinPhaseHarness({ company: '星河科技有限公司' });
    const second = zhaopinPhaseHarness({
      company: '星河科技有限公司',
      href: 'https://xiaoyuan.zhaopin.com/scrd/phase/process?projectId=204576',
    });
    const a = (await first.dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };
    const b = (await second.dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };
    expect(a.items[0].company).toBe('星河科技有限公司(总部）');
    expect(
      a.items.map((item) => item.key).some((key) => b.items.some((item) => item.key === key)),
    ).toBe(false);
  });
  it.each([
    '智联招聘',
    '智联校园招聘',
    '智联',
    '前程无忧',
    '51job',
    'BOSS直聘',
    '猎聘',
    'Workday',
    'Greenhouse',
    'Moka',
    '北森',
  ])('平台 %s 不能作为自动识别的雇主', async (platform) => {
    const harness = createPageHarness({
      roots: [
        fakeNode('DIV', 'company-name', platform),
        fakeNode('H1', '', '数据分析师'),
        fakeNode('P', '', '投递成功'),
      ],
      title: `投递进程_我的校园_${platform}`,
      hostname: 'jobs.example.com',
      pathname: '/submitted',
      href: 'https://jobs.example.com/submitted',
    });
    const preview = (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
      items: PreviewItem[];
    };
    expect(preview.items[0].company).toBe('');
    await harness.dispatch({ type: 'inspect-now' });
    expect(harness.runtimeMessages.some((message) => message.type === 'candidate-batch')).toBe(
      false,
    );
  });
  it('显式公司字段优先于平台品牌、站点名、页脚，跳过无效的第一个公司节点', async () => {
    const harness = createPageHarness({
      roots: [
        fakeNode('DIV', 'company-name', '智联招聘'),
        fakeNode('DIV', 'company-name', '赛尔网络有限公司'),
        fakeNode('DIV', 'brand-name', '智联校园'),
        fakeNode('META', '', '', [], '', { property: 'og:site_name', content: '智联招聘' }),
        fakeNode('H1', '', '数据分析师'),
        fakeNode('P', '', '投递成功'),
      ],
      title: '投递进程_我的校园_智联招聘',
      hostname: 'xiaoyuan.zhaopin.com',
      pathname: '/submitted',
      href: 'https://xiaoyuan.zhaopin.com/submitted',
    });
    expect(
      ((await harness.dispatch({ type: 'preview-current' })) as { items: PreviewItem[] }).items[0]
        .company,
    ).toBe('赛尔网络有限公司');
  });
  it('同页多个雇主各从自己的卡片取公司，不借用第一家公司的名称', async () => {
    const roots = ['星河科技', '远山科技'].map((company, index) =>
      fakeNode('DIV', 'application-card', '', [
        fakeNode('DIV', 'company-name', company),
        fakeNode('DIV', 'job-name', index === 0 ? '数据分析师' : '产品经理'),
        fakeNode('SPAN', '', '投递成功'),
        fakeNode('SPAN', '', '投递时间：2026-11-01 10:00'),
      ]),
    );
    const harness = createPageHarness({
      roots,
      title: '我的投递_智联招聘',
      hostname: 'xiaoyuan.zhaopin.com',
      pathname: '/record',
      href: 'https://xiaoyuan.zhaopin.com/record',
    });
    const preview = (await harness.dispatch({ type: 'preview-current' })) as {
      items: PreviewItem[];
    };
    expect(preview.items.map((item) => [item.company, item.position])).toEqual([
      ['星河科技', '数据分析师'],
      ['远山科技', '产品经理'],
    ]);
  });
  it('不把名称中含有平台字样的真实企业误伤', async () => {
    const harness = createPageHarness({
      roots: [
        fakeNode('DIV', 'company-name', '北京智联科技有限公司'),
        fakeNode('H1', '', '数据分析师'),
      ],
      title: '北京智联科技有限公司校园招聘',
      hostname: 'example.com',
      pathname: '/job',
      href: 'https://example.com/job',
    });
    expect(
      ((await harness.dispatch({ type: 'preview-current' })) as { items: PreviewItem[] }).items[0]
        .company,
    ).toBe('北京智联科技有限公司');
  });
  it('通用卡片没有日期也可从独立进度确认，不会把相邻卡片公司补给缺失的雇主', async () => {
    const roots = ['星河科技', ''].map((company, index) =>
      fakeNode('DIV', 'application-card', '', [
        ...(company ? [fakeNode('DIV', 'company-name', company)] : []),
        fakeNode('DIV', 'job-name', index === 0 ? '数据分析师' : '产品经理'),
        fakeNode('SPAN', '', '投递成功'),
      ]),
    );
    const harness = createPageHarness({
      roots,
      title: '我的投递_智联招聘',
      hostname: 'xiaoyuan.zhaopin.com',
      pathname: '/record',
      href: 'https://xiaoyuan.zhaopin.com/record',
    });
    const preview = (await harness.dispatch({ type: 'preview-current' })) as {
      items: PreviewItem[];
    };
    expect(preview.items.map((item) => [item.company, item.position])).toEqual([
      ['星河科技', '数据分析师'],
      ['', '产品经理'],
    ]);
  });
  it('投递成功页里的相似职位推荐不是本次申请，不从推荐区补公司与岗位', async () => {
    const harness = createPageHarness({
      roots: [
        fakeNode('H6', '', '恭喜你，完成投递！'),
        fakeNode('DIV', 'recommend-list', '', [
          fakeNode('DIV', 'company-name', '其他公司'),
          fakeNode('DIV', 'job-name', '其他岗位'),
        ]),
      ],
      title: '投递结果',
      hostname: 'xiaoyuan.zhaopin.com',
      pathname: '/scrd/delivery/completed2',
      href: 'https://xiaoyuan.zhaopin.com/scrd/delivery/completed2?projectId=104576',
    });
    const preview = (await harness.dispatch({ type: 'preview-current' })) as {
      items: PreviewItem[];
    };
    expect(preview.items[0]).toMatchObject({ company: '', position: '' });
  });
  it('三个志愿经真实接口独立入库，展开切换和重复采集不重复，日期保持未知', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'campus-zhaopin-'));
    const store = new Store(join(dir, 'test.sqlite'));
    store.db.exec(
      'DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM events; DELETE FROM candidates; DELETE FROM jobs;',
    );
    store.setSetting('extension_token', 'test-token');
    const unrelated = store.createJob({ company: '其他公司', position: '战略规划专员' });
    const { app } = await createServer({ store, startMail: false });
    try {
      for (const expanded of [0, 1, 2, 0]) {
        const harness = zhaopinPhaseHarness({
          expanded,
          async submitBatch(payloads) {
            const results = [];
            for (const payload of payloads) {
              const response = await app.inject({
                method: 'POST',
                url: '/api/v1/candidates',
                headers: { 'x-campus-token': 'test-token' },
                payload: { ...payload, source: 'website' },
              });
              expect(response.statusCode).toBe(200);
              expect(response.json().autoApplied).toBe(true);
              results.push({ ok: true, result: response.json() });
            }
            return { ok: true, results };
          },
        });
        const preview = (await harness.dispatch({ type: 'preview-current' })) as {
          items: PreviewItem[];
        };
        await harness.dispatch({ type: 'record-current', market: 'cn', items: preview.items });
      }
      const jobs = store.listJobs().filter((job) => job.company.startsWith('赛尔网络'));
      expect(jobs).toHaveLength(3);
      expect(
        jobs.every((job) => job.events.length === 1 && job.application?.dateSource === 'unknown'),
      ).toBe(true);
      expect(store.getJob(unrelated.id)?.events).toHaveLength(0);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('平台本身招聘时可使用申请卡片中的明确雇主字段，也允许用户主动填写公司', async () => {
    const harness = createPageHarness({
      roots: [
        fakeNode('DIV', 'application-card', '', [
          fakeNode('SPAN', 'company-name', '北森'),
          fakeNode('SPAN', 'job-name', '服务管培生'),
          fakeNode('SPAN', '', '投递成功'),
        ]),
      ],
      title: '我的投递_智联招聘',
      hostname: 'xiaoyuan.zhaopin.com',
      pathname: '/record',
      href: 'https://xiaoyuan.zhaopin.com/record',
    });
    const preview = (await harness.dispatch({ type: 'preview-current' })) as {
      items: PreviewItem[];
    };
    expect(preview.items[0]).toMatchObject({ company: '北森', position: '服务管培生' });
    await harness.dispatch({ type: 'record-current', market: 'cn', items: preview.items });
    expect(harness.runtimeMessages.flatMap((message) => message.payloads || [])[0]).toMatchObject({
      company: '北森',
      companySource: 'employer-field',
    });
    const manual = createPageHarness({
      roots: [],
      title: '我的投递_智联招聘',
      hostname: 'xiaoyuan.zhaopin.com',
      pathname: '/record',
      href: 'https://xiaoyuan.zhaopin.com/record',
    });
    await manual.dispatch({
      type: 'record-current',
      market: 'cn',
      items: [{ key: 'manual:new', company: '智联招聘', position: '服务管培生' }],
    });
    expect(manual.runtimeMessages.flatMap((message) => message.payloads || [])[0]).toMatchObject({
      company: '智联',
      companySource: 'manual',
    });
  });
});

function bilibiliCard(position: string, status: string, date: string) {
  const marker = fakeNode('DIV', 'status normal-status', status);
  const right = fakeNode('ARTICLE', 'record-item-rignt', '', [
    fakeNode('SPAN', '', `${date} 投递`),
    fakeNode('SPAN', '', '官网主投'),
    marker,
  ]);
  const heading = fakeNode('H4', 'item-title', '', [fakeNode('SPAN', 'text', position)]);
  const left = fakeNode('ARTICLE', 'record-item-left', '', [
    heading,
    fakeNode('DIV', 'item-subtitle', '上海 | 项目管理类 | 全职 | 2026-09-14 发布'),
  ]);
  return fakeNode('SECTION', 'bili-record-campus-card', '', [
    fakeNode('ARTICLE', 'record-item-top', '', [right, left]),
    fakeNode('BUTTON', '', '撤回投递'),
    fakeNode('BUTTON', '', '更新简历'),
  ]);
}

function createBilibiliHarness(cards: FakeElement[]) {
  return createPageHarness({
    roots: cards,
    title: '哔哩哔哩-招聘',
    hostname: 'jobs.bilibili.com',
    pathname: '/campus/records',
    href: 'https://jobs.bilibili.com/campus/records',
  });
}

function bokeApplicationCard(position: string, preference: number, date: string) {
  const preferenceText = `第 ${preference} 志愿`;
  const nameText = fakeNode(
    'SPAN',
    'applicationListItem-name-text',
    `${position}${preferenceText}`,
    [fakeNode('SPAN', 'volunteer-tag__29d94f volunteer-tag-active__29d94f', preferenceText)],
  );
  const title = fakeNode('DIV', 'sofiaBold title__29d94f', '', [
    fakeNode('DIV', 'name__29d94f applicationListItem-name', '', [nameText]),
    fakeNode('SPAN', 'delivery-tag delivery-tag-blue', '官网投递'),
  ]);
  const progress = fakeNode('DIV', 'container__f6ebd5', '', [
    fakeNode('DIV', 'action action-ellipsis', '投递简历'),
    fakeNode('DIV', 'date', date),
  ]);
  return fakeNode('DIV', 'applicationItem__29d94f applicationListItem', '', [
    title,
    fakeNode('DIV', 'subTitle__29d94f applicationListItem-subTitle', '上海校招 - 正式研发'),
    fakeNode('DIV', 'perferedCityInfo__29d94f', '意向城市：1上海'),
    progress,
  ]);
}

function createBokeHarness(cards: FakeElement[], includeBrand = true) {
  const applicationList = cards.length ? [fakeNode('DIV', 'applicationItems', '', cards)] : [];
  const roots = includeBrand
    ? [fakeNode('DIV', 'topbar-site-title', '波克校园招聘'), ...applicationList]
    : applicationList;
  return createPageHarness({
    roots,
    title: '应聘记录 - 波克校园招聘',
    hostname: 'boke.jobs.feishu.cn',
    pathname: '/581609/position/application',
    href: 'https://boke.jobs.feishu.cn/581609/position/application',
  });
}

function beisenDeliveryCard(
  position: string,
  applicationId: string,
  date: string,
  semanticClass = true,
) {
  const jobNameClass = semanticClass
    ? 'stylest__STJobName-editor__sc-6zstm6-4 delivery-list-job_name'
    : 'generated-title-token';
  const name = fakeNode('SPAN', jobNameClass, `${position}(${applicationId})`);
  const content = fakeNode('DIV', 'generated-content-container', '', [
    fakeNode('DIV', 'generated-flex-container', '', [name]),
    fakeNode('DIV', 'generated-flex-container', '', [
      fakeNode('DIV', 'generated-common-data', '校园招聘'),
      fakeNode('DIV', 'generated-common-data', `${date} 投递`),
    ]),
  ]);
  return fakeNode('DIV', 'generated-record-root', '', [
    content,
    fakeNode('DIV', 'generated-actions', '', [
      fakeNode('BUTTON', '', '编辑'),
      fakeNode('BUTTON', '', '查看/打印'),
    ]),
  ]);
}

function createBeisenDeliveryHarness(options: {
  cards: FakeElement[];
  company: string;
  hostname: string;
  title?: string;
}) {
  return createPageHarness({
    roots: [
      fakeNode('SECTION', 'generated-delivery-list', '', options.cards),
      fakeNode('FOOTER', '', `© 2026 ${options.company}校招 京ICP备00000000号 Powered by Beisen`),
    ],
    title: options.title ?? `${options.company}校招`,
    hostname: options.hostname,
    pathname: '/personal/deliveryRecord',
    href: `https://${options.hostname}/personal/deliveryRecord`,
  });
}

function mokaApplicationCard(
  position: string,
  status: string,
  displayedAt: string,
  applicationId = '',
) {
  const heading = fakeNode(
    'SPAN',
    'sd-foundation-heading-50-generated font-style-generated',
    position,
  );
  const topChildren = [fakeNode('DIV', 'sd-Spacing-spacing-inline-generated', '', [heading])];
  if (applicationId) {
    topChildren.push(
      fakeNode('A', 'sd-foundation-n70-generated', '', [fakeNode('SPAN', '', '修改申请')], '', {
        href: `#/apply/edit/${applicationId}`,
      }),
    );
  }
  return fakeNode('DIV', 'preference-generated-card', '', [
    fakeNode('DIV', 'preference-top-generated', '', topChildren),
    fakeNode('DIV', 'preference-bottom-generated', '', [
      fakeNode('SPAN', 'sd-foundation-n60-generated', '状态:'),
      fakeNode('SPAN', 'application-status-generated detail-text-generated', status),
      fakeNode('SPAN', 'sd-foundation-n60-generated', '项目:'),
      fakeNode('SPAN', 'detail-text-generated', '-'),
      fakeNode('SPAN', '', displayedAt),
    ]),
  ]);
}

function createMokaHarness(cards: FakeElement[]) {
  return createPageHarness({
    roots: [fakeNode('MAIN', 'position-block-generated', '', cards)],
    title: '九号公司 - 校园招聘',
    hostname: 'app.mokahr.com',
    pathname: '/campus-recruitment/ninebot/45627',
    href: 'https://app.mokahr.com/campus-recruitment/ninebot/45627?locale=zh-CN#/candidateHome/applications',
  });
}

const fawCards: ApplicationCardFixture[] = [
  {
    company: '一汽红旗',
    position: '战略规划架构师',
    externalApplicationId: '000000000000000000000004',
    date: '2026-09-20 23:37',
  },
  {
    company: '一汽奔腾',
    position: '海外营销管理员（奔腾国际公司）',
    externalApplicationId: '000000000000000000000003',
    date: '2026-09-20 23:28',
  },
];

describe('extension/content.js 一汽投递列表', () => {
  it('preview-current 精确返回两张投递卡', async () => {
    const { dispatch } = createHarness(fawCards);
    const preview = (await dispatch({ type: 'preview-current' })) as {
      ok: boolean;
      items: PreviewItem[];
    };

    expect(preview.ok).toBe(true);
    expect(
      preview.items.map(({ company, position, externalApplicationId }) => ({
        company,
        position,
        externalApplicationId,
      })),
    ).toEqual([
      {
        company: '一汽红旗',
        position: '战略规划架构师',
        externalApplicationId: '000000000000000000000004',
      },
      {
        company: '一汽奔腾',
        position: '海外营销管理员（奔腾国际公司）',
        externalApplicationId: '000000000000000000000003',
      },
    ]);
  });

  it('只有一张投递卡时 preview-current 只返回一项', async () => {
    const { dispatch } = createHarness([fawCards[0]]);
    const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };

    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({
      company: '一汽红旗',
      position: '战略规划架构师',
      externalApplicationId: '000000000000000000000004',
    });
  });

  it('record-current 逐项覆盖并用一次 candidate-batch 提交，重复提交返回 duplicate', async () => {
    const { dispatch, runtimeMessages } = createHarness(fawCards);
    const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };
    const submittedItems = [
      { key: preview.items[0].key, company: '中国一汽红旗', position: '战略规划架构师（修正）' },
      { key: preview.items[1].key, company: '一汽奔腾汽车', position: '海外营销管理员（修正）' },
    ];

    const firstResult = (await dispatch({
      type: 'record-current',
      items: submittedItems,
    })) as Array<{ ok: boolean }>;
    expect(firstResult).toHaveLength(2);
    expect(firstResult.every((result) => result.ok)).toBe(true);

    const batchMessages = runtimeMessages.filter((message) => message.type === 'candidate-batch');
    expect(batchMessages).toHaveLength(1);
    expect(runtimeMessages.some((message) => message.type === 'candidate')).toBe(false);
    expect(batchMessages[0].payloads).toHaveLength(2);
    expect(
      batchMessages[0].payloads?.map(({ company, position }) => ({ company, position })),
    ).toEqual([
      { company: '中国一汽红旗', position: '战略规划架构师（修正）' },
      { company: '一汽奔腾汽车', position: '海外营销管理员（修正）' },
    ]);

    const repeatedResult = (await dispatch({
      type: 'record-current',
      items: submittedItems,
    })) as Array<{ ok: boolean; duplicate?: boolean }>;
    expect(repeatedResult).toMatchObject([
      { ok: true, duplicate: true },
      { ok: true, duplicate: true },
    ]);
    expect(runtimeMessages.filter((message) => message.type === 'candidate-batch')).toHaveLength(1);
  });
});

describe('extension/content.js 美国投递与模块归属', () => {
  function americanPage(context = { enabled: false, market: 'cn' }) {
    return createPageHarness({
      roots: [
        fakeNode('H1', '', 'Application submitted'),
        fakeNode(
          'DIV',
          '',
          'Your application has been submitted. We may contact you for an interview. Company: Acme Labs Job title: Software Engineer Location: New York',
        ),
      ],
      title: 'Application submitted | Acme Labs',
      hostname: 'jobs.example.com',
      pathname: '/confirmation',
      href: 'https://jobs.example.com/confirmation',
      captureContext: context,
    });
  }

  it('未选择模块时只预览，不抢先把美国投递写入国内', async () => {
    const { dispatch, runtimeMessages } = americanPage();
    const preview = (await dispatch({ type: 'preview-current', market: 'us' })) as {
      items: PreviewItem[];
    };
    expect(preview.items[0]).toMatchObject({
      company: 'Acme Labs',
      position: 'Software Engineer',
      eventType: 'application',
    });
    expect(await dispatch({ type: 'inspect-now' })).toMatchObject({ needsModule: true });
    expect(runtimeMessages.some((message) => message.type === 'candidate-batch')).toBe(false);
    await dispatch({ type: 'inspect-now', market: 'us' });
    expect(
      runtimeMessages.find((message) => message.type === 'candidate-batch')?.payloads?.[0],
    ).toMatchObject({
      market: 'us',
      company: 'Acme Labs',
      position: 'Software Engineer',
      eventType: 'application',
    });
  });

  it('同一页面切换模块后可分别记录，同一模块重复识别仍去重', async () => {
    const { dispatch, runtimeMessages } = americanPage();
    await dispatch({ type: 'record-current', market: 'us' });
    const preview = (await dispatch({ type: 'preview-current', market: 'cn' })) as {
      items: PreviewItem[];
    };
    await dispatch({
      type: 'record-current',
      market: 'cn',
      items: [{ ...preview.items[0], company: '艾克米实验室' }],
    });
    await dispatch({ type: 'record-current', market: 'us' });
    expect(
      runtimeMessages
        .filter((message) => message.type === 'candidate-batch')
        .map((message) => message.payloads?.[0].market),
    ).toEqual(['us', 'cn']);
  });

  it('已为当前页面选择美国模块后，自动检查也携带美国归属', async () => {
    const { dispatch, runtimeMessages } = americanPage({ enabled: true, market: 'us' });
    await dispatch({ type: 'inspect-now' });
    expect(
      runtimeMessages.find((message) => message.type === 'candidate-batch')?.payloads?.[0].market,
    ).toBe('us');
  });

  it('英文成功页读取 JobPosting 元数据，不把 Thank you 或 Greenhouse 当公司岗位', async () => {
    const { dispatch, runtimeMessages } = createPageHarness({
      roots: [
        fakeNode('H1', '', 'Thank you for applying!'),
        fakeNode(
          'SCRIPT',
          '',
          JSON.stringify({
            '@type': 'JobPosting',
            title: 'Data Analyst',
            hiringOrganization: { name: 'Acme Labs' },
          }),
          [],
          '',
          { type: 'application/ld+json' },
        ),
      ],
      title: 'Thank you | Greenhouse',
      hostname: 'boards.greenhouse.io',
      pathname: '/confirmation',
      href: 'https://boards.greenhouse.io/acme/confirmation',
      captureContext: { enabled: true, market: 'us' },
    });
    await dispatch({ type: 'inspect-now' });
    expect(
      runtimeMessages.find((message) => message.type === 'candidate-batch')?.payloads?.[0],
    ).toMatchObject({ market: 'us', company: 'Acme Labs', position: 'Data Analyst' });
  });

  it('只有英文成功提示、没有岗位信息时要求补充，不把致谢语当岗位', async () => {
    const { dispatch } = createPageHarness({
      roots: [fakeNode('H1', '', 'Thank you for applying!')],
      title: 'Application submitted | Workday',
      hostname: 'company.myworkdayjobs.com',
      pathname: '/thanks',
      href: 'https://company.myworkdayjobs.com/thanks',
    });
    const preview = (await dispatch({ type: 'preview-current', market: 'us' })) as {
      items: PreviewItem[];
    };
    expect(preview.items[0]).toMatchObject({ company: '', position: '' });
    expect(await dispatch({ type: 'record-current', market: 'us' })).toMatchObject({
      needsInput: true,
    });
  });

  it('重复识别待确认项仍保留 pending，不把 duplicate 当自动采纳成功', async () => {
    const { dispatch } = createPageHarness({
      roots: [
        fakeNode('DIV', 'company-name', 'Acme Labs'),
        fakeNode('H1', '', 'Software Engineer'),
        fakeNode('P', '', 'Application submitted'),
      ],
      title: 'Application submitted | Acme Labs',
      hostname: 'jobs.example.com',
      pathname: '/thanks',
      href: 'https://jobs.example.com/thanks',
      captureOutcome: 'pending',
    });
    await dispatch({ type: 'record-current', market: 'us' });
    expect(await dispatch({ type: 'record-current', market: 'us' })).toMatchObject([
      {
        ok: true,
        duplicate: true,
        result: { autoApplied: false, candidate: { status: 'pending' } },
      },
    ]);
  });
});

describe('extension/content.js 通用投递进度卡', () => {
  it('从 B 站式无标签进度卡中识别公司、岗位和初筛状态', async () => {
    const { dispatch } = createBilibiliHarness([
      bilibiliCard('PMO经营分析管培生-游戏发行【2027届】', '初筛中', '2026-09-18'),
    ]);
    const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({
      company: '哔哩哔哩',
      position: 'PMO经营分析管培生-游戏发行【2027届】',
      eventType: 'application',
      title: '简历筛选中',
    });
  });

  it('自动检查命中进度卡时批量提交候选，不再上报未识别域名', async () => {
    const { dispatch, runtimeMessages } = createBilibiliHarness([
      bilibiliCard('PMO经营分析管培生-游戏发行【2027届】', '初筛中', '2026-09-18'),
    ]);
    await dispatch({ type: 'inspect-now' });
    const batches = runtimeMessages.filter((message) => message.type === 'candidate-batch');
    expect(batches).toHaveLength(1);
    expect(batches[0].payloads?.[0]).toMatchObject({
      company: '哔哩哔哩',
      position: 'PMO经营分析管培生-游戏发行【2027届】',
    });
    expect(runtimeMessages.some((message) => message.type === 'unrecognized-domain')).toBe(false);
  });

  it('多张无标签进度卡不会串联岗位，拒绝状态优先于 Offer 文字', async () => {
    const { dispatch } = createBilibiliHarness([
      bilibiliCard('PMO经营分析管培生-游戏发行【2027届】', '初筛中', '2026-09-18'),
      bilibiliCard('数据分析师【2027届】', 'Offer已拒绝', '2026-09-19'),
    ]);
    const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };
    expect(
      preview.items.map((item) => ({
        position: item.position,
        eventType: item.eventType,
        title: item.title,
      })),
    ).toEqual([
      {
        position: 'PMO经营分析管培生-游戏发行【2027届】',
        eventType: 'application',
        title: '简历筛选中',
      },
      { position: '数据分析师【2027届】', eventType: 'rejection', title: '未通过' },
    ]);
  });

  it('没有同卡投递证据时不会把普通 item-title 当成已投递岗位', async () => {
    const browsingCard = fakeNode('SECTION', 'position-list', '', [
      fakeNode('H4', 'item-title', '', [fakeNode('SPAN', 'text', '正在浏览的职位')]),
    ]);
    const { dispatch } = createBilibiliHarness([browsingCard]);
    const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };
    expect(preview.items[0]).toMatchObject({ company: '哔哩哔哩', position: '' });
  });

  it.each(['投递职位', '申请职位', '应聘岗位'])(
    '通用字段“%s”在下一个业务标签前停止',
    async (label) => {
      const { dispatch } = createPageHarness({
        roots: [
          fakeNode(
            'MAIN',
            '',
            `${label}：算法工程师 工作地点：上海 职位类别：技术类 职位描述：负责推荐系统`,
          ),
        ],
        title: '星河科技-招聘',
        hostname: 'jobs.example.com',
        pathname: '/application',
        href: 'https://jobs.example.com/application',
      });
      const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };
      expect(preview.items[0]).toMatchObject({ company: '星河科技', position: '算法工程师' });
    },
  );
});

describe('extension/content.js 北森自定义域投递记录', () => {
  it('在恒生自定义域识别岗位、申请编号和公司简称', async () => {
    const { dispatch } = createBeisenDeliveryHarness({
      cards: [beisenDeliveryCard('需求分析师', 'J90001', '2026-09-22 22:17')],
      company: '恒生',
      hostname: 'campus.hundsun.com',
    });

    const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };

    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({
      company: '恒生',
      position: '需求分析师',
      externalApplicationId: 'J90001',
      eventType: 'application',
      title: '投递成功',
    });
  });

  it('自动检查会提交恒生岗位，不再上报未识别域名', async () => {
    const { dispatch, runtimeMessages } = createBeisenDeliveryHarness({
      cards: [beisenDeliveryCard('需求分析师', 'J90001', '2026-09-22 22:17')],
      company: '恒生',
      hostname: 'campus.hundsun.com',
    });

    await dispatch({ type: 'inspect-now' });

    const batches = runtimeMessages.filter((message) => message.type === 'candidate-batch');
    expect(batches).toHaveLength(1);
    expect(batches[0].payloads?.[0]).toMatchObject({
      company: '恒生',
      position: '需求分析师',
      externalApplicationId: 'J90001',
    });
    expect(runtimeMessages.some((message) => message.type === 'unrecognized-domain')).toBe(false);
  });

  it('类名全部哈希化时仍按“岗位 + 投递日期”逐卡识别', async () => {
    const { dispatch } = createBeisenDeliveryHarness({
      cards: [
        beisenDeliveryCard('数据开发工程师', 'J20001', '2026-09-20 10:00', false),
        beisenDeliveryCard('产品运营', 'J20002', '2026-09-21 11:30', false),
      ],
      company: '星河',
      hostname: 'careers.example.com',
    });

    const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };

    expect(
      preview.items.map((item) => ({ company: item.company, position: item.position })),
    ).toEqual([
      { company: '星河', position: '数据开发工程师' },
      { company: '星河', position: '产品运营' },
    ]);
  });

  it('日期先于岗位渲染且夹有地点时仍选择岗位文本', async () => {
    const reorderedCard = fakeNode('DIV', 'opaque-card-token', '', [
      fakeNode('DIV', 'opaque-location-token', '上海'),
      fakeNode('DIV', 'opaque-date-token', '2026-09-22 22:17 投递'),
      fakeNode('DIV', 'opaque-title-token', '风险控制分析师(J20003)'),
      fakeNode('BUTTON', '', '查看/打印'),
    ]);
    const { dispatch } = createBeisenDeliveryHarness({
      cards: [reorderedCard],
      company: '星河',
      hostname: 'careers.example.com',
    });

    const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };

    expect(preview.items[0]).toMatchObject({
      company: '星河',
      position: '风险控制分析师',
      externalApplicationId: 'J20003',
    });
  });

  it('职位列表中的发布日期和“立即投递”不会触发自动记录', async () => {
    const listing = fakeNode('DIV', 'generated-record-root', '', [
      fakeNode('DIV', 'delivery-list-job_name', '算法工程师(J30001)'),
      fakeNode('DIV', 'generated-common-data', '2026-09-22 发布'),
      fakeNode('BUTTON', '', '立即投递'),
    ]);
    const { dispatch, runtimeMessages } = createPageHarness({
      roots: [listing],
      title: '星河校招',
      hostname: 'careers.example.com',
      pathname: '/campus/jobs',
      href: 'https://careers.example.com/campus/jobs',
    });

    await dispatch({ type: 'inspect-now' });

    expect(runtimeMessages.some((message) => message.type === 'candidate-batch')).toBe(false);
  });
});

describe('extension/content.js Moka 多岗位投递记录', () => {
  const cards = [
    mokaApplicationCard('会员运营专员（电动车）', '简历筛选', '9:37', '900000001'),
    mokaApplicationCard('助理数据分析工程师（电动车）', '暂不匹配', '2026-08-25 11:50'),
  ];

  it('逐卡识别当天相对时间、申请编号和旧岗位拒绝状态', async () => {
    const { dispatch } = createMokaHarness(cards);
    const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };

    expect(
      preview.items.map((item) => ({
        company: item.company,
        position: item.position,
        externalApplicationId: item.externalApplicationId,
        eventType: item.eventType,
        title: item.title,
      })),
    ).toEqual([
      {
        company: '九号公司',
        position: '会员运营专员（电动车）',
        externalApplicationId: '900000001',
        eventType: 'application',
        title: '简历筛选中',
      },
      {
        company: '九号公司',
        position: '助理数据分析工程师（电动车）',
        externalApplicationId: '',
        eventType: 'rejection',
        title: '未通过',
      },
    ]);
  });

  it('自动检查批量提交两张卡，不再生成空岗位整页拒绝', async () => {
    const { dispatch, runtimeMessages } = createMokaHarness(cards);

    await dispatch({ type: 'inspect-now' });

    const batches = runtimeMessages.filter((message) => message.type === 'candidate-batch');
    expect(batches).toHaveLength(1);
    expect(
      batches[0].payloads?.map((item) => ({ position: item.position, eventType: item.eventType })),
    ).toEqual([
      { position: '会员运营专员（电动车）', eventType: 'application' },
      { position: '助理数据分析工程师（电动车）', eventType: 'rejection' },
    ]);
    expect(runtimeMessages.some((message) => message.type === 'unrecognized-domain')).toBe(false);
  });

  it('投递列表尚未形成完整卡片时不退化为整页拒绝', async () => {
    const { dispatch, runtimeMessages } = createMokaHarness([
      fakeNode(
        'DIV',
        'loading-list',
        '会员运营专员 状态: 简历筛选 助理数据分析工程师 状态: 暂不匹配',
      ),
    ]);

    await dispatch({ type: 'inspect-now' });

    expect(runtimeMessages.some((message) => message.type === 'candidate-batch')).toBe(false);
    expect(runtimeMessages.some((message) => message.type === 'unrecognized-domain')).toBe(true);
  });
});

describe('extension/content.js 飞书招聘应聘记录', () => {
  it('从分离的投递动作和日期证据识别两张岗位卡', async () => {
    const { dispatch } = createBokeHarness([
      bokeApplicationCard('2027届秋招-活动运营（休闲棋牌）', 1, '2026-09-21'),
      bokeApplicationCard('2027届秋招-数据运营（休闲棋牌）', 2, '2026-09-21'),
    ]);
    const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };

    expect(
      preview.items.map((item) => ({
        company: item.company,
        position: item.position,
        eventType: item.eventType,
        title: item.title,
      })),
    ).toEqual([
      {
        company: '波克',
        position: '2027届秋招-活动运营（休闲棋牌）',
        eventType: 'application',
        title: '投递成功',
      },
      {
        company: '波克',
        position: '2027届秋招-数据运营（休闲棋牌）',
        eventType: 'application',
        title: '投递成功',
      },
    ]);
  });

  it('自动检查批量提交两个岗位，不再上报未识别域名', async () => {
    const { dispatch, runtimeMessages } = createBokeHarness([
      bokeApplicationCard('2027届秋招-活动运营（休闲棋牌）', 1, '2026-09-21'),
      bokeApplicationCard('2027届秋招-数据运营（休闲棋牌）', 2, '2026-09-21'),
    ]);

    await dispatch({ type: 'inspect-now' });

    const batches = runtimeMessages.filter((message) => message.type === 'candidate-batch');
    expect(batches).toHaveLength(1);
    expect(batches[0].payloads?.map(({ company, position }) => ({ company, position }))).toEqual([
      { company: '波克', position: '2027届秋招-活动运营（休闲棋牌）' },
      { company: '波克', position: '2027届秋招-数据运营（休闲棋牌）' },
    ]);
    expect(runtimeMessages.some((message) => message.type === 'unrecognized-domain')).toBe(false);
  });

  it('页面标题中的“应聘记录”只作为噪声，优先取招聘品牌', async () => {
    const { dispatch } = createBokeHarness([], false);
    const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };

    expect(preview.items[0]).toMatchObject({ company: '波克', position: '' });
  });

  it('可在可见品牌缺失时从通用租户元数据恢复公司名', async () => {
    const websiteInfo = new FakeElement(
      JSON.stringify({
        tenant_info: { tenant_name: '波克科技集团' },
      }),
      'js-websiteInfo',
      'SCRIPT',
    );
    const { dispatch } = createPageHarness({
      roots: [websiteInfo],
      title: '应聘记录',
      hostname: 'example.jobs.feishu.cn',
      pathname: '/position/application',
      href: 'https://example.jobs.feishu.cn/position/application',
    });
    const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };

    expect(preview.items[0]).toMatchObject({ company: '波克科技集团', position: '' });
  });

  it.each([
    ['波克校园招聘 - 应聘记录', '波克'],
    ['我的投递 | 星河科技招聘官网', '星河科技'],
    ['2027届秋招-发行运营 - 波克校园招聘', '波克'],
    ['恒生校招', '恒生'],
  ])('公司标题分段会过滤页面类型和岗位噪声：%s', async (title, company) => {
    const { dispatch } = createPageHarness({
      roots: [],
      title,
      hostname: 'jobs.example.com',
      pathname: '/position/application',
      href: 'https://jobs.example.com/position/application',
    });
    const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };

    expect(preview.items[0]).toMatchObject({ company, position: '' });
  });

  it('不把含发布日期和“立即投递”的职位列表误当成应聘记录', async () => {
    const listing = fakeNode('DIV', 'applicationItem', '', [
      fakeNode('DIV', 'applicationListItem-name', '算法工程师'),
      fakeNode('DIV', 'publish-date', '2026-09-21 发布'),
      fakeNode('BUTTON', '', '立即投递'),
    ]);
    const { dispatch } = createBokeHarness([listing]);
    const preview = (await dispatch({ type: 'preview-current' })) as { items: PreviewItem[] };

    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({ company: '波克', position: '' });
  });
});

describe('extension/content.js 秋招筛选与可编辑清单', () => {
  function paperCard(position: string, type: string, dates = ['2026-10-29']) {
    const card = fakeNode('DIV', 'applicationItem__29d94f applicationListItem', '', [
      fakeNode('DIV', 'applicationListItem-name', '', [
        fakeNode('SPAN', 'applicationListItem-name-text', position),
      ]),
      fakeNode('DIV', 'applicationListItem-subTitle', type),
      fakeNode(
        'DIV',
        'timeline',
        '',
        dates.map((date, index) =>
          fakeNode('DIV', 'step', '', [
            fakeNode('DIV', 'action', index ? '流程终止' : '投递简历'),
            fakeNode('DIV', 'date', date),
          ]),
        ),
      ),
    ]);
    return card;
  }
  function paperPage(cards: FakeElement[], title = '应聘记录 - 叠纸游戏校园招聘') {
    return createPageHarness({
      roots: [
        fakeNode(
          'SCRIPT',
          '',
          JSON.stringify({ tenant_info: { tenant_name: 'Papergames' } }),
          [],
          'js-websiteInfo',
        ),
        ...cards,
      ],
      title,
      hostname: 'career.papegames.com',
      pathname: '/campus/position/application',
      href: 'https://career.papegames.com/campus/position/application',
    });
  }
  it('叠纸两条秋招加历史实习：预览、手动记录、自动识别均只保留两条中文公司名', async () => {
    const harness = paperPage([
      paperCard('商务管培生-研发方向（2027届秋招）', '上海 校招 - 正式 项目：2027校园招聘（秋季）'),
      paperCard('商务管培生-综合方向（2027届秋招）', '上海 校招 - 正式 项目：2027校园招聘（秋季）'),
      paperCard('用户研究实习生', '上海 社招 - 实习', ['2026-02-07', '2026-03-02']),
    ]);
    const preview = (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
      items: PreviewItem[];
      excluded: PreviewItem[];
    };
    expect(
      preview.items.map((item) => [item.company, item.position, item.recruitmentType]),
    ).toEqual([
      ['叠纸游戏', '商务管培生-研发方向（2027届秋招）', 'autumn'],
      ['叠纸游戏', '商务管培生-综合方向（2027届秋招）', 'autumn'],
    ]);
    expect(preview.excluded).toHaveLength(1);
    expect(preview.excluded[0]).toMatchObject({
      position: '用户研究实习生',
      recruitmentType: 'internship',
    });
    await harness.dispatch({ type: 'inspect-now' });
    expect(
      harness.runtimeMessages.find((item) => item.type === 'candidate-batch')?.payloads,
    ).toHaveLength(2);
    const result = (await harness.dispatch({
      type: 'record-current',
      market: 'cn',
      items: preview.items,
    })) as { ok: boolean }[];
    expect(result).toHaveLength(2);
    expect(
      harness.runtimeMessages
        .flatMap((item) => item.payloads || [])
        .every((item) => item.company === '叠纸游戏' && !item.position.includes('实习')),
    ).toBe(true);
  });
  it('通用中文品牌优先于英文租户与 JobPosting，只有英文时使用可靠域名映射', async () => {
    const harness = paperPage([paperCard('数据分析（2027秋招）', '校招 - 正式')], '应聘记录');
    expect(
      (
        (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
          items: PreviewItem[];
        }
      ).items[0].company,
    ).toBe('叠纸游戏');
    const other = createPageHarness({
      roots: [
        fakeNode(
          'SCRIPT',
          '',
          JSON.stringify({
            '@type': 'JobPosting',
            hiringOrganization: { name: 'Starlight Labs' },
            title: '数据分析师',
          }),
          [],
          '',
          { type: 'application/ld+json' },
        ),
      ],
      title: '提交成功 | 星光科技校园招聘',
      hostname: 'jobs.example.com',
      pathname: '/submitted',
      href: 'https://jobs.example.com/submitted',
    });
    expect(
      (
        (await other.dispatch({ type: 'preview-current', market: 'cn' })) as {
          items: PreviewItem[];
        }
      ).items[0].company,
    ).toBe('星光科技');
    expect(
      (
        (await other.dispatch({ type: 'preview-current', market: 'us' })) as {
          items: PreviewItem[];
        }
      ).items[0].company,
    ).toBe('Starlight Labs');
  });
  it('共用 midas 根容器时，两条近似岗位经真实 API 独立入库，不误合并到得物，重复点击不重复创建', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'campus-paper-recording-'));
    const store = new Store(join(directory, 'test.sqlite'));
    store.db.exec(
      'DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM events; DELETE FROM candidates; DELETE FROM jobs;',
    );
    store.setSetting('extension_token', 'test-token');
    const dewu = store.createJob({
      company: '得物',
      position: '【27届校招】风控数据分析师',
      status: '已投递',
      externalApplicationId: 'midas-view-content',
      progressUrls: ['https://poizon.jobs.feishu.cn/position/application'],
    });
    const { app } = await createServer({ store, startMail: false });
    try {
      const harness = createPageHarness({
        roots: [
          fakeNode(
            'MAIN',
            '',
            '',
            [
              paperCard('商务管培生-研发方向（2027届秋招）', '校招 - 正式'),
              paperCard('商务管培生-综合方向（2027届秋招）', '校招 - 正式'),
              paperCard('用户研究实习生', '社招 - 实习', ['2026-02-07', '2026-03-02']),
            ],
            'midas-view-content',
          ),
        ],
        title: '应聘记录 - 叠纸游戏校园招聘',
        hostname: 'career.papegames.com',
        pathname: '/campus/position/application',
        href: 'https://career.papegames.com/campus/position/application',
        async submitBatch(payloads) {
          const results = [];
          for (const payload of payloads) {
            const response = await app.inject({
              method: 'POST',
              url: '/api/v1/candidates',
              headers: { 'x-campus-token': 'test-token' },
              payload: { ...payload, source: 'website' },
            });
            expect(response.statusCode).toBe(200);
            results.push({ ok: true, result: response.json() });
          }
          return { ok: true, results };
        },
      });
      const preview = (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
        items: PreviewItem[];
      };
      expect(preview.items).toHaveLength(2);
      expect(new Set(preview.items.map((item) => item.key)).size).toBe(2);
      expect(preview.items.map((item) => item.externalApplicationId)).toEqual(['', '']);
      await harness.dispatch({ type: 'record-current', market: 'cn', items: preview.items });
      await harness.dispatch({ type: 'record-current', market: 'cn', items: preview.items });
      const jobs = (await app.inject('/api/v1/jobs?market=cn')).json() as {
        company: string;
        position: string;
        events: unknown[];
      }[];
      expect(
        jobs
          .filter((job) => job.company === '叠纸游戏')
          .map((job) => job.position)
          .sort(),
      ).toEqual(['商务管培生-研发方向（2027届秋招）', '商务管培生-综合方向（2027届秋招）'].sort());
      expect(jobs).toHaveLength(3);
      expect(store.getJob(dewu.id)?.events).toHaveLength(0);
      expect(jobs.every((job) => !job.position.includes('实习'))).toBe(true);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('逐卡招聘类型优先：标题没有实习字样也能过滤，秋招页面导航不会污染正式岗位', async () => {
    const harness = paperPage([
      paperCard('用户研究', '社招 - 实习'),
      paperCard('商业分析（2027届秋招）', '校招 - 正式'),
      paperCard('财务分析', '项目：2027春季校园招聘'),
      paperCard('高级开发', '社会招聘'),
    ]);
    const preview = (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
      items: PreviewItem[];
      excluded: PreviewItem[];
    };
    expect(preview.items.map((item) => item.position)).toEqual(['商业分析（2027届秋招）']);
    expect(preview.excluded.map((item) => item.recruitmentType)).toEqual([
      'internship',
      'spring',
      'social',
    ]);
  });
  it('全是实习时返回空清单，不退回泛化提取重新记录第一条实习', async () => {
    const harness = paperPage([paperCard('用户研究', '社招 - 实习')]);
    expect(await harness.dispatch({ type: 'preview-current', market: 'cn' })).toMatchObject({
      items: [],
      excluded: [{ recruitmentType: 'internship' }],
    });
    await harness.dispatch({ type: 'inspect-now' });
    expect(harness.runtimeMessages.some((item) => item.type === 'candidate-batch')).toBe(false);
    expect(
      await harness.dispatch({ type: 'record-current', market: 'cn', items: [] }),
    ).toMatchObject({ needsInput: true, empty: true });
  });
  it('美国模块保留实习，国内 JobPosting 的 INTERN 用工类型会过滤', async () => {
    const harness = createPageHarness({
      roots: [
        fakeNode('P', '', 'Application submitted'),
        fakeNode(
          'SCRIPT',
          '',
          JSON.stringify({
            '@type': 'JobPosting',
            title: 'Research Assistant',
            hiringOrganization: { name: 'Acme' },
            employmentType: 'INTERN',
          }),
          [],
          '',
          { type: 'application/ld+json' },
        ),
      ],
      title: 'Application submitted | Acme',
      hostname: 'jobs.example.com',
      pathname: '/submitted',
      href: 'https://jobs.example.com/submitted',
    });
    expect(
      (
        (await harness.dispatch({ type: 'preview-current', market: 'us' })) as {
          items: PreviewItem[];
        }
      ).items,
    ).toHaveLength(1);
    expect(
      (
        (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
          items: PreviewItem[];
        }
      ).items,
    ).toHaveLength(0);
  });
  it('删除首项并编辑第二项、增加第三项：不按索引错配编号和状态，不恢复删除的条目', async () => {
    const harness = createHarness(fawCards);
    const preview = (await harness.dispatch({ type: 'preview-current' })) as {
      items: PreviewItem[];
    };
    await harness.dispatch({
      type: 'record-current',
      market: 'cn',
      items: [
        { ...preview.items[1], company: '一汽奔腾汽车', position: '海外营销管理（修正）' },
        { key: 'manual:new', company: '中国一汽', position: '人力资源管培生（2027秋招）' },
      ],
    });
    const batch =
      harness.runtimeMessages.find((message) => message.type === 'candidate-batch')?.payloads || [];
    expect(batch).toHaveLength(2);
    expect(batch[0]).toMatchObject({
      company: '一汽奔腾汽车',
      position: '海外营销管理（修正）',
      externalApplicationId: fawCards[1].externalApplicationId,
    });
    expect(batch[1]).toMatchObject({
      company: '中国一汽',
      position: '人力资源管培生（2027秋招）',
      eventType: 'application',
    });
    expect(batch[1].externalApplicationId).toBeUndefined();
    await harness.dispatch({ type: 'inspect-now' });
    expect(harness.runtimeMessages.filter((item) => item.type === 'candidate-batch')).toHaveLength(
      1,
    );
    expect(
      harness.runtimeMessages
        .flatMap((item) => item.payloads || [])
        .some((item) => item.externalApplicationId === fawCards[0].externalApplicationId),
    ).toBe(false);
  });
  it('侧栏编辑期间自动识别暂停，手动提交仍可完成', async () => {
    const harness = createHarness(fawCards);
    const disconnect = harness.connectEditor();
    expect(await harness.dispatch({ type: 'inspect-now' })).toMatchObject({ editing: true });
    expect(harness.runtimeMessages.some((message) => message.type === 'candidate-batch')).toBe(
      false,
    );
    const preview = (await harness.dispatch({ type: 'preview-current' })) as {
      items: PreviewItem[];
    };
    await harness.dispatch({ type: 'record-current', items: [preview.items[1]] });
    disconnect();
    await harness.dispatch({ type: 'inspect-now' });
    expect(harness.runtimeMessages.filter((item) => item.type === 'candidate-batch')).toHaveLength(
      1,
    );
  });
  it('手动新增国内实习被拒绝；未知公司英文名要求填写中文，不会自动写入', async () => {
    const harness = createHarness(fawCards);
    expect(
      await harness.dispatch({
        type: 'record-current',
        items: [{ key: 'manual:1', company: '中国一汽', position: '产品实习生' }],
      }),
    ).toMatchObject({ needsInput: true, excluded: true });
    expect(
      await harness.dispatch({
        type: 'record-current',
        items: [{ key: 'manual:1', company: 'Unknown Labs', position: '数据分析师' }],
      }),
    ).toMatchObject({ needsInput: true, needsChineseCompany: true });
    expect(harness.runtimeMessages.some((item) => item.type === 'candidate-batch')).toBe(false);
  });
  it('侧栏切换模块后仅预览就关闭，不会继续沿用旧国内模块自动写入', async () => {
    const context = { enabled: true, market: 'cn' };
    const harness = createPageHarness({
      roots: [
        fakeNode('DIV', 'company-name', '星河科技'),
        fakeNode('H1', '', '数据分析师'),
        fakeNode('P', '', '投递成功'),
      ],
      title: '星河科技招聘',
      hostname: 'jobs.example.com',
      pathname: '/submitted',
      href: 'https://jobs.example.com/submitted',
      captureContext: context,
    });
    const disconnect = harness.connectEditor();
    await harness.dispatch({ type: 'preview-current', market: 'us' });
    context.enabled = false;
    context.market = 'us';
    disconnect();
    expect(await harness.dispatch({ type: 'inspect-now' })).toMatchObject({ needsModule: true });
    expect(harness.runtimeMessages.some((item) => item.type === 'candidate-batch')).toBe(false);
  });
});

describe('卡尔动力飞书应聘记录实际 DOM', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/kargobot-application-dom.json', import.meta.url), 'utf8'),
  );
  function tree(node: {
    textContent: string;
    id: string;
    tagName: string;
    className: string;
    attributes: Record<string, string>;
    children: any[];
  }): FakeElement {
    const element = new FakeElement(
      node.textContent,
      node.id,
      node.tagName,
      node.className,
      node.attributes,
    );
    element.setDescendants(node.children.map(tree));
    return element;
  }
  it('正确识别两张嵌套志愿卡片，去掉标题中的“加入”，不把城市和招聘标签当岗位', async () => {
    const harness = createPageHarness({
      ...fixture,
      roots: fixture.roots.map(tree),
      captureContext: { enabled: false, market: 'cn' },
    });
    const preview = (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
      items: PreviewItem[];
    };
    expect(preview.items.map((item) => [item.company, item.position])).toEqual([
      ['卡尔动力（北京）科技有限公司', '项目运营管培生-27届校招'],
      ['卡尔动力（北京）科技有限公司', '数据统计管培生-27届校招'],
    ]);
    expect(new Set(preview.items.map((item) => item.key)).size).toBe(2);
    expect(harness.runtimeMessages.some((message) => message.type === 'candidate-batch')).toBe(
      false,
    );
    await harness.dispatch({ type: 'record-current', market: 'cn', items: preview.items });
    const payloads = harness.runtimeMessages.flatMap((message) => message.payloads || []);
    expect(payloads).toHaveLength(2);
    expect(
      payloads.every((payload) => payload.eventType === 'application' && payload.market === 'cn'),
    ).toBe(true);
    await harness.dispatch({ type: 'record-current', market: 'cn', items: preview.items });
    expect(harness.runtimeMessages.flatMap((message) => message.payloads || [])).toHaveLength(2);
  });
  it('卡尔动力两个岗位经真实接口分别入库，重复记录幂等且不改其他公司', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'campus-kargo-'));
    const store = new Store(join(dir, 'test.sqlite'));
    store.db.exec(
      'DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM events; DELETE FROM candidates; DELETE FROM jobs;',
    );
    store.setSetting('extension_token', 'test-token');
    const unrelated = store.createJob({ company: '其他公司', position: '项目运营管培生-27届校招' });
    const { app } = await createServer({ store, startMail: false });
    try {
      const harness = createPageHarness({
        ...fixture,
        roots: fixture.roots.map(tree),
        captureContext: { enabled: false, market: 'cn' },
        async submitBatch(payloads: CandidatePayload[]) {
          const results = [];
          for (const payload of payloads) {
            const response = await app.inject({
              method: 'POST',
              url: '/api/v1/candidates',
              headers: { 'x-campus-token': 'test-token' },
              payload: { ...payload, source: 'website' },
            });
            expect(response.statusCode).toBe(200);
            results.push({ ok: true, result: response.json() });
          }
          return { ok: true, results };
        },
      });
      const preview = (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
        items: PreviewItem[];
      };
      await harness.dispatch({ type: 'record-current', market: 'cn', items: preview.items });
      await harness.dispatch({ type: 'record-current', market: 'cn', items: preview.items });
      const jobs = store.listJobs().filter((job) => job.company === '卡尔动力（北京）科技有限公司');
      expect(jobs.map((job) => job.position).sort()).toEqual(
        ['项目运营管培生-27届校招', '数据统计管培生-27届校招'].sort(),
      );
      expect(jobs.every((job) => job.events.length === 1)).toBe(true);
      expect(store.getJob(unrelated.id)?.events).toHaveLength(0);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('云尖信息 Hotjob 实际申请卡片与通用字段隔离', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/yunjian-hotjob-application-dom.json', import.meta.url),
      'utf8',
    ),
  );
  function tree(node: {
    textContent: string;
    id: string;
    tagName: string;
    className: string;
    attributes: Record<string, string>;
    children: any[];
  }): FakeElement {
    const element = new FakeElement(
      node.textContent,
      node.id,
      node.tagName,
      node.className,
      node.attributes,
    );
    element.setDescendants(node.children.map(tree));
    return element;
  }
  it('从完整卡片取岗位、申请编号和进度，不把志愿标签当岗位', async () => {
    const harness = createPageHarness({
      ...fixture,
      roots: fixture.roots.map(tree),
      captureContext: { enabled: false, market: 'cn' },
    });
    const preview = (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
      items: PreviewItem[];
    };
    expect(
      preview.items.map((item) => [
        item.company,
        item.position,
        item.externalApplicationId,
        item.title,
      ]),
    ).toEqual([
      ['云尖信息', '2027届-海外市场拓展', '000000000000000000000002', '简历筛选中'],
      ['云尖信息', '2027届-海外市场拓展', '000000000000000000000001', '简历筛选中'],
    ]);
    expect(new Set(preview.items.map((item) => item.key)).size).toBe(2);
    expect(harness.runtimeMessages.some((message) => message.type === 'candidate-batch')).toBe(
      false,
    );
  });
  it('即使同名申请发生在同一分钟，仍按不同编号保留两张卡片', async () => {
    const data = JSON.parse(JSON.stringify(fixture).replaceAll('05:22', '05:23'));
    const harness = createPageHarness({ ...data, roots: data.roots.map(tree) });
    const preview = (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
      items: PreviewItem[];
    };
    expect(preview.items).toHaveLength(2);
    expect(new Set(preview.items.map((item) => item.externalApplicationId)).size).toBe(2);
  });
  it.each([
    '志愿：第2志愿',
    '第2志愿',
    '招聘项目：2027届校招',
    '2027届校招',
    '简历版本：测试简历',
    '申请编号：AP12345',
  ])('没有岗位标题时不把元数据 %s 填进岗位', async (label) => {
    const root = fakeNode('DIV', 'record-item', '', [
      fakeNode('P', '', '投递成功'),
      fakeNode('SPAN', '', label),
      fakeNode('SPAN', '', '投递时间：2026-11-01 05:23'),
    ]);
    const harness = createPageHarness({ ...fixture, roots: [root] });
    const preview = (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
      items: PreviewItem[];
    };
    expect(preview.items.every((item) => item.position === '')).toBe(true);
    await harness.dispatch({ type: 'inspect-now' });
    expect(harness.runtimeMessages.some((message) => message.type === 'candidate-batch')).toBe(
      false,
    );
  });
  it('语义岗位标题优先于卡片里的普通小标题，嵌套块不会另生一个岗位', async () => {
    const root = fakeNode(
      'DIV',
      'record-item',
      '',
      [
        fakeNode('H3', '', '志愿信息'),
        fakeNode('SPAN', 'title-name', '2027届-数据产品经理'),
        fakeNode('DIV', 'metadata', '', [
          fakeNode('SPAN', '', '待处理简历'),
          fakeNode('SPAN', '', '志愿：第1志愿'),
          fakeNode('SPAN', '', '投递时间：2026-11-01 05:23'),
        ]),
      ],
      '000000000000000000000002',
    );
    const harness = createPageHarness({ ...fixture, roots: [root] });
    const preview = (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
      items: PreviewItem[];
    };
    expect(preview.items.map((item) => [item.position, item.externalApplicationId])).toEqual([
      ['2027届-数据产品经理', '000000000000000000000002'],
    ]);
  });
  it('正常的招聘项目经理岗位不会因包含“招聘项目”被当元数据过滤', async () => {
    const root = fakeNode('DIV', 'record-item', '', [
      fakeNode('SPAN', 'title-name', '招聘项目经理'),
      fakeNode('SPAN', '', '投递时间：2026-11-01 05:23'),
    ]);
    const harness = createPageHarness({ ...fixture, roots: [root] });
    const preview = (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
      items: PreviewItem[];
    };
    expect(preview.items.map((item) => item.position)).toEqual(['招聘项目经理']);
  });
  it('两个同名不同编号的申请分别入库，重放后仍保留原编号，不影响其他公司', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'campus-yunjian-'));
    const store = new Store(join(dir, 'test.sqlite'));
    store.db.exec(
      'DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM events; DELETE FROM candidates; DELETE FROM jobs;',
    );
    store.setSetting('extension_token', 'test-token');
    const unrelated = store.createJob({ company: '其他公司', position: '2027届-海外市场拓展' });
    const { app } = await createServer({ store, startMail: false });
    try {
      const harness = createPageHarness({
        ...fixture,
        roots: fixture.roots.map(tree),
        async submitBatch(payloads: CandidatePayload[]) {
          const results = [];
          for (const payload of payloads) {
            const response = await app.inject({
              method: 'POST',
              url: '/api/v1/candidates',
              headers: { 'x-campus-token': 'test-token' },
              payload: { ...payload, source: 'website' },
            });
            expect(response.statusCode).toBe(200);
            results.push({ ok: true, result: response.json() });
          }
          return { ok: true, results };
        },
      });
      const preview = (await harness.dispatch({ type: 'preview-current', market: 'cn' })) as {
        items: PreviewItem[];
      };
      await harness.dispatch({ type: 'record-current', market: 'cn', items: preview.items });
      await harness.dispatch({ type: 'record-current', market: 'cn', items: preview.items });
      const jobs = store.listJobs().filter((job) => job.company === '云尖信息');
      expect(jobs).toHaveLength(2);
      expect(new Set(jobs.map((job) => job.externalApplicationId))).toEqual(
        new Set(['000000000000000000000002', '000000000000000000000001']),
      );
      expect(
        jobs.every((job) => job.position === '2027届-海外市场拓展' && job.events.length === 1),
      ).toBe(true);
      expect(store.getJob(unrelated.id)?.events).toHaveLength(0);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
