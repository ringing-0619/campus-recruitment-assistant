let tab,
  origin,
  allowed = false,
  previewItems = [],
  selectedMarket = 'cn',
  busy = false,
  ready = false;
let editorPort,
  refreshPending = false,
  filteredItems = [];
const drafts = new Map();
const marketLabels = { cn: '国内秋招', us: '美国求职' };
const statusLabel = document.querySelector('#status span:last-child');
const enableButton = document.querySelector('#enable');
const feedback = document.querySelector('#feedback');
const addButton = document.querySelector('#add-job');
const refreshButton = document.querySelector('#refresh');
const retryButton = document.querySelector('#retry-page');
document.querySelector('#version').textContent = `v${chrome.runtime.getManifest().version}`;

function draftKey() {
  return `${tab?.id}|${tab?.url}|${selectedMarket}`;
}
function saveDraft() {
  if (ready && allowed) drafts.set(draftKey(), { items: collectItems(), filtered: filteredItems });
}
function disconnectEditor() {
  editorPort?.disconnect();
  editorPort = undefined;
}
async function init(force = false) {
  if (busy) {
    refreshPending = true;
    return;
  }
  setBusy(true);
  retryButton.hidden = true;
  try {
    const activeTab = await currentWebTab();
    if (!force && ready && activeTab.id === tab?.id && activeTab.url === tab?.url) return;
    saveDraft();
    disconnectEditor();
    ready = false;
    hideFeedback();
    tab = activeTab;
    origin = undefined;
    allowed = false;
    previewItems = [];
    filteredItems = [];
    renderItems();
    showAuthorization(false);
    const url = new URL(tab.url);
    origin = `${url.origin}/*`;
    document.querySelector('#site').textContent = url.hostname;
    const context = await chrome.runtime.sendMessage({
      type: 'capture-context',
      tabId: tab.id,
      url: tab.url,
    });
    selectedMarket = context?.market === 'us' ? 'us' : 'cn';
    renderMarket();
    showAuthorization(await chrome.permissions.contains({ origins: [origin] }));
    if (allowed) {
      await inject();
      await loadPreview();
      await loadCaptureSummary();
    }
    ready = true;
  } catch (error) {
    saveDraft();
    disconnectEditor();
    ready = false;
    origin = undefined;
    allowed = false;
    previewItems = [];
    filteredItems = [];
    renderItems();
    showAuthorization(false);
    retryButton.hidden = false;
    statusLabel.textContent = error.message || '读取页面失败，请重试';
    document.querySelector('#site').textContent = '当前页面无法识别';
    showFeedback(error.message || '读取页面失败，请重试', 'error');
  } finally {
    setBusy(false);
  }
}
async function currentWebTab() {
  const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!Number.isInteger(current?.id))
    throw new Error('请先打开需要记录的招聘网页，再点击工具栏中的助手图标');
  let address = current.url;
  // A side panel may stay open after activeTab access was revoked on another domain.
  // A URL-only read can recover when existing host/activeTab access still permits scripting.
  if (!address) {
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: current.id },
        func: () => location.href,
      });
      address = result?.[0]?.result;
    } catch {}
  }
  if (!address)
    throw new Error(
      '浏览器尚未提供当前网页地址。请回到招聘网页，点击工具栏中的「校招进度助手」图标，再重新连接当前网页',
    );
  let url;
  try {
    url = new URL(address);
  } catch {
    throw new Error('当前网页地址暂时不可用，请等待网页加载完成后重新连接');
  }
  if (!/^https?:$/.test(url.protocol))
    throw new Error('请切换到需要记录的招聘网页，再点击工具栏中的助手图标');
  return { ...current, url: url.href };
}
function renderMarket() {
  document
    .querySelectorAll('input[name="market"]')
    .forEach((input) => (input.checked = input.value === selectedMarket));
  document.querySelector('#destination').textContent =
    `当前记录到：${marketLabels[selectedMarket]}`;
  document.querySelector('#open').textContent = `打开${marketLabels[selectedMarket]}助手`;
  updateButtonLabel();
}
function setBusy(value) {
  busy = value;
  enableButton.disabled = value || !origin || (allowed && !previewItems.length);
  addButton.disabled = value || previewItems.length >= 50;
  refreshButton.disabled = value;
  retryButton.disabled = value;
  document.querySelectorAll('input, .remove-job').forEach((control) => (control.disabled = value));
  if (!value && refreshPending) {
    refreshPending = false;
    void init(true);
  }
}
async function selectMarket(activate = false) {
  const result = await chrome.runtime.sendMessage({
    type: 'select-market',
    tabId: tab.id,
    url: tab.url,
    market: selectedMarket,
    preview: !activate,
  });
  if (!result?.ok) throw new Error(result?.error || '无法保存模块选择');
}
function showAuthorization(ok) {
  allowed = ok;
  document.querySelector('#status').classList.toggle('ok', ok);
  statusLabel.textContent = ok ? '已授权，正在识别岗位' : '先授权当前网站，再核对识别结果';
  document.querySelector('#fields').classList.toggle('show', ok);
  updateButtonLabel();
}
async function inject() {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  if (!editorPort) {
    const port = chrome.tabs.connect(tab.id, { name: 'capture-editor' });
    editorPort = port;
    port.onDisconnect.addListener(() => {
      if (editorPort === port) editorPort = undefined;
    });
  }
}
async function loadPreview(force = false) {
  const saved = !force && drafts.get(draftKey());
  if (saved) {
    previewItems = saved.items;
    filteredItems = saved.filtered;
    renderItems();
    showPreviewStatus();
    return;
  }
  const preview = await chrome.tabs.sendMessage(tab.id, {
    type: 'preview-current',
    market: selectedMarket,
  });
  if (!preview?.ok) throw new Error('读取页面失败，请刷新招聘网页后重试');
  previewItems = normalizePreviewItems(preview);
  filteredItems = Array.isArray(preview.excluded) ? preview.excluded : [];
  renderItems();
  showPreviewStatus();
  saveDraft();
}
function showPreviewStatus() {
  statusLabel.textContent = `已授权，识别到 ${previewItems.length} 个可记录岗位`;
  const hint = document.querySelector('#filter-note');
  hint.textContent = filteredItems.length
    ? `已跳过 ${filteredItems.length} 个实习或其他非秋招岗位：${filteredItems.map((item) => item.position || '未命名岗位').join('、')}`
    : selectedMarket === 'cn'
      ? '国内秋招会过滤实习、社招和春招岗位。未标明招聘批次的岗位请核对后记录。'
      : '';
}
function normalizePreviewItems(preview) {
  if (Array.isArray(preview?.items))
    return preview.items
      .filter((item) => item && typeof item === 'object')
      .map((item, index) => ({
        key: String(item.key || `item:${index}`),
        company: String(item.company || ''),
        position: String(item.position || ''),
      }));
  return [
    {
      key: 'item:0',
      company: String(preview?.company || ''),
      position: String(preview?.position || ''),
    },
  ];
}
function renderItems() {
  const list = document.querySelector('#job-list');
  list.replaceChildren();
  previewItems.forEach((item, index) => {
    const card = document.createElement('article');
    card.className = 'job-card';
    card.dataset.key = item.key;
    const head = document.createElement('div');
    head.className = 'job-card-head';
    const title = document.createElement('span');
    title.className = 'job-card-title';
    title.textContent = `岗位 ${index + 1}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-job';
    remove.textContent = '移除';
    remove.setAttribute('aria-label', `移除岗位 ${index + 1}`);
    remove.addEventListener('click', () => {
      if (busy) return;
      previewItems = collectItems();
      previewItems.splice(index, 1);
      renderItems();
      saveDraft();
      hideFeedback();
    });
    head.append(title, remove);
    card.append(
      head,
      field(
        '公司',
        item.company,
        'company',
        selectedMarket === 'cn' ? '公司中文名，可修改' : '公司名称，可修改',
      ),
      field('岗位', item.position, 'position', '岗位名称，可修改'),
    );
    list.append(card);
  });
  document.querySelector('#empty-list').hidden = previewItems.length > 0;
  document.querySelector('#detected-count').textContent = `${previewItems.length} 个岗位`;
  updateButtonLabel();
  setBusy(busy);
}
function field(labelText, value, name, placeholder) {
  const label = document.createElement('label');
  label.append(document.createTextNode(labelText));
  const input = document.createElement('input');
  input.dataset.field = name;
  input.value = value;
  input.placeholder = placeholder;
  input.maxLength = name === 'company' ? 60 : 100;
  input.addEventListener('input', () => {
    hideFeedback();
    previewItems = collectItems();
    saveDraft();
  });
  label.append(input);
  return label;
}
function collectItems() {
  return Array.from(document.querySelectorAll('.job-card')).map((card) => ({
    key: card.dataset.key || '',
    company: card.querySelector('[data-field="company"]').value.trim(),
    position: card.querySelector('[data-field="position"]').value.trim(),
  }));
}
function updateButtonLabel() {
  const count = previewItems.length;
  enableButton.textContent = allowed
    ? count
      ? `记录这 ${count} 个岗位到${marketLabels[selectedMarket]}`
      : '请先添加需要记录的岗位'
    : '授权并识别当前网站';
}
function showFeedback(message, type = 'success') {
  feedback.textContent = message;
  feedback.className = `feedback show ${type}`;
}
function hideFeedback() {
  feedback.className = 'feedback';
  feedback.textContent = '';
}
async function loadCaptureSummary() {
  const response = await chrome.runtime
    .sendMessage({ type: 'capture-summary', tabId: tab.id, url: tab.url, market: selectedMarket })
    .catch(() => null);
  if (response?.receipt) showReceipt(response.receipt.summary);
}
function showReceipt(summary) {
  if (!summary?.total) return;
  if (summary.failed) {
    showFeedback(`有 ${summary.failed} 个岗位记录失败，请再次尝试`, 'error');
    return;
  }
  if (summary.queued) {
    showFeedback(`已暂存 ${summary.queued} 个岗位，本地服务恢复后会自动同步`, 'warning');
    return;
  }
  if (summary.pending) {
    showFeedback(
      `${summary.applied ? `已成功记录 ${summary.applied} 个岗位；` : ''}${summary.pending} 个岗位需要在${marketLabels[selectedMarket]}中确认`,
      'pending',
    );
    return;
  }
  showFeedback(`已成功记录 ${summary.applied} 个岗位到${marketLabels[selectedMarket]}`);
}
function summarize(results) {
  const summary = { total: results.length, applied: 0, pending: 0, queued: 0, failed: 0 };
  results.forEach((result) => {
    if (result?.queued) summary.queued++;
    else if (!result?.ok) summary.failed++;
    else if (result.result?.autoApplied || result.result?.candidate?.status === 'applied')
      summary.applied++;
    else summary.pending++;
  });
  return summary;
}
async function assertCurrentPage() {
  const current = await currentWebTab();
  if (current?.id !== tab.id || current?.url !== tab.url) {
    refreshPending = true;
    throw new Error('招聘网页已切换，请核对新页面的识别结果');
  }
}
async function recordCurrent() {
  const items = collectItems();
  if (!items.length) {
    showFeedback('请先添加需要记录的岗位', 'error');
    return;
  }
  const invalid = items.findIndex(
    (item) =>
      !item.company ||
      !item.position ||
      (selectedMarket === 'cn' && !/[\u3400-\u9fff]/.test(item.company)),
  );
  if (invalid >= 0) {
    showFeedback(
      `请补充岗位 ${invalid + 1} 的${selectedMarket === 'cn' ? '公司中文名和岗位名称' : '公司和岗位名称'}`,
      'error',
    );
    return;
  }
  hideFeedback();
  setBusy(true);
  enableButton.textContent = '正在记录…';
  await assertCurrentPage();
  await selectMarket(true);
  const result = await chrome.tabs.sendMessage(tab.id, {
    type: 'record-current',
    market: selectedMarket,
    items,
  });
  if (result?.needsInput)
    showFeedback(
      result.excluded
        ? '国内秋招仅记录秋招岗位，请移除实习、社招或春招条目'
        : result.needsChineseCompany
          ? '请填写对应的公司中文名后再记录'
          : '请补充所有条目的公司和岗位名称',
      'error',
    );
  else if (result?.error) throw new Error(result.error);
  else showReceipt(summarize(Array.isArray(result) ? result : result?.results || [result]));
  saveDraft();
}
enableButton.onclick = async () => {
  if (busy || !origin) return;
  try {
    if (!allowed) {
      // 必须直接在点击回调中申请；侧栏在授权对话框出现时保持打开。
      setBusy(true);
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        showFeedback('未获得网站授权，可以再次点击授权', 'warning');
        return;
      }
      setBusy(true);
      await assertCurrentPage();
      showAuthorization(true);
      await inject();
      await loadPreview();
      showFeedback('识别完成，可修改、添加或移除岗位，核对后点击记录', 'pending');
    } else await recordCurrent();
  } catch (error) {
    showFeedback(error.message || '记录失败，请重试', 'error');
  } finally {
    setBusy(false);
    updateButtonLabel();
  }
};
addButton.onclick = () => {
  if (busy || previewItems.length >= 50) return;
  previewItems = collectItems();
  previewItems.push({
    key: `manual:${crypto.randomUUID()}`,
    company: previewItems.at(-1)?.company || '',
    position: '',
  });
  renderItems();
  saveDraft();
  hideFeedback();
  document
    .querySelectorAll('.job-card')
    .item(previewItems.length - 1)
    ?.querySelector('[data-field="position"]')
    ?.focus();
};
refreshButton.onclick = async () => {
  if (busy) return;
  hideFeedback();
  setBusy(true);
  try {
    await assertCurrentPage();
    await loadPreview(true);
  } catch (error) {
    showFeedback(error.message || '识别失败，请重试', 'error');
  } finally {
    setBusy(false);
  }
};
retryButton.onclick = () => init(true);
document.querySelectorAll('input[name="market"]').forEach((input) =>
  input.addEventListener('change', async () => {
    if (busy) return;
    saveDraft();
    selectedMarket = input.value === 'us' ? 'us' : 'cn';
    renderMarket();
    hideFeedback();
    setBusy(true);
    try {
      if (ready && tab?.url) {
        await selectMarket();
        if (allowed) {
          await loadPreview();
          await loadCaptureSummary();
        }
      }
    } catch (error) {
      showFeedback(error.message || '模块切换失败，请重试', 'error');
    } finally {
      setBusy(false);
    }
  }),
);
document.querySelector('#open').onclick = () =>
  chrome.tabs.create({ url: `http://127.0.0.1:43110/?market=${selectedMarket}` });
chrome.tabs.onActivated.addListener(() => void init());
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId === tab?.id && (change.url || change.status === 'complete')) void init(true);
});
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'capture-page-ready') {
    void init(true);
    return;
  }
  if (
    message.type === 'capture-updated' &&
    message.tabId === tab?.id &&
    message.receipt?.url === tab?.url &&
    (message.receipt.market || 'cn') === selectedMarket
  )
    showReceipt(message.receipt.summary);
});
void init();
