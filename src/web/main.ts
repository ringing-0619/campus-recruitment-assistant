import { isDay, localInZone, zonedToIso } from '../shared/time';
import './productivity.css';
import {
  initProductivity,
  loadProductivity,
  populateApplication,
  readApplicationForm,
  productivityTimezone,
  selectProductivityMarket,
} from './productivity';
import {
  EVENT_TYPES,
  JOB_STATUSES,
  MARKET_LABELS,
  normalizeMarket,
  type Market,
  type Candidate,
  type EventType,
  type Job,
  type SyncStatus,
} from '../shared/types';

let activeMarket = normalizeMarket(
  new URL(location.href).searchParams.get('market') || localStorage.getItem('campus-market'),
);
let loadVersion = 0;
let routingDirty = false;

const EVENT_LABELS: Record<EventType, string> = {
  application: '投递',
  assessment: '测评',
  ai_assessment: 'AI 测评',
  written_test: '笔试',
  interview: '面试',
  ai_interview: 'AI 面试',
  offer: 'Offer',
  rejection: '拒绝',
  ended: '流程结束',
  other: '其他',
};

const api = async <T>(
  path: string,
  options: RequestInit = {},
  market: Market = activeMarket,
): Promise<T> => {
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`/api/v1${path}${path.includes('?') ? '&' : '?'}market=${market}`, {
    ...options,
    headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
};
let jobs: Job[] = [],
  candidates: Candidate[] = [],
  status: SyncStatus | null = null;
type MetricFilter = 'all' | 'active' | 'tasks' | 'offers';
let metricFilter: MetricFilter = 'all';
const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector(selector) as T;

async function loadAll() {
  const version = ++loadVersion;
  const market = activeMarket;
  try {
    const data = await Promise.all([
      api<Job[]>('/jobs', {}, market),
      api<Candidate[]>('/candidates', {}, market),
      api<SyncStatus>('/status', {}, market),
    ]);
    if (version !== loadVersion || market !== activeMarket) return;
    [jobs, candidates, status] = data;
    $('#servicePill').classList.add('online');
    $('#servicePill').innerHTML = '<i></i> 本地服务在线';
    render();
    await loadProductivity(market, jobs);
    renderDashboard();
  } catch (error) {
    if (version === loadVersion) {
      $('#servicePill').textContent = '本地服务离线';
      toast((error as Error).message);
    }
  }
}

function renderMarket() {
  document.querySelectorAll<HTMLButtonElement>('[data-market]').forEach((button) => {
    const active = button.dataset.market === activeMarket;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('#workspaceTitle').textContent = `${MARKET_LABELS[activeMarket]}进度记录`;
  $('#workspaceTag').textContent = MARKET_LABELS[activeMarket];
  $('#workspaceDescription').textContent =
    activeMarket === 'us'
      ? '集中管理美国求职的投递、测评与面试。'
      : '集中管理国内秋招的投递、测评与面试。';
  document.title = `${MARKET_LABELS[activeMarket]} · 校招进度助手`;
}

async function switchMarket(market: Market) {
  if (market === activeMarket) return;
  const stayOnGoals = $('#page-goals').classList.contains('active');
  activeMarket = market;
  selectProductivityMarket(market);
  localStorage.setItem('campus-market', market);
  const url = new URL(location.href);
  url.searchParams.set('market', market);
  history.replaceState(null, '', url);
  jobs = [];
  candidates = [];
  status = null;
  metricFilter = 'all';
  setValue('search', '');
  setValue('statusFilter', '全部');
  setValue('sortBy', 'updated');
  $('#auditList').innerHTML = '';
  $('#syncSummary').innerHTML = '';
  $('#pdfReport').innerHTML = '';
  renderMarket();
  render();
  if (!stayOnGoals) document.querySelector<HTMLButtonElement>('[data-page="dashboard"]')!.click();
  $('#jobList').innerHTML = empty('正在加载投递记录…');
  await loadAll();
}

function render() {
  renderDashboard();
  renderCandidates();
  renderSettings();
}
function renderDashboard() {
  const q = ($('#search') as HTMLInputElement).value.trim().toLowerCase();
  const filter = ($('#statusFilter') as HTMLSelectElement).value;
  const sort = ($('#sortBy') as HTMLSelectElement).value;
  let visible = jobs.filter(
    (job) =>
      (filter === '已归档' ? Boolean(job.application?.archived) : !job.application?.archived) &&
      matchesMetric(job, metricFilter) &&
      (filter === '全部' || filter === '已归档' || job.status === filter) &&
      (!q || `${job.company} ${job.position} ${job.notes}`.toLowerCase().includes(q)),
  );
  visible.sort((a, b) =>
    sort === 'company'
      ? a.company.localeCompare(b.company, 'zh-CN')
      : sort === 'deadline'
        ? (a.nextDeadline || '9999').localeCompare(b.nextDeadline || '9999')
        : b.updatedAt.localeCompare(a.updatedAt),
  );
  const active = jobs.filter(
    (job) =>
      !job.application?.archived &&
      !job.application?.excluded &&
      !['已offer', '已拒绝', '流程结束'].includes(job.status),
  ).length;
  const openTasks = jobs
    .flatMap((job) => job.tasks)
    .filter((task) => !task.completedAt && !task.cancelledAt && !task.resolvedAt).length;
  $('#metrics').innerHTML =
    metric('全部机会', jobs.length, 'all') +
    metric('正在推进', active, 'active') +
    metric('待完成事项', openTasks, 'tasks') +
    metric('收获 Offer', jobs.filter((j) => j.status === '已offer').length, 'offers');
  $('#listTitle').textContent = {
    all: '全部机会',
    active: '正在推进',
    tasks: '有待完成事项的投递',
    offers: '收获 Offer',
  }[metricFilter];
  $('#resultCount').textContent = `${visible.length} / ${jobs.length} 条`;
  $('#jobList').innerHTML = visible.length
    ? visible.map(jobCard).join('')
    : jobs.length
      ? empty('没有匹配的投递记录')
      : `<div class="empty"><strong>开始记录你的${MARKET_LABELS[activeMarket]}</strong><p>添加第一份投递，把申请、测评和面试进度留在这里。</p><button type="button" class="btn primary" data-add-job>＋ 新增投递</button></div>`;
  const deadlines = jobs
    .flatMap((job) =>
      job.tasks
        .filter((task) => !task.completedAt && !task.cancelledAt && !task.resolvedAt && task.dueAt)
        .map((task) => ({ job, task })),
    )
    .sort((a, b) => a.task.dueAt!.localeCompare(b.task.dueAt!))
    .slice(0, 6);
  $('#deadlines').innerHTML = deadlines.length
    ? deadlines
        .map(
          ({ job, task }) =>
            `<div class="deadline-item"><strong>${esc(job.company)} · ${esc(task.title)}</strong><span>${formatDate(task.dueAt!)} · ${relative(task.dueAt!)}</span></div>`,
        )
        .join('')
    : '<div class="sync-line"><span>暂无临近截止任务</span></div>';
  if (status)
    $('#syncSummary').innerHTML =
      `<div class="sync-line">126 邮箱<br><span>${esc(mailStatusText(status.email))}</span><br><span>新邮件归属：${MARKET_LABELS[status.routing.email]}</span></div><div class="sync-line">浏览器扩展<br><span>${status.extension.paired ? (status.extension.lastSeenAt ? `上次活动 ${formatDate(status.extension.lastSeenAt)}` : '已配对') : '未配对'}</span><br><span>网站默认：${MARKET_LABELS[status.routing.website]}（插件选择优先）</span></div><div class="sync-line">当前模块待确认<br><span>${status.pendingCandidates} 条识别结果</span></div>`;
}
function jobCard(job: Job) {
  const latest = job.events[0];
  const tasks = job.tasks.filter(
    (task) => !task.completedAt && !task.cancelledAt && !task.resolvedAt,
  );
  return `<article class="job-card" data-id="${job.id}"><div class="job-top"><div><h3>${esc(job.company)}</h3><div class="position">${esc(job.position)}</div></div><span class="badge ${job.status}">${esc(job.status)}${job.application?.excluded ? ' · 已作废' : ''}</span></div><div class="job-meta">${latest ? `<span>最近：${esc(latest.title)} · ${formatDate(latest.occurredAt)}</span>` : '<span>暂无进度</span>'}${job.nextDeadline ? `<span>截止：${formatDate(job.nextDeadline)} · ${relative(job.nextDeadline)}</span>` : ''}${job.syncHealth === 'needs_login' ? '<span>⚠ 需要重新登录</span>' : ''}</div>${tasks.length ? `<div class="task-list">${tasks.map((task) => `<div class="task"><div class="task-info"><div class="task-title">${esc(task.title)}</div><div class="task-date">${task.startsAt ? `开始 ${formatDate(task.startsAt)}` : ''}${task.dueAt ? ` · 截止 ${formatDate(task.dueAt)}` : ' · 未提供截止时间'}</div></div><button class="complete" data-task="${task.id}">✓ 已完成</button></div>`).join('')}</div>` : ''}<div class="job-actions"><button class="btn" data-edit="${job.id}">编辑</button>${job.progressUrls[0] ? `<a class="btn" href="${esc(job.progressUrls[0])}" target="_blank" rel="noopener">进度页 ↗</a>` : ''}<button class="btn" data-archive="${job.id}">${job.application?.archived ? '恢复' : '归档'}</button><button class="btn danger" data-delete="${job.id}">删除</button></div></article>`;
}
function renderCandidates() {
  $('#pendingBadge').textContent = String(candidates.length);
  $('#candidateList').innerHTML = candidates.length
    ? candidates
        .map(
          (candidate) =>
            `<article class="review-card"><div><h3>${esc(candidate.title)} · ${esc(candidate.company || '公司待确认')}</h3><p>${esc(candidate.position || '岗位待确认')} · 类型：${EVENT_LABELS[candidate.eventType]} · 来源：${candidate.source === 'email' ? '126 邮箱' : '招聘网站'}</p><p>${esc(candidate.evidence)}</p>${candidate.reviewReason ? `<p>待确认原因：${esc(candidate.reviewReason)}</p>` : ''}<span class="confidence">识别置信度 ${Math.round(candidate.confidence * 100)}%</span></div><div class="review-actions"><button class="btn" data-ignore="${candidate.id}">忽略</button><button class="btn primary" data-review="${candidate.id}">确认</button></div></article>`,
        )
        .join('')
    : empty('没有待确认的自动更新');
}
function renderSettings() {
  if (!status) return;
  if (!routingDirty) {
    setValue('emailMarket', status.routing.email);
    setValue('websiteMarket', status.routing.website);
  }
  $('#mailState').textContent = status.email.configured
    ? `${status.email.address} · ${mailStatusText(status.email)}`
    : '尚未连接';
  $('#extensionState').textContent = status.extension.paired ? '已生成配对令牌' : '尚未配对';
  $('#domainList').innerHTML = status.unrecognizedDomains.length
    ? status.unrecognizedDomains
        .map((item) => `<span class="domain-chip">${esc(item.domain)} · ${item.count} 次</span>`)
        .join('')
    : '<span class="domain-chip">暂无</span>';
}
async function loadAudit() {
  const market = activeMarket;
  const rows = await api<Array<Record<string, string>>>('/audit');
  if (market !== activeMarket) return;
  $('#auditList').innerHTML = rows.length
    ? rows
        .map(
          (row) =>
            `<div class="activity-item"><div class="activity-type">${actionLabel(row.action)}</div><div class="activity-id">${esc(row.entityType)} · ${esc(row.entityId)}</div><div class="activity-time">${formatDate(row.createdAt)}${Number(row.canUndo) && !row.undoneAt ? `<br><button class="btn" data-undo="${row.id}">撤销</button>` : row.undoneAt ? '<br>已撤销' : ''}</div></div>`,
        )
        .join('')
    : empty('暂无更新记录');
}

document
  .querySelectorAll<HTMLButtonElement>('[data-market]')
  .forEach((button) =>
    button.addEventListener(
      'click',
      () => void switchMarket(normalizeMarket(button.dataset.market)),
    ),
  );
document.querySelectorAll('.tab').forEach((button) =>
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab,.page').forEach((el) => el.classList.remove('active'));
    button.classList.add('active');
    $(`#page-${(button as HTMLElement).dataset.page}`).classList.add('active');
    if ((button as HTMLElement).dataset.page === 'activity')
      void loadAudit().catch((error) => toast(error.message));
  }),
);
$('#routingForm').addEventListener('input', () => {
  routingDirty = true;
});
$('#routingForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $<HTMLButtonElement>('#routingForm button');
  button.disabled = true;
  try {
    await api('/routing', {
      method: 'PUT',
      body: JSON.stringify({ email: value('emailMarket'), website: value('websiteMarket') }),
    });
    routingDirty = false;
    toast('自动识别归属已保存');
    await loadAll();
  } catch (error) {
    toast((error as Error).message);
  } finally {
    button.disabled = false;
  }
});
['search', 'statusFilter', 'sortBy'].forEach((id) =>
  $(`#${id}`).addEventListener('input', renderDashboard),
);
$('#metrics').addEventListener('click', (event) => {
  const card = (event.target as HTMLElement).closest<HTMLElement>('[data-metric]');
  if (!card) return;
  metricFilter = card.dataset.metric as MetricFilter;
  setValue('statusFilter', '全部');
  renderDashboard();
  $('#listTitle').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('#refresh').addEventListener('click', loadAll);
$('#addJob').addEventListener('click', () => openJob());
document
  .querySelectorAll('[data-close]')
  .forEach((el) =>
    el.addEventListener('click', () => ($('#jobDialog') as HTMLDialogElement).close()),
  );
document
  .querySelectorAll('[data-review-close]')
  .forEach((el) =>
    el.addEventListener('click', () => ($('#reviewDialog') as HTMLDialogElement).close()),
  );
$('#jobForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const id = ($('#jobId') as HTMLInputElement).value;
    let application;
    try {
      application = readApplicationForm();
    } catch (error) {
      toast((error as Error).message);
      return;
    }
    const body = {
      application,
      company: value('company'),
      position: value('position'),
      status: value('jobStatus'),
      notes: value('notes'),
      progressUrls: value('progressUrl') ? [value('progressUrl')] : [],
    };
    await api(id ? `/jobs/${id}` : '/jobs', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    });
    ($('#jobDialog') as HTMLDialogElement).close();
    toast(id ? '记录已更新' : '投递已添加');
    await loadAll();
  } catch (error) {
    toast((error as Error).message);
  }
});
$('#jobList').addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('[data-add-job]')) {
    openJob();
    return;
  }
  const task = target.closest<HTMLElement>('[data-task]');
  if (task) {
    try {
      await api(`/tasks/${task.dataset.task}/complete`, { method: 'POST', body: '{}' });
      toast('已记录完成时间');
      await loadAll();
    } catch (error) {
      if (
        (error as Error).message.includes('已经完成') &&
        confirm('该任务已经完成，是否用当前时间覆盖？')
      )
        await api(`/tasks/${task.dataset.task}/complete`, {
          method: 'POST',
          body: JSON.stringify({ overwrite: true }),
        });
    }
    return;
  }
  const archive = target.closest<HTMLElement>('[data-archive]');
  if (archive) {
    const job = jobs.find((j) => j.id === archive.dataset.archive)!;
    await api('/applications/batch', {
      method: 'PUT',
      body: JSON.stringify({
        ids: [job.id],
        application: { archived: !job.application?.archived },
      }),
    });
    toast('归档状态已更新，历史统计保留');
    await loadAll();
    return;
  }
  const edit = target.closest<HTMLElement>('[data-edit]');
  if (edit) openJob(jobs.find((j) => j.id === edit.dataset.edit));
  const del = target.closest<HTMLElement>('[data-delete]');
  if (del && confirm('确定删除这条投递及其全部进度吗？')) {
    await api(`/jobs/${del.dataset.delete}`, { method: 'DELETE' });
    toast('记录已删除');
    await loadAll();
  }
});
$('#candidateList').addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  const ignore = target.closest<HTMLElement>('[data-ignore]');
  if (ignore) {
    await api(`/candidates/${ignore.dataset.ignore}/ignore`, { method: 'POST' });
    await loadAll();
  }
  const review = target.closest<HTMLElement>('[data-review]');
  if (review) openReview(candidates.find((c) => c.id === review.dataset.review)!);
});
$('#auditList').addEventListener('click', async (event) => {
  const undo = (event.target as HTMLElement).closest<HTMLElement>('[data-undo]');
  if (undo && confirm('撤销这次更新？')) {
    await api(`/audit/${undo.dataset.undo}/undo`, { method: 'POST' });
    toast('更新已撤销');
    await Promise.all([loadAll(), loadAudit()]);
  }
});
$('#reviewForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const candidateId = value('candidateId'),
    jobId = value('candidateJob');
  await api(`/candidates/${candidateId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({
      jobId: jobId || null,
      overrides: {
        company: value('candidateCompany'),
        position: value('candidatePosition'),
        title: value('candidateTitle'),
        dueAt: localToIso(value('candidateDue')),
        eventType: value('candidateEventType'),
      },
    }),
  });
  ($('#reviewDialog') as HTMLDialogElement).close();
  toast('更新已写入');
  await loadAll();
});
$('#mailForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = (event.target as HTMLFormElement).querySelector('button')!;
  button.textContent = '正在验证…';
  button.setAttribute('disabled', '');
  try {
    await api('/email/configure', {
      method: 'POST',
      body: JSON.stringify({ address: value('mailAddress'), authorizationCode: value('mailCode') }),
    });
    ($('#mailCode') as HTMLInputElement).value = '';
    toast('126 邮箱连接成功');
    await loadAll();
  } catch (error) {
    toast((error as Error).message);
  } finally {
    button.textContent = '连接并验证';
    button.removeAttribute('disabled');
  }
});
$('#mailCode').addEventListener('input', () => {
  const input = $<HTMLInputElement>('#mailCode');
  const normalized = input.value.normalize('NFKC').replace(/[\s-]+/g, '');
  if (input.value !== normalized) input.value = normalized;
  const hint = $('#mailCodeHint');
  hint.textContent = `已识别 ${normalized.length} / 16 位（保留大小写）`;
  hint.classList.toggle('valid', normalized.length === 16);
});
$('#syncMail').addEventListener('click', async () => {
  try {
    const result = await api<{ processed: number }>('/email/sync', { method: 'POST' });
    toast(`同步完成，识别 ${result.processed || 0} 封招聘邮件`);
    await loadAll();
  } catch (error) {
    toast((error as Error).message);
    await loadAll();
  }
});
$('#disconnectMail').addEventListener('click', async () => {
  if (confirm('断开邮箱并从钥匙串删除授权码？')) {
    await api('/email/configure', { method: 'DELETE' });
    await loadAll();
  }
});
$('#copyToken').addEventListener('click', async () => {
  const pairing = await api<{ token: string }>('/pairing');
  ($('#pairToken') as HTMLInputElement).value = pairing.token;
  await navigator.clipboard.writeText(pairing.token);
  toast('配对令牌已复制');
  await loadAll();
});
document.querySelectorAll<HTMLElement>('[data-export-pdf]').forEach((button) =>
  button.addEventListener('click', () => {
    if (!jobs.length) {
      toast('暂无可导出的投递记录');
      return;
    }
    renderPdfReport();
    toast('正在打开 PDF 保存窗口');
    const originalTitle = document.title;
    document.title = `${MARKET_LABELS[activeMarket]}进度报告-${new Date().toISOString().slice(0, 10)}`;
    window.addEventListener(
      'afterprint',
      () => {
        document.title = originalTitle;
      },
      { once: true },
    );
    requestAnimationFrame(() => window.print());
  }),
);
$('#exportData').addEventListener('click', async () => {
  const data = await api('/export');
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `${MARKET_LABELS[activeMarket]}备份-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
$('#importData').addEventListener('change', async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (
      confirm(
        `将导入到${MARKET_LABELS[activeMarket]}，合并同 ID 记录，并恢复备份中的目标、统计时区和跟进阈值；保留其他记录，是否继续？`,
      )
    ) {
      await api('/import', { method: 'POST', body: JSON.stringify(data) });
      toast('数据导入成功');
      await loadAll();
    }
  } catch (error) {
    toast((error as Error).message);
  }
  (event.target as HTMLInputElement).value = '';
});

function openJob(job?: Job) {
  populateApplication(job);
  ($('#jobId') as HTMLInputElement).value = job?.id || '';
  $('#jobDialogTitle').textContent =
    `${MARKET_LABELS[activeMarket]} · ${job ? '编辑投递' : '新增投递'}`;
  setValue('company', job?.company || '');
  setValue('position', job?.position || '');
  setValue('jobStatus', job?.status || '已投递');
  setValue('progressUrl', job?.progressUrls[0] || '');
  setValue('notes', job?.notes || '');
  ($('#jobDialog') as HTMLDialogElement).showModal();
}
function openReview(candidate: Candidate) {
  setValue('candidateId', candidate.id);
  setValue('candidateCompany', candidate.company);
  setValue('candidatePosition', candidate.position);
  setValue('candidateEventType', candidate.eventType);
  setValue('candidateTitle', candidate.title);
  setValue('candidateDue', isoToLocal(candidate.dueAt));
  $('#candidateEvidence').textContent = candidate.evidence;
  const select = $<HTMLSelectElement>('#candidateJob');
  select.innerHTML = `<option value="">新建岗位</option>${jobs.map((job) => `<option value="${job.id}">${esc(job.company)} · ${esc(job.position)}</option>`).join('')}`;
  select.value = candidate.suggestedJobId || '';
  ($('#reviewDialog') as HTMLDialogElement).showModal();
}
function renderPdfReport() {
  const generatedAt = new Date();
  const active = jobs.filter(
    (job) => !['已offer', '已拒绝', '流程结束'].includes(job.status),
  ).length;
  const openTasks = jobs
    .flatMap((job) => job.tasks)
    .filter((task) => !task.completedAt && !task.cancelledAt && !task.resolvedAt).length;
  const ordered = [...jobs].sort(
    (a, b) =>
      pdfStatusRank(a.status) - pdfStatusRank(b.status) || b.updatedAt.localeCompare(a.updatedAt),
  );
  $('#pdfReport').innerHTML = `
    <header class="pdf-cover"><div><div class="pdf-kicker">CAMPUS APPLICATION REPORT</div><h1>${MARKET_LABELS[activeMarket]}进度报告</h1><p>生成时间：${formatPdfDate(generatedAt.toISOString())}</p></div><div class="pdf-mark">校招<br>助手</div></header>
    <section class="pdf-summary"><div><span>全部投递</span><strong>${jobs.length}</strong></div><div><span>正在推进</span><strong>${active}</strong></div><div><span>待完成事项</span><strong>${openTasks}</strong></div><div><span>已获 Offer</span><strong>${jobs.filter((job) => job.status === '已offer').length}</strong></div></section>
    <h2 class="pdf-section-title">投递明细与时间线</h2>
    <main class="pdf-jobs">${ordered.map((job, index) => pdfJob(job, index + 1)).join('')}</main>
    <footer class="pdf-footer">校招进度助手 · 数据仅在本机生成 · 共 ${jobs.length} 条投递</footer>`;
}
function pdfJob(job: Job, index: number) {
  const timeline = [...job.events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const events = timeline.length
    ? timeline
        .map(
          (event) =>
            `<div class="pdf-timeline-row"><div class="pdf-dot"></div><time>${formatPdfDate(event.occurredAt)}</time><div><strong>${esc(event.title)}</strong><span>${EVENT_LABELS[event.type]} · ${sourceLabel(event.source)}${event.dueAt ? ` · 截止 ${formatPdfDate(event.dueAt)}` : ''}${event.completedAt ? ` · 已于 ${formatPdfDate(event.completedAt)} 完成` : ''}</span></div></div>`,
        )
        .join('')
    : `<div class="pdf-timeline-row"><div class="pdf-dot"></div><time>${formatPdfDate(job.createdAt)}</time><div><strong>创建投递记录</strong><span>尚无后续进度</span></div></div>`;
  const tasks = job.tasks.filter(
    (task) => !task.completedAt && !task.cancelledAt && !task.resolvedAt,
  );
  return `<article class="pdf-job"><div class="pdf-job-head"><div><span class="pdf-index">${String(index).padStart(2, '0')}</span><h3>${esc(job.company)}</h3><p>${esc(job.position)}</p></div><span class="pdf-status ${pdfStatusTone(job.status)}">${esc(job.status)}</span></div>${tasks.length ? `<div class="pdf-open-task">待完成：${tasks.map((task) => `${esc(task.title)}${task.dueAt ? `（截止 ${formatPdfDate(task.dueAt)}）` : ''}`).join('；')}</div>` : ''}<div class="pdf-timeline">${events}</div>${job.notes ? `<div class="pdf-notes"><b>备注</b> ${esc(job.notes)}</div>` : ''}</article>`;
}
function pdfStatusRank(status: string) {
  if (status === '已offer') return 1;
  if (status === '已拒绝' || status === '流程结束') return 2;
  return 0;
}
function pdfStatusTone(status: string) {
  return (
    (
      {
        待投递: 'status-ready',
        已投递: 'status-applied',
        测评中: 'status-assessment',
        AI测评中: 'status-ai',
        笔试中: 'status-written',
        面试中: 'status-interview',
        AI面试中: 'status-ai',
        等待结果: 'status-waiting',
        已offer: 'status-offer',
        已拒绝: 'status-closed',
        流程结束: 'status-closed',
      } as Record<string, string>
    )[status] || 'status-ready'
  );
}
function sourceLabel(source: string) {
  return (
    ({ manual: '手动记录', website: '招聘网站', email: '邮箱识别' } as Record<string, string>)[
      source
    ] || source
  );
}
function formatPdfDate(value: string) {
  const dateOnly = isDay(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: dateOnly ? 'UTC' : productivityTimezone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: dateOnly ? undefined : '2-digit',
    minute: dateOnly ? undefined : '2-digit',
    hour12: false,
  })
    .format(new Date(dateOnly ? `${value}T12:00:00Z` : value))
    .replaceAll('/', '-');
}
function mailStatusText(email: SyncStatus['email']) {
  if (!email.configured) return '未连接';
  if (email.syncing) return '正在同步…';
  if (email.lastError) {
    const retry = email.nextRetryAt ? `；将于 ${formatDate(email.nextRetryAt)} 自动重试` : '';
    return `${email.lastError}${retry}`;
  }
  return email.lastSyncAt ? `上次同步 ${formatDate(email.lastSyncAt)}` : '已连接，等待首次同步';
}
function matchesMetric(job: Job, filter: MetricFilter) {
  if (filter === 'active') return !['已offer', '已拒绝', '流程结束'].includes(job.status);
  if (filter === 'tasks')
    return job.tasks.some((task) => !task.completedAt && !task.cancelledAt && !task.resolvedAt);
  if (filter === 'offers') return job.status === '已offer';
  return true;
}
function metric(label: string, n: number, filter: MetricFilter) {
  return `<button type="button" class="metric${metricFilter === filter ? ' active' : ''}" data-metric="${filter}" aria-pressed="${metricFilter === filter}"><span>${label}</span><strong>${n}</strong><small>点击筛选</small></button>`;
}
function empty(text: string) {
  return `<div class="empty">${text}</div>`;
}
function value(id: string) {
  return ($(`#${id}`) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value.trim();
}
function setValue(id: string, v: string) {
  ($(`#${id}`) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value = v;
}
function esc(value: unknown) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}
function formatDate(value: string) {
  const dateOnly = isDay(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: dateOnly ? 'UTC' : productivityTimezone(),
    month: 'short',
    day: 'numeric',
    hour: dateOnly ? undefined : '2-digit',
    minute: dateOnly ? undefined : '2-digit',
  }).format(new Date(dateOnly ? `${value}T12:00:00Z` : value));
}
function relative(value: string) {
  const days = Math.ceil((new Date(value).getTime() - Date.now()) / 864e5);
  return days < 0
    ? `已逾期 ${-days} 天`
    : days === 0
      ? '今天'
      : days === 1
        ? '明天'
        : `${days} 天后`;
}
function isoToLocal(value: string | null) {
  return value && !isDay(value) ? localInZone(value, productivityTimezone()) : '';
}
function localToIso(value: string) {
  return value ? zonedToIso(value, productivityTimezone()) : null;
}
function actionLabel(action: string) {
  return (
    (
      {
        create: '新增',
        update: '更新',
        delete: '删除',
        complete: '完成',
        candidate_apply: '自动写入',
      } as Record<string, string>
    )[action] || action
  );
}
function toast(message: string) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

$('#statusFilter').innerHTML = ['全部', ...JOB_STATUSES, '已归档']
  .map((item) => `<option>${item}</option>`)
  .join('');
$('#jobStatus').innerHTML = JOB_STATUSES.map((item) => `<option>${item}</option>`).join('');
$('#candidateEventType').innerHTML = EVENT_TYPES.map(
  (item) => `<option value="${item}">${EVENT_LABELS[item]}</option>`,
).join('');
initProductivity({
  api,
  toast,
  refresh: loadAll,
  editJob: async (id, market) => {
    if (market !== activeMarket) await switchMarket(market);
    const job = jobs.find((job) => job.id === id);
    if (job) openJob(job);
  },
});
renderMarket();
void loadAll();
setInterval(() => void loadAll(), 60_000);
