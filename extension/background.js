const API = 'http://127.0.0.1:43110/api/v1';
const RECEIPT_TTL = 24 * 60 * 60 * 1000;
let queueMutation = Promise.resolve();
let receiptMutation = Promise.resolve();
let contextMutation = Promise.resolve();

// Chrome's automatic side-panel action bypasses both activeTab and action.onClicked.
// Use the normal toolbar action to get activeTab, then open the persistent panel.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
chrome.action.onClicked.addListener((tab) => {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab.windowId)) return;
  // Invoke before any await so Chrome can still associate this with the user gesture.
  void chrome.sidePanel
    .open({ windowId: tab.windowId })
    .then(() => {
      if (/^https?:\/\//.test(tab.url || '')) {
        void chrome.runtime
          .sendMessage({ type: 'capture-page-ready', tabId: tab.id })
          .catch(() => undefined);
      }
    })
    .catch(console.error);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('daily-progress-sync', { delayInMinutes: 2, periodInMinutes: 24 * 60 });
  void flushQueue();
});
chrome.runtime.onStartup.addListener(() => void flushQueue());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'daily-progress-sync') void monitorProgressPages();
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'capture-context') {
    void getCaptureContext(message.tabId ?? sender.tab?.id, message.url || sender.tab?.url).then(
      sendResponse,
    );
    return true;
  }
  if (message.type === 'select-market') {
    void selectCaptureMarket(message.tabId, message.url, message.market, message.preview !== true)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'candidate') {
    void preparePayloads([message.payload], sender)
      .then(async ([payload]) => {
        const result = await submitCandidate(payload);
        await rememberCapture([payload], [result], sender.tab?.id);
        sendResponse(result);
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'candidate-batch') {
    void preparePayloads(
      (Array.isArray(message.payloads) ? message.payloads : []).slice(0, 50),
      sender,
    )
      .then((payloads) => submitCandidateBatch(payloads, sender.tab?.id))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'capture-summary') {
    void getCaptureReceipt(message.tabId, message.url, message.market).then((receipt) =>
      sendResponse({ ok: true, receipt }),
    );
    return true;
  }
  if (message.type === 'unrecognized-domain') {
    void authenticatedFetch('/domains/unrecognized', {
      method: 'POST',
      body: JSON.stringify({ domain: message.domain }),
    });
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) void clearCapture(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void clearCapture(tabId);
  void removeCaptureContext(tabId);
});

function normalizeMarket(value) {
  return value === 'us' ? 'us' : 'cn';
}
function pageOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
async function getCaptureContext(tabId, url) {
  await contextMutation;
  const { captureMarkets = {} } = await chrome.storage.local.get('captureMarkets');
  const { selectedMarket = 'cn' } = await chrome.storage.local.get('selectedMarket');
  const context = captureMarkets[String(tabId)];
  const sameOrigin = Boolean(context && context.origin === pageOrigin(url));
  const enabled = sameOrigin && context.enabled !== false;
  return {
    ok: true,
    enabled,
    market: normalizeMarket(sameOrigin ? context.market : selectedMarket),
  };
}
function selectCaptureMarket(tabId, url, market, enabled = true) {
  if (!Number.isInteger(tabId) || !/^https?:\/\//.test(url || '') || !['cn', 'us'].includes(market))
    return Promise.reject(new Error('无效的页面或求职模块'));
  const operation = contextMutation.then(async () => {
    const { captureMarkets = {} } = await chrome.storage.local.get('captureMarkets');
    captureMarkets[String(tabId)] = { market, origin: pageOrigin(url), enabled };
    await chrome.storage.local.set({ captureMarkets, selectedMarket: market });
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
    return { ok: true, market };
  });
  contextMutation = operation.catch(() => undefined);
  return operation;
}
function removeCaptureContext(tabId) {
  const operation = contextMutation.then(async () => {
    const { captureMarkets = {} } = await chrome.storage.local.get('captureMarkets');
    delete captureMarkets[String(tabId)];
    await chrome.storage.local.set({ captureMarkets });
  });
  contextMutation = operation.catch(() => undefined);
  return operation;
}
async function preparePayloads(payloads, sender) {
  const context = await getCaptureContext(sender.tab?.id, sender.tab?.url);
  return payloads.map((payload) =>
    normalizeWebsitePayload(payload, context.enabled ? context.market : 'cn'),
  );
}

function normalizeWebsitePayload(payload, market = 'cn') {
  return {
    ...payload,
    market: normalizeMarket(payload.market ?? market),
    sourceRef: payload.sourceRef || websiteRef(payload),
  };
}
async function submitCandidate(payload, { flush = true } = {}) {
  try {
    const result = await authenticatedFetch('/candidates', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (flush) await flushQueue();
    return { ok: true, result };
  } catch (error) {
    await enqueueCandidate(payload);
    return {
      ok: false,
      queued: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
async function submitCandidateBatch(payloads, tabId) {
  if (!payloads.length)
    return {
      ok: false,
      results: [],
      summary: { total: 0, applied: 0, pending: 0, queued: 0, failed: 0 },
    };
  const results = [];
  for (const payload of payloads) results.push(await submitCandidate(payload, { flush: false }));
  if (results.some((result) => result.ok)) await flushQueue();
  const receipt = await rememberCapture(payloads, results, tabId);
  return {
    ok: results.every((result) => result.ok || result.queued),
    results,
    summary: receipt?.summary || summarizeResults(results),
  };
}
function enqueueCandidate(payload) {
  return mutateQueue(async () => {
    const { queue = [] } = await chrome.storage.local.get('queue');
    if (
      !queue.some(
        (item) =>
          item.sourceRef === payload.sourceRef &&
          normalizeMarket(item.market) === normalizeMarket(payload.market),
      )
    )
      queue.push(payload);
    await chrome.storage.local.set({ queue: queue.slice(-200) });
  });
}
async function flushQueue() {
  return mutateQueue(async () => {
    const { queue = [] } = await chrome.storage.local.get('queue');
    if (!queue.length) return;
    const remaining = [];
    for (const item of queue) {
      const payload = normalizeWebsitePayload(item);
      try {
        await authenticatedFetch('/candidates', { method: 'POST', body: JSON.stringify(payload) });
      } catch {
        remaining.push(payload);
      }
    }
    await chrome.storage.local.set({ queue: remaining });
  });
}
function mutateQueue(action) {
  const operation = queueMutation.then(action, action);
  queueMutation = operation.catch(() => undefined);
  return operation;
}
function summarizeResults(results) {
  const summary = { total: results.length, applied: 0, pending: 0, queued: 0, failed: 0 };
  for (const result of results) {
    if (result?.queued) summary.queued++;
    else if (!result?.ok) summary.failed++;
    else if (result.result?.autoApplied || result.result?.candidate?.status === 'applied')
      summary.applied++;
    else summary.pending++;
  }
  return summary;
}
function rememberCapture(payloads, results, tabId) {
  if (!Number.isInteger(tabId)) return Promise.resolve(null);
  const operation = receiptMutation.then(async () => {
    const { captureReceipts = {} } = await chrome.storage.local.get('captureReceipts');
    const market = normalizeMarket(payloads[0]?.market);
    const key = receiptKey(tabId, market),
      now = Date.now(),
      pageUrl = payloads.find((payload) => payload.url)?.url || '';
    const previous = captureReceipts[key];
    const items =
      previous?.url === pageUrl && now - previous.updatedAt < RECEIPT_TTL
        ? [...previous.items]
        : [];
    payloads.forEach((payload, index) => {
      const result = results[index] || { ok: false };
      const itemKey = payload.sourceRef || websiteRef(payload);
      const outcome = result.queued
        ? 'queued'
        : !result.ok
          ? 'failed'
          : result.result?.autoApplied || result.result?.candidate?.status === 'applied'
            ? 'applied'
            : 'pending';
      const item = {
        key: itemKey,
        company: payload.company || '',
        position: payload.position || '',
        outcome,
      };
      const existingIndex = items.findIndex((existing) => existing.key === itemKey);
      if (existingIndex >= 0) items[existingIndex] = item;
      else items.push(item);
    });
    const summary = summarizeReceiptItems(items);
    const receipt = { url: pageUrl, market, updatedAt: now, items, summary };
    captureReceipts[key] = receipt;
    await chrome.storage.local.set({ captureReceipts });
    const context = await getCaptureContext(tabId, pageUrl);
    if (!context.enabled || context.market === market) await updateBadge(tabId, summary);
    await chrome.runtime
      .sendMessage({ type: 'capture-updated', tabId, receipt })
      .catch(() => undefined);
    return receipt;
  });
  receiptMutation = operation.catch(() => undefined);
  return operation;
}
function summarizeReceiptItems(items) {
  const summary = { total: items.length, applied: 0, pending: 0, queued: 0, failed: 0 };
  for (const item of items) summary[item.outcome]++;
  return summary;
}
async function updateBadge(tabId, summary) {
  const text = summary.failed
    ? '!'
    : summary.queued
      ? '…'
      : summary.pending
        ? '!'
        : String(Math.min(summary.applied, 99));
  const color = summary.failed
    ? '#c0392b'
    : summary.queued
      ? '#d18a00'
      : summary.pending
        ? '#8c63d7'
        : '#249b63';
  const title = summary.failed
    ? '部分岗位记录失败'
    : summary.queued
      ? `已暂存 ${summary.queued} 个岗位，等待同步`
      : summary.pending
        ? `${summary.pending} 个岗位需要确认`
        : `已成功记录 ${summary.applied} 个岗位`;
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
    chrome.action.setTitle({ tabId, title }),
  ]);
}
function receiptKey(tabId, market) {
  return normalizeMarket(market) === 'us' ? `${tabId}:us` : String(tabId);
}
function getCaptureReceipt(tabId, url, market = 'cn') {
  return receiptMutation.then(async () => {
    if (!Number.isInteger(tabId)) return null;
    const { captureReceipts = {} } = await chrome.storage.local.get('captureReceipts');
    const receipt = captureReceipts[receiptKey(tabId, market)];
    if (!receipt || receipt.url !== url || Date.now() - receipt.updatedAt >= RECEIPT_TTL)
      return null;
    return receipt;
  });
}
function clearCapture(tabId) {
  const operation = receiptMutation.then(async () => {
    const { captureReceipts = {} } = await chrome.storage.local.get('captureReceipts');
    if (captureReceipts[String(tabId)] || captureReceipts[`${tabId}:us`]) {
      delete captureReceipts[String(tabId)];
      delete captureReceipts[`${tabId}:us`];
      await chrome.storage.local.set({ captureReceipts });
    }
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
  });
  receiptMutation = operation.catch(() => undefined);
  return operation;
}
async function authenticatedFetch(path, options = {}) {
  const { token } = await chrome.storage.local.get('token');
  if (!token) throw new Error('请先在扩展设置中粘贴配对令牌');
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-campus-token': token, ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `本地服务返回 ${response.status}`);
  return data;
}
async function monitorProgressPages() {
  try {
    const responses = await Promise.all(
      ['cn', 'us'].map((market) => fetch(`${API}/jobs?market=${market}`)),
    );
    if (responses.some((response) => !response.ok)) return;
    const jobs = (await Promise.all(responses.map((response) => response.json()))).flat();
    for (const job of jobs.filter(
      (item) => !['已offer', '已拒绝', '流程结束'].includes(item.status),
    )) {
      for (const url of job.progressUrls || []) await inspectUrl(url, job);
    }
  } catch {
    /* local service may be offline */
  }
}
async function inspectUrl(url, job) {
  const market = job.market === 'us' ? 'us' : 'cn';
  try {
    const origin = `${new URL(url).origin}/*`;
    if (!(await chrome.permissions.contains({ origins: [origin] }))) return;
    const response = await fetch(url, { credentials: 'include', redirect: 'follow' });
    const text = (await response.text())
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 12000);
    if (/登录|验证码|扫码登录|sign\s*in/i.test(text.slice(0, 2000))) {
      await authenticatedFetch(`/jobs/${job.id}/sync-health?market=${market}`, {
        method: 'POST',
        body: JSON.stringify({ health: 'needs_login' }),
      });
      return;
    }
    const type = classify(text);
    if (type !== 'other')
      await submitCandidate({
        source: 'website',
        market,
        sourceRef: `monitor:${hash(`${url}|${type}|${text.slice(0, 500)}`)}`,
        company: job.company,
        companySource: 'saved-job',
        position: job.position,
        url,
        eventType: type,
        title: titleFor(type),
        occurredAt: new Date().toISOString(),
        evidence: text.slice(0, 280),
        confidence: 0.94,
      });
    await authenticatedFetch(`/jobs/${job.id}/sync-health?market=${market}`, {
      method: 'POST',
      body: JSON.stringify({ health: 'ok' }),
    });
  } catch {
    await authenticatedFetch(`/jobs/${job.id}/sync-health?market=${market}`, {
      method: 'POST',
      body: JSON.stringify({ health: 'error' }),
    }).catch(() => undefined);
  }
}
function classify(text) {
  for (const [type, re] of [
    ['offer', /offer\s*(?:通知|已发放|已收到|阶段|状态)|录用通知/i],
    ['rejection', /未能通过|遗憾地通知|不匹配|已淘汰/i],
    [
      'ai_interview',
      /(?:AI|人工智能|智能|数字人).{0,12}(?:面试|面谈)|(?:面试|面谈).{0,12}(?:AI|人工智能|数字人)|AI\s*interview/i,
    ],
    [
      'ai_assessment',
      /(?:AI|人工智能|智能).{0,12}(?:测评|评估|测试)|(?:测评|评估|测试).{0,12}(?:AI|人工智能)|AI\s*assessment/i,
    ],
    ['written_test', /笔试|在线考试/i],
    ['assessment', /测评|人才评估/i],
    ['interview', /面试|面谈|interview/i],
    ['application', /投递成功|申请成功|简历已提交/i],
  ])
    if (re.test(text)) return type;
  return 'other';
}
function titleFor(type) {
  return (
    {
      application: '投递成功',
      assessment: '测评通知',
      ai_assessment: 'AI 测评通知',
      written_test: '笔试通知',
      interview: '面试通知',
      ai_interview: 'AI 面试通知',
      offer: 'Offer 通知',
      rejection: '未通过',
    }[type] || '进度更新'
  );
}
function websiteRef(payload) {
  return `web:${hash(`${payload.url}|${payload.eventType}|${payload.company}|${payload.position}|${payload.evidence || ''}`)}`;
}
function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
