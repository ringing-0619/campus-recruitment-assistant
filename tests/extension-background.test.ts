import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/db.js';
import { createServer } from '../src/server/app.js';

const backgroundSource = readFileSync(
  new URL('../extension/background.js', import.meta.url),
  'utf8',
);

interface CandidatePayload {
  market?: 'cn' | 'us';
  source: 'website';
  sourceRef: string;
  company: string;
  position: string;
  externalApplicationId: string;
  url: string;
  eventType: 'application';
  title: string;
  confidence: number;
}

interface BatchResult {
  ok: boolean;
  queued?: boolean;
  result?: { autoApplied?: boolean; candidate?: { status?: string } };
}

interface BatchResponse {
  ok: boolean;
  results: BatchResult[];
  summary: { total: number; applied: number; pending: number; queued: number; failed: number };
}

interface ReceiptItem {
  key: string;
  company: string;
  position: string;
  outcome: string;
}

interface CaptureReceipt {
  url: string;
  updatedAt: number;
  items: ReceiptItem[];
  summary: BatchResponse['summary'];
}

type BackgroundMessageListener = (
  message: Record<string, unknown>,
  sender: { tab?: { id?: number; url?: string } },
  sendResponse: (response: unknown) => void,
) => boolean | void;

type FetchImplementation = (
  input: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function createHarness(fetchImplementation: FetchImplementation, allowMonitoring = false) {
  let messageListener: BackgroundMessageListener | undefined;
  const storage: Record<string, unknown> = { token: 'test-token' };
  const badgeTexts: Array<{ tabId: number; text: string }> = [];
  const badgeColors: Array<{ tabId: number; color: string }> = [];
  const badgeTitles: Array<{ tabId: number; title: string }> = [];
  const broadcasts: Record<string, unknown>[] = [];
  let actionClick: (tab: { id?: number; url?: string; windowId?: number }) => void = () => {};
  const panelBehaviors: Array<{ openPanelOnActionClick: boolean }> = [];
  const panelOpens: Array<{ windowId: number }> = [];
  let toolbarGesture = false;

  const chrome = {
    sidePanel: {
      async setPanelBehavior(behavior: { openPanelOnActionClick: boolean }) {
        panelBehaviors.push(behavior);
      },
      async open(options: { windowId: number }) {
        if (!toolbarGesture) throw new Error('sidePanel.open requires a user gesture');
        panelOpens.push(options);
      },
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      async sendMessage(message: Record<string, unknown>) {
        broadcasts.push(message);
        return undefined;
      },
      onMessage: {
        addListener(listener: BackgroundMessageListener) {
          messageListener = listener;
        },
      },
    },
    alarms: {
      create() {},
      onAlarm: { addListener() {} },
    },
    tabs: {
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    storage: {
      local: {
        async get(key: string) {
          return { [key]: clone(storage[key]) };
        },
        async set(values: Record<string, unknown>) {
          for (const [key, value] of Object.entries(values)) storage[key] = clone(value);
        },
      },
    },
    action: {
      onClicked: {
        addListener(listener: (tab: { id?: number; url?: string; windowId?: number }) => void) {
          actionClick = listener;
        },
      },
      async setBadgeText(value: { tabId: number; text: string }) {
        badgeTexts.push(clone(value));
      },
      async setBadgeBackgroundColor(value: { tabId: number; color: string }) {
        badgeColors.push(clone(value));
      },
      async setTitle(value: { tabId: number; title: string }) {
        badgeTitles.push(clone(value));
      },
    },
    permissions: {
      async contains() {
        return allowMonitoring;
      },
    },
  };

  const monitorProgressPages = runInNewContext(
    `${backgroundSource}\nmonitorProgressPages;`,
    { chrome, fetch: fetchImplementation, URL },
    { filename: 'extension/background.js' },
  ) as () => Promise<void>;

  if (!messageListener)
    throw new Error('background.js did not register a runtime message listener');

  async function dispatch(
    message: Record<string, unknown>,
    tabId = 17,
    url = fawCandidates[0].url,
  ): Promise<unknown> {
    return new Promise((resolve) => {
      messageListener!(message, { tab: { id: tabId, url } }, resolve);
    });
  }

  return {
    dispatch,
    storage,
    badgeTexts,
    badgeColors,
    badgeTitles,
    monitorProgressPages,
    panelBehaviors,
    panelOpens,
    broadcasts,
    async toolbarClick(tab: { id?: number; url?: string; windowId?: number }) {
      // Chromium ExtensionActionRunner returns early for automatic side-panel
      // actions, without granting activeTab or dispatching action.onClicked.
      if (panelBehaviors.at(-1)?.openPanelOnActionClick) return;
      toolbarGesture = true;
      actionClick(tab);
      toolbarGesture = false;
      for (let index = 0; index < 10; index++) await Promise.resolve();
    },
  };
}

const fawCandidates: CandidatePayload[] = [
  {
    source: 'website',
    sourceRef: 'application-card:faw-zhaopin.hotjob.cn:000000000000000000000004',
    company: '一汽红旗',
    position: '战略规划架构师',
    externalApplicationId: '000000000000000000000004',
    url: 'https://faw-zhaopin.hotjob.cn/SU603374380dcad4635b836531/pb/account.html#/myDeliver',
    eventType: 'application',
    title: '投递成功',
    confidence: 0.99,
  },
  {
    source: 'website',
    sourceRef: 'application-card:faw-zhaopin.hotjob.cn:000000000000000000000003',
    company: '一汽奔腾',
    position: '海外营销管理员（奔腾国际公司）',
    externalApplicationId: '000000000000000000000003',
    url: 'https://faw-zhaopin.hotjob.cn/SU603374380dcad4635b836531/pb/account.html#/myDeliver',
    eventType: 'application',
    title: '投递成功',
    confidence: 0.99,
  },
];

describe('extension/background.js candidate-batch', () => {
  it('点击图标使用持久侧栏；切换模块只保存预览选择，记录后才启用采集', async () => {
    const harness = createHarness(async () => ({
      ok: true,
      async json() {
        return { autoApplied: true };
      },
    }));
    expect(harness.panelBehaviors).toEqual([{ openPanelOnActionClick: false }]);
    const url = fawCandidates[0].url;
    await harness.dispatch({ type: 'select-market', tabId: 17, url, market: 'us', preview: true });
    expect(await harness.dispatch({ type: 'capture-context', tabId: 17, url })).toMatchObject({
      enabled: false,
      market: 'us',
    });
    await harness.dispatch({ type: 'select-market', tabId: 17, url, market: 'us', preview: false });
    expect(await harness.dispatch({ type: 'capture-context', tabId: 17, url })).toMatchObject({
      enabled: true,
      market: 'us',
    });
  });
  it('插件选择美国后经真实 API 自动建档，重复记录不会重复或落入国内', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'campus-extension-flow-'));
    const store = new Store(join(directory, 'test.sqlite'));
    store.setSetting('extension_token', 'test-token');
    store.setSetting('website_market', 'cn');
    const domesticBefore = store.listJobs();
    const { app } = await createServer({ store, startMail: false });
    const harness = createHarness(async (input, init) => {
      const url = new URL(input);
      const response = await app.inject({
        method: 'POST',
        url: url.pathname,
        headers: init?.headers,
        payload: JSON.parse(init?.body || '{}'),
      });
      return {
        ok: response.statusCode < 400,
        status: response.statusCode,
        async json() {
          return response.json();
        },
      };
    });
    try {
      const url = 'https://jobs.example.com/application/submitted';
      const payload = {
        source: 'website',
        sourceRef: 'us:successful-application',
        company: 'Acme Labs',
        position: 'Software Engineer',
        url,
        eventType: 'application',
        confidence: 0.95,
      };
      await harness.dispatch({ type: 'select-market', tabId: 17, url, market: 'us' }, 17, url);
      const first = (await harness.dispatch(
        { type: 'candidate-batch', payloads: [payload] },
        17,
        url,
      )) as BatchResponse;
      expect(first.summary).toMatchObject({ applied: 1, pending: 0 });
      await harness.dispatch({ type: 'candidate-batch', payloads: [payload] }, 17, url);
      const jobs = (await app.inject('/api/v1/jobs?market=us')).json();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        market: 'us',
        company: 'Acme Labs',
        position: 'Software Engineer',
        status: '已投递',
      });
      expect(jobs[0].events).toHaveLength(1);
      expect(store.listJobs()).toEqual(domesticBefore);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('手动选择美国模块后，提交携带美国归属，其他标签页不受影响', async () => {
    const captured: CandidatePayload[] = [];
    const harness = createHarness(async (_url, init) => {
      captured.push(JSON.parse(init?.body || '{}'));
      return {
        ok: true,
        async json() {
          return { autoApplied: true, candidate: { status: 'applied' } };
        },
      };
    });
    const url = fawCandidates[0].url;
    expect(await harness.dispatch({ type: 'capture-context', tabId: 17, url })).toMatchObject({
      enabled: false,
      market: 'cn',
    });
    expect(
      await harness.dispatch({ type: 'select-market', tabId: 17, url, market: 'us' }),
    ).toMatchObject({ ok: true });
    await harness.dispatch({ type: 'candidate-batch', payloads: fawCandidates });
    expect(captured.map((item) => item.market)).toEqual(['us', 'us']);
    expect(await harness.dispatch({ type: 'capture-context', tabId: 17, url })).toMatchObject({
      enabled: true,
      market: 'us',
    });
    expect(await harness.dispatch({ type: 'capture-context', tabId: 18, url })).toMatchObject({
      enabled: false,
      market: 'us',
    });
    expect(
      await harness.dispatch({
        type: 'capture-context',
        tabId: 17,
        url: 'https://different.example/jobs',
      }),
    ).toMatchObject({ enabled: false });
  });

  it('模块选择在离线入队时固定，同一岗位两模块不会被队列去重合并', async () => {
    const captured: CandidatePayload[] = [];
    let online = false;
    const harness = createHarness(async (_url, init) => {
      if (!online) throw new Error('offline');
      captured.push(JSON.parse(init?.body || '{}'));
      return {
        ok: true,
        async json() {
          return { autoApplied: true };
        },
      };
    });
    await harness.dispatch({
      type: 'candidate-batch',
      payloads: [{ ...fawCandidates[0], market: 'us' }],
    });
    await harness.dispatch({
      type: 'candidate-batch',
      payloads: [{ ...fawCandidates[0], market: 'cn' }],
    });
    expect((harness.storage.queue as CandidatePayload[]).map((item) => item.market)).toEqual([
      'us',
      'cn',
    ]);
    await harness.dispatch({
      type: 'select-market',
      tabId: 17,
      url: fawCandidates[0].url,
      market: 'cn',
    });
    online = true;
    await harness.dispatch({
      type: 'candidate-batch',
      payloads: [{ ...fawCandidates[1], market: 'cn' }],
    });
    expect(captured.map((item) => item.market)).toEqual(['cn', 'us', 'cn']);
    expect(harness.storage.queue).toEqual([]);
  });

  it('同一页两模块的成功和待确认回执分别显示', async () => {
    const harness = createHarness(async (_url, init) => {
      const market = JSON.parse(init?.body || '{}').market;
      return {
        ok: true,
        async json() {
          return {
            autoApplied: market === 'cn',
            candidate: { status: market === 'cn' ? 'applied' : 'pending' },
          };
        },
      };
    });
    const url = fawCandidates[0].url;
    await harness.dispatch({
      type: 'candidate-batch',
      payloads: [{ ...fawCandidates[0], market: 'cn' }],
    });
    await harness.dispatch({
      type: 'candidate-batch',
      payloads: [{ ...fawCandidates[0], market: 'us' }],
    });
    expect(
      await harness.dispatch({ type: 'capture-summary', tabId: 17, url, market: 'cn' }),
    ).toMatchObject({ receipt: { market: 'cn', summary: { applied: 1, pending: 0 } } });
    expect(
      await harness.dispatch({ type: 'capture-summary', tabId: 17, url, market: 'us' }),
    ).toMatchObject({ receipt: { market: 'us', summary: { applied: 0, pending: 1 } } });
  });

  it('定时检查两个模块，提交进度及同步状态时保留原模块归属', async () => {
    const requested: string[] = [],
      capturedMarkets: string[] = [];
    const harness = createHarness(async (url, init) => {
      requested.push(url);
      if (url.includes('/jobs?market=')) {
        const market = new URL(url).searchParams.get('market')!;
        return {
          ok: true,
          async json() {
            return [
              {
                id: `job-${market}`,
                market,
                company: 'Acme',
                position: 'Analyst',
                status: '已投递',
                progressUrls: [`https://jobs.example.com/${market}`],
              },
            ];
          },
        };
      }
      if (url.startsWith('https://jobs.example.com/'))
        return {
          ok: true,
          async json() {
            return {};
          },
          async text() {
            return '在线测评通知';
          },
        };
      if (url.endsWith('/candidates')) capturedMarkets.push(JSON.parse(init?.body || '{}').market);
      return {
        ok: true,
        async json() {
          return { autoApplied: true };
        },
      };
    }, true);
    await harness.monitorProgressPages();
    expect(capturedMarkets).toEqual(['cn', 'us']);
    expect(requested).toContain('http://127.0.0.1:43110/api/v1/jobs/job-cn/sync-health?market=cn');
    expect(requested).toContain('http://127.0.0.1:43110/api/v1/jobs/job-us/sync-health?market=us');
  });

  it('两条候选记录按顺序提交，并返回两个结果', async () => {
    const lifecycle: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const submittedPositions: string[] = [];
    const harness = createHarness(async (_input, init) => {
      const payload = JSON.parse(init?.body || '{}') as CandidatePayload;
      submittedPositions.push(payload.position);
      lifecycle.push(`start:${payload.position}`);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      lifecycle.push(`end:${payload.position}`);
      inFlight--;
      return {
        ok: true,
        async json() {
          return { autoApplied: true, candidate: { status: 'applied' } };
        },
      };
    });

    const response = (await harness.dispatch({
      type: 'candidate-batch',
      payloads: fawCandidates,
    })) as BatchResponse;

    expect(response.ok).toBe(true);
    expect(response.results).toHaveLength(2);
    expect(submittedPositions).toEqual(fawCandidates.map((candidate) => candidate.position));
    expect(lifecycle).toEqual([
      `start:${fawCandidates[0].position}`,
      `end:${fawCandidates[0].position}`,
      `start:${fawCandidates[1].position}`,
      `end:${fawCandidates[1].position}`,
    ]);
    expect(maxInFlight).toBe(1);
  });

  it('服务失败时两条都进入离线队列，不会因并发写入丢失', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const harness = createHarness(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      throw new Error('service unavailable');
    });

    const response = (await harness.dispatch({
      type: 'candidate-batch',
      payloads: fawCandidates,
    })) as BatchResponse;
    const queue = harness.storage.queue as CandidatePayload[];

    expect(response.ok).toBe(true);
    expect(response.results).toHaveLength(2);
    expect(response.results.every((result) => result.queued)).toBe(true);
    expect(response.summary).toMatchObject({ total: 2, queued: 2, applied: 0, failed: 0 });
    expect(queue).toHaveLength(2);
    expect(queue.map((candidate) => candidate.sourceRef)).toEqual(
      fawCandidates.map((candidate) => candidate.sourceRef),
    );
    expect(new Set(queue.map((candidate) => candidate.sourceRef)).size).toBe(2);
    expect(maxInFlight).toBe(1);
  });

  it('成功时按 tab 保存两个唯一回执，并生成 applied=2 的摘要和角标', async () => {
    const harness = createHarness(async () => ({
      ok: true,
      async json() {
        return { autoApplied: true, candidate: { status: 'applied' } };
      },
    }));

    const response = (await harness.dispatch(
      { type: 'candidate-batch', payloads: fawCandidates },
      42,
    )) as BatchResponse;
    const receipts = harness.storage.captureReceipts as Record<string, CaptureReceipt>;
    const receipt = receipts['42'];

    expect(response.summary).toEqual({ total: 2, applied: 2, pending: 0, queued: 0, failed: 0 });
    expect(Object.keys(receipts)).toEqual(['42']);
    expect(receipt.items).toHaveLength(2);
    expect(receipt.items.map((item) => item.key)).toEqual(
      fawCandidates.map((candidate) => candidate.sourceRef),
    );
    expect(new Set(receipt.items.map((item) => item.key)).size).toBe(2);
    expect(receipt.items.every((item) => item.outcome === 'applied')).toBe(true);
    expect(receipt.summary).toEqual({ total: 2, applied: 2, pending: 0, queued: 0, failed: 0 });
    expect(harness.badgeTexts.at(-1)).toEqual({ tabId: 42, text: '2' });
    expect(harness.badgeColors.at(-1)).toEqual({ tabId: 42, color: '#249b63' });
    expect(harness.badgeTitles.at(-1)).toEqual({ tabId: 42, title: '已成功记录 2 个岗位' });
  });
});

describe('工具栏重新激活侧栏', () => {
  it('正常工具栏动作同步打开侧栏，再通知读取页面，不扩大权限或提前采集', async () => {
    let fetchCount = 0;
    const harness = createHarness(async () => {
      fetchCount++;
      return { ok: true, json: async () => ({}) };
    });
    await harness.toolbarClick({
      id: 17,
      windowId: 3,
      url: 'https://kargobot.jobs.feishu.cn/267069/position/application',
    });
    expect(harness.panelOpens).toEqual([{ windowId: 3 }]);
    expect(harness.broadcasts).toEqual([{ type: 'capture-page-ready', tabId: 17 }]);
    expect(harness.storage.captureMarkets).toBeUndefined();
    expect(fetchCount).toBe(0);
  });
  it('受限页和缺失地址的动作仍打开侧栏以显示提示，不广播可采集通知；无效标签不打开', async () => {
    const harness = createHarness(async () => ({ ok: true, json: async () => ({}) }));
    await harness.toolbarClick({ id: 17, windowId: 3, url: 'chrome://extensions/' });
    await harness.toolbarClick({ id: 18, windowId: 3 });
    await harness.toolbarClick({ id: 19 });
    await harness.toolbarClick({ windowId: 3 });
    expect(harness.panelOpens).toEqual([{ windowId: 3 }, { windowId: 3 }]);
    expect(harness.broadcasts).toHaveLength(0);
  });
  it('已打开的侧栏再次点击仍收到新通知', async () => {
    const harness = createHarness(async () => ({ ok: true, json: async () => ({}) }));
    const tab = {
      id: 17,
      windowId: 3,
      url: 'https://kargobot.jobs.feishu.cn/267069/position/application',
    };
    await harness.toolbarClick(tab);
    await harness.toolbarClick(tab);
    expect(harness.panelOpens).toHaveLength(2);
    expect(harness.broadcasts).toHaveLength(2);
  });
});
