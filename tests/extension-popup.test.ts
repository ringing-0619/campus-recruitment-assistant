import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
const backgroundSource = readFileSync(
  new URL('../extension/background.js', import.meta.url),
  'utf8',
);
type Callback = (...args: any[]) => unknown;
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  value = '';
  textContent = '';
  placeholder = '';
  className = '';
  disabled = false;
  hidden = false;
  checked = false;
  onclick?: Callback;
  listeners: Record<string, Callback> = {};
  constructor(
    public tagName = 'DIV',
    public attributes: Record<string, string> = {},
  ) {}
  classList = {
    toggle: (name: string, enabled: boolean) => {
      const names = new Set(this.className.split(' '));
      enabled ? names.add(name) : names.delete(name);
      this.className = [...names].join(' ');
    },
  };
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren() {
    this.children = [];
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener(type: string, listener: Callback) {
    this.listeners[type] = listener;
  }
  focus() {}
  all(): Element[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  matches(selector: string) {
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    if (selector === 'input[name="market"]')
      return this.tagName === 'INPUT' && this.attributes.name === 'market';
    const field = selector.match(/^\[data-field="(.+)"\]$/)?.[1];
    return field ? this.dataset.field === field : this.tagName.toLowerCase() === selector;
  }
  querySelectorAll(selector: string) {
    return this.all().filter((element) =>
      selector.split(',').some((part) => element.matches(part.trim())),
    );
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] || null;
  }
}
function harness(
  options: {
    allowed?: boolean;
    items?: Record<string, unknown>[];
    excluded?: Record<string, unknown>[];
    failInjection?: boolean;
    denyPermission?: boolean;
    activeTab?: { id: number; url?: string };
    scriptUrl?: string;
    denyUrlRead?: boolean;
    noTab?: boolean;
    queryError?: boolean;
    simulateToolbar?: boolean;
  } = {},
) {
  const root = new Element();
  const ids = new Map<string, Element>();
  for (const id of [
    'version',
    'enable',
    'feedback',
    'add-job',
    'refresh',
    'site',
    'status',
    'destination',
    'open',
    'fields',
    'job-list',
    'empty-list',
    'detected-count',
    'filter-note',
    'retry-page',
  ]) {
    const element = new Element(
      ['enable', 'add-job', 'refresh', 'open'].includes(id) ? 'BUTTON' : 'DIV',
    );
    ids.set(id, element);
    root.append(element);
  }
  const statusLabel = new Element('SPAN');
  ids.get('status')!.append(statusLabel);
  const markets = ['cn', 'us'].map((value) => {
    const input = new Element('INPUT', { name: 'market' });
    input.value = value;
    root.append(input);
    return input;
  });
  const document = {
    querySelector: (selector: string) =>
      selector === '#status span:last-child'
        ? statusLabel
        : selector.startsWith('#')
          ? ids.get(selector.slice(1))
          : root.querySelector(selector),
    querySelectorAll: (selector: string) => {
      const elements = root.querySelectorAll(selector);
      return Object.assign(elements, { item: (index: number) => elements[index] });
    },
    createElement: (tag: string) => new Element(tag.toUpperCase()),
    createTextNode: (value: string) => {
      const text = new Element('#TEXT');
      text.textContent = value;
      return text;
    },
  };
  const calls: Record<string, any>[] = [];
  let activeTab: { id: number; url?: string } = options.activeTab || {
    id: 17,
    url: 'https://career.papegames.com/campus/position/application',
  };
  let runtimeListener: Callback = () => {};
  let actionListener: Callback = () => {};
  let automaticPanel = false,
    temporaryAccess = !options.simulateToolbar,
    toolbarGesture = false;
  let granted = options.allowed !== false;
  let activated: Callback = () => {};
  let updated: Callback = () => {};
  const items = options.items ?? [
    { key: 'first', company: '叠纸游戏', position: '商务管培生-研发方向（2027届秋招）' },
    { key: 'second', company: '叠纸游戏', position: '商务管培生-综合方向（2027届秋招）' },
  ];
  const chrome = {
    runtime: {
      getManifest: () => ({ version: '3.6.2' }),
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: {
        addListener(listener: Callback) {
          runtimeListener = listener;
        },
      },
      async sendMessage(message: Record<string, any>) {
        calls.push(message);
        if (message.type === 'capture-page-ready') runtimeListener(message);
        if (message.type === 'capture-context') return { market: 'cn' };
        return { ok: true };
      },
    },
    tabs: {
      async query() {
        if (options.queryError) throw new Error('浏览器暂时不可用');
        return options.noTab ? [] : [temporaryAccess ? activeTab : { id: activeTab.id }];
      },
      async sendMessage(_id: number, message: Record<string, any>) {
        calls.push(message);
        if (message.type === 'preview-current')
          return { ok: true, items, excluded: options.excluded || [] };
        return message.items.map(() => ({ ok: true, result: { autoApplied: true } }));
      },
      connect() {
        return { disconnect() {}, onDisconnect: { addListener() {} } };
      },
      create() {},
      onActivated: {
        addListener(listener: Callback) {
          activated = listener;
        },
      },
      onUpdated: {
        addListener(listener: Callback) {
          updated = listener;
        },
      },
      onRemoved: { addListener() {} },
    },
    permissions: {
      async contains() {
        return granted;
      },
      async request() {
        calls.push({ type: 'permission-request' });
        granted = !options.denyPermission;
        return granted;
      },
    },
    scripting: {
      async executeScript(details: { func?: unknown }) {
        if (details.func) {
          calls.push({ type: 'read-page-url' });
          if (options.denyUrlRead || !temporaryAccess)
            throw new Error('Cannot access contents of the page');
          return [{ result: options.scriptUrl }];
        }
        if (options.failInjection) throw new Error('无法读取网页');
        return [];
      },
    },
    sidePanel: {
      async setPanelBehavior(behavior: { openPanelOnActionClick: boolean }) {
        automaticPanel = behavior.openPanelOnActionClick;
      },
      async open(details: { windowId: number }) {
        if (!toolbarGesture) throw new Error('sidePanel.open requires a user gesture');
        calls.push({ type: 'open-side-panel', ...details });
      },
    },
    action: {
      onClicked: {
        addListener(listener: Callback) {
          actionListener = listener;
        },
      },
    },
    alarms: { onAlarm: { addListener() {} } },
    storage: {
      local: {
        async get() {
          return {};
        },
      },
    },
  };
  if (options.simulateToolbar)
    runInNewContext(backgroundSource, { chrome, URL }, { filename: 'extension/background.js' });
  runInNewContext(
    source,
    { document, chrome, URL, crypto: { randomUUID } },
    { filename: 'extension/popup.js' },
  );
  const settle = async () => {
    for (let index = 0; index < 30; index++) await Promise.resolve();
  };
  const click = async (id: string) => {
    await ids.get(id)!.onclick?.();
    await settle();
  };
  const cards = () => root.querySelectorAll('.job-card');
  return {
    ids,
    calls,
    markets,
    settle,
    click,
    cards,
    async toolbarClick(url: string) {
      activeTab = { ...activeTab, url };
      if (options.simulateToolbar) {
        // Match Chromium's action runner: automatic side panels bypass activeTab
        // and onClicked; normal actions grant access before dispatching onClicked.
        if (automaticPanel) return;
        temporaryAccess = true;
        toolbarGesture = true;
        actionListener({ ...activeTab, windowId: 3 });
        toolbarGesture = false;
      } else runtimeListener({ type: 'capture-page-ready', tabId: activeTab.id });
      await settle();
    },
    async remove(index: number) {
      cards()[index].querySelector('.remove-job')!.listeners.click();
      await settle();
    },
    async edit(index: number, field: string, value: string) {
      const input = cards()[index].querySelector(`[data-field="${field}"]`)!;
      input.value = value;
      input.listeners.input();
      await settle();
    },
    async switchTab(id: number) {
      activeTab = { ...activeTab, id };
      activated({ tabId: id });
      await settle();
    },
    async completeNavigation(url: string) {
      activeTab = { ...activeTab, url };
      updated(activeTab.id, { url, status: 'complete' });
      await settle();
    },
  };
}

describe('extension/popup.js 侧栏编辑流程', () => {
  it('一次授权后保持预览，核对后才记录，不抢先写入', async () => {
    const ui = harness({ allowed: false });
    await ui.settle();
    expect(ui.cards()).toHaveLength(0);
    await ui.click('enable');
    expect(ui.calls.filter((call) => call.type === 'permission-request')).toHaveLength(1);
    expect(ui.cards()).toHaveLength(2);
    expect(
      ui.calls.some((call) => call.type === 'record-current' || call.type === 'inspect-now'),
    ).toBe(false);
    expect(ui.ids.get('enable')!.disabled).toBe(false);
    await ui.click('enable');
    expect(ui.calls.find((call) => call.type === 'record-current')?.items).toHaveLength(2);
    expect(ui.ids.get('feedback')!.textContent).toContain('已成功记录 2 个岗位');
  });
  it('增删前保存其他输入，只提交最终两项，手动新增独立于原卡编号', async () => {
    const ui = harness();
    await ui.settle();
    await ui.edit(1, 'position', '商务管培生-综合方向（手动修正）');
    await ui.remove(0);
    await ui.click('add-job');
    expect(ui.cards()).toHaveLength(2);
    await ui.edit(1, 'position', '人力资源管培生（2027秋招）');
    await ui.click('enable');
    const submitted = ui.calls.find((call) => call.type === 'record-current')!.items;
    expect(submitted).toEqual([
      { key: 'second', company: '叠纸游戏', position: '商务管培生-综合方向（手动修正）' },
      {
        key: expect.stringMatching(/^manual:/),
        company: '叠纸游戏',
        position: '人力资源管培生（2027秋招）',
      },
    ]);
  });
  it('空识别数组保留空状态，不伪造条目；全移除后禁止提交，可以手动新增', async () => {
    const ui = harness({ items: [], excluded: [{ position: '用户研究实习生' }] });
    await ui.settle();
    expect(ui.cards()).toHaveLength(0);
    expect(ui.ids.get('enable')!.disabled).toBe(true);
    expect(ui.ids.get('empty-list')!.hidden).toBe(false);
    expect(ui.ids.get('filter-note')!.textContent).toContain('用户研究实习生');
    await ui.click('add-job');
    expect(ui.cards()).toHaveLength(1);
    await ui.remove(0);
    expect(ui.ids.get('enable')!.disabled).toBe(true);
    expect(ui.calls.some((call) => call.type === 'record-current')).toBe(false);
  });
  it('输入缺失或缺少公司中文名会阻止提交', async () => {
    const ui = harness({
      items: [{ key: 'first', company: 'Papergames', position: '秋招管培生' }],
    });
    await ui.settle();
    await ui.click('enable');
    expect(ui.calls.some((call) => call.type === 'record-current')).toBe(false);
    expect(ui.ids.get('feedback')!.textContent).toContain('公司中文名');
    await ui.edit(0, 'company', '叠纸游戏');
    await ui.click('enable');
    expect(ui.calls.some((call) => call.type === 'record-current')).toBe(true);
  });
  it('切换模块只预览，不调用 inspect-now，切回时保留草稿', async () => {
    const ui = harness();
    await ui.settle();
    await ui.edit(0, 'position', '已编辑的秋招岗位');
    ui.markets[1].listeners.change();
    await ui.settle();
    expect(ui.calls.find((call) => call.type === 'select-market')).toMatchObject({
      market: 'us',
      preview: true,
    });
    expect(
      ui.calls.some((call) => call.type === 'inspect-now' || call.type === 'record-current'),
    ).toBe(false);
    ui.markets[0].listeners.change();
    await ui.settle();
    expect(ui.cards()[0].querySelector('[data-field="position"]')!.value).toBe('已编辑的秋招岗位');
  });
  it('切换标签页跟随当前页，切回原页面恢复草稿，导航到新页面重新识别', async () => {
    const ui = harness();
    await ui.settle();
    await ui.edit(0, 'position', '原页面草稿');
    await ui.switchTab(18);
    expect(ui.cards()[0].querySelector('[data-field="position"]')!.value).not.toBe('原页面草稿');
    await ui.switchTab(17);
    expect(ui.cards()[0].querySelector('[data-field="position"]')!.value).toBe('原页面草稿');
    await ui.completeNavigation('https://career.papegames.com/campus/position/other');
    expect(ui.cards()[0].querySelector('[data-field="position"]')!.value).not.toBe('原页面草稿');
  });
  it('授权拒绝或注入失败后恢复按钮可用，不卡在记录中', async () => {
    const denied = harness({ allowed: false, denyPermission: true });
    await denied.settle();
    await denied.click('enable');
    expect(denied.ids.get('enable')!.disabled).toBe(false);
    expect(denied.ids.get('feedback')!.textContent).toContain('未获得网站授权');
    const failed = harness({ failInjection: true });
    await failed.settle();
    expect(failed.ids.get('feedback')!.textContent).toBe('无法读取网页');
    expect(failed.ids.get('refresh')!.disabled).toBe(false);
  });
});

describe('侧栏缺少地址时的恢复', () => {
  it('后台与侧栏联动：按 Chrome 动作模型经过工具栏授权后恢复地址、站点授权、预览和记录', async () => {
    const url = 'https://kargobot.jobs.feishu.cn/267069/position/application';
    const ui = harness({
      simulateToolbar: true,
      allowed: false,
      activeTab: { id: 17, url },
      items: [
        {
          key: 'kargo:1',
          company: '卡尔动力（北京）科技有限公司',
          position: '项目运营管培生-27届校招',
        },
        {
          key: 'kargo:2',
          company: '卡尔动力（北京）科技有限公司',
          position: '数据统计管培生-27届校招',
        },
      ],
    });
    await ui.settle();
    expect(ui.ids.get('enable')!.disabled).toBe(true);
    expect(ui.ids.get('feedback')!.textContent).toContain('工具栏');
    await ui.toolbarClick(url);
    expect(ui.calls.filter((call) => call.type === 'open-side-panel')).toEqual([
      { type: 'open-side-panel', windowId: 3 },
    ]);
    expect(ui.ids.get('site')!.textContent).toBe('kargobot.jobs.feishu.cn');
    expect(ui.ids.get('enable')!.disabled).toBe(false);
    await ui.click('enable');
    expect(ui.calls.filter((call) => call.type === 'permission-request')).toHaveLength(1);
    expect(ui.cards()).toHaveLength(2);
    expect(ui.calls.some((call) => call.type === 'record-current')).toBe(false);
    await ui.click('enable');
    expect(ui.calls.find((call) => call.type === 'record-current')?.items).toHaveLength(2);
    expect(ui.ids.get('feedback')!.textContent).toContain('已成功记录 2 个岗位');
  });
  it('Chrome 隐藏 tab.url 时用已有脚本权限只读取当前地址，随后正常预览', async () => {
    const ui = harness({
      activeTab: { id: 17 },
      scriptUrl: 'https://kargobot.jobs.feishu.cn/267069/position/application',
    });
    await ui.settle();
    expect(ui.ids.get('site')!.textContent).toBe('kargobot.jobs.feishu.cn');
    expect(ui.cards()).toHaveLength(2);
    expect(ui.calls.some((call) => call.type === 'read-page-url')).toBe(true);
    expect(ui.calls.some((call) => call.type === 'record-current')).toBe(false);
  });
  it('没有地址且无当前站点权限时给出可操作的提示，不泄漏 Invalid URL 或卡死重试', async () => {
    const ui = harness({ activeTab: { id: 17 }, denyUrlRead: true });
    await ui.settle();
    expect(ui.ids.get('feedback')!.textContent).toContain('工具栏');
    expect(ui.ids.get('feedback')!.textContent).not.toContain('Invalid URL');
    expect(ui.ids.get('retry-page')).toMatchObject({ hidden: false, disabled: false });
    expect(ui.calls.some((call) => call.type === 'preview-current')).toBe(false);
    await ui.toolbarClick('https://kargobot.jobs.feishu.cn/267069/position/application');
    expect(ui.cards()).toHaveLength(2);
    expect(ui.ids.get('retry-page')!.hidden).toBe(true);
  });
  it.each([
    { activeTab: { id: 17, url: 'not a URL' } },
    { activeTab: { id: 17, url: 'chrome://extensions/' } },
    { noTab: true },
    { queryError: true },
  ])('不可识别的标签页可恢复且不产生记录：%j', async (options) => {
    const ui = harness(options);
    await ui.settle();
    expect(ui.ids.get('retry-page')).toMatchObject({ hidden: false, disabled: false });
    expect(ui.ids.get('feedback')!.textContent).not.toContain('Invalid URL');
    expect(ui.calls.some((call) => call.type === 'record-current')).toBe(false);
  });
});
