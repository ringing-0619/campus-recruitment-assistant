import { GoalPage } from './goal-page';
import {
  EMPTY_APPLICATION,
  MARKET_LABELS,
  type Market,
  type Job,
  type ApplicationMeta,
  type JobEvent,
} from '../shared/types';
import {
  STAGE_LABELS,
  STAGE_TYPES,
  type ProductivitySettings,
  type AnalyticsResult,
  type GoalSummary,
  type GoalPoint,
  type ActionItem,
  type Reminder,
} from '../shared/productivity';
import {
  addDays,
  dateRange,
  dayInZone,
  localInZone,
  weekStart,
  weekdayIndex,
  zonedToIso,
  isDay,
} from '../shared/time';

type Api = <T>(path: string, options?: RequestInit, market?: Market) => Promise<T>;
let api: Api,
  toast: (message: string) => void,
  refresh: () => Promise<void>,
  editJob: (id: string, market: Market) => Promise<void>;
let market: Market = 'cn',
  version = 0,
  settings: ProductivitySettings,
  goals: GoalSummary,
  analytics: AnalyticsResult,
  actions: ActionItem[] = [],
  reminders: Reminder[] = [];
let goalsPage: GoalPage;
let filters = {
  from: '',
  to: '',
  groupBy: 'direction',
  direction: '',
  channel: '',
  resumeVersion: '',
};
let catalogue: Job[] = [];
let calendarMode = 'month',
  calendarDay = '',
  desktopSupported = false,
  desktopError: string | null = null;
const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector(selector) as T;
const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const pct = (value: number | null) => (value === null ? '—' : `${Math.round(value * 1000) / 10}%`);
const inputValue = (id: string) => $<HTMLInputElement>(`#${id}`)?.value || '';
const write = (path: string, body: unknown, method = 'PUT') =>
  api(path, { method, body: JSON.stringify(body) });
const nowDay = () => dayInZone(new Date(), settings?.timezone || 'America/Chicago');
const format = (value: string | null) =>
  !value
    ? '未提供时间'
    : isDay(value)
      ? `${value}（日期）`
      : `${localInZone(value, settings.timezone).replace('T', ' ')} ${settings.timezone}`;
const hours = (value: number | null) =>
  value === null
    ? '—'
    : value < 24
      ? `${Math.round(value * 10) / 10} 小时`
      : `${Math.round((value / 24) * 10) / 10} 天`;
const detailButton = (ids: string[], label: string, selectedMarket = market) =>
  `<button class="text-button" data-detail="${escape(ids.join(','))}" data-detail-market="${selectedMarket}">${label}</button>`;
const editButton = (id: string, label = '查看申请') =>
  `<button class="btn" data-product-edit="${id}">${label}</button>`;
function mountDialog(id: string, title: string, body: string) {
  const dialog = document.createElement('dialog');
  dialog.id = id;
  dialog.innerHTML = `<div class="feature-dialog"><header><h2>${title}</h2><button type="button" class="icon-button" data-feature-close>×</button></header>${body}</div>`;
  document.body.append(dialog);
}

export function initProductivity(options: {
  api: Api;
  toast: (message: string) => void;
  refresh: () => Promise<void>;
  editJob: (id: string, market: Market) => Promise<void>;
}) {
  ({ api, toast, refresh, editJob } = options);
  goalsPage = new GoalPage({ root: $('#goalsRoot'), api, toast, refresh });
  $('#applicationFields').innerHTML =
    `<fieldset class="application-fields"><legend>投递与分组信息</legend><p class="hint">按真实投递日期计数。日期未知可以留空；来源于邮件／网页不代表投递渠道。</p><div class="form-grid">
    <label>实际投递日期<input type="date" id="appliedOn"></label><label>准确时间（可选，按统计时区）<input type="datetime-local" id="appliedAt"><small class="hint" id="applicationTimezone"></small></label>
    <label>岗位方向<input id="jobDirection" list="directionOptions" maxlength="100" placeholder="如：数据分析"><datalist id="directionOptions"></datalist></label>
    <label>投递渠道<input id="jobChannel" list="channelOptions" maxlength="100" placeholder="如：官网／内推"><datalist id="channelOptions"><option>官网</option><option>内推</option><option>招聘平台</option><option>校园渠道</option><option>招聘人员</option></datalist></label>
    <label>简历版本<input id="resumeVersion" list="resumeOptions" maxlength="100" placeholder="如：数据分析-中文-v2"><datalist id="resumeOptions"></datalist></label></div>
    <div class="checkbox-row"><label><input type="checkbox" id="jobArchived">归档（保留历史统计）</label><label><input type="checkbox" id="jobExcluded">误记作废（不计入统计）</label><label><input type="checkbox" id="followupPaused">暂停长期无进展提醒</label></div></fieldset>`;
  $('#appliedAt').addEventListener('change', () => {
    if (inputValue('appliedAt'))
      $<HTMLInputElement>('#appliedOn').value = inputValue('appliedAt').slice(0, 10);
  });
  $('#appliedOn').addEventListener('change', () => {
    $<HTMLInputElement>('#appliedAt').value = '';
  });
  mountDialog('featureDetails', '申请明细', '<div id="featureDetailsBody"></div>');
  mountDialog(
    'stageDialog',
    '记录进度与安排',
    `<form id="stageForm"><input id="stageJob" type="hidden"><p class="hint" id="stageZone"></p><div class="form-grid">
    <label>阶段类型<select id="stageType">${[...STAGE_TYPES, 'offer', 'rejection', 'ended', 'other'].map((type) => `<option value="${type}">${STAGE_LABELS[type]}</option>`).join('')}</select></label><label>名称<input id="stageTitle" required maxlength="200"></label>
    <label>收到通知／发生时间<input id="stageOccurred" type="datetime-local" required></label><label>轮次（可选）<input id="stageRound" maxlength="40" placeholder="如：第一轮"></label>
    <label>开始时间<input id="stageStart" type="datetime-local"></label><label>结束／截止时间<input id="stageDue" type="datetime-local"></label>
    <label>只提供截止日期时填写<input id="stageDate" type="date"></label></div><label>简短依据<textarea id="stageEvidence" maxlength="2000" rows="2"></textarea></label>
    <p class="hint">完成任务与明确通过分别记录。没有准确开始时间时留空。</p><footer><button class="btn primary" type="submit">保存进度</button></footer></form>`,
  );
  mountDialog(
    'outcomeDialog',
    '记录阶段结果',
    `<form id="outcomeForm"><input id="outcomeEvent" type="hidden"><p id="outcomeTitle"></p><label>轮次<input id="outcomeRound" maxlength="40"></label><label>企业明确结果<select id="stageOutcome"><option value="unknown">未知／等待结果</option><option value="passed">明确通过</option><option value="failed">明确未通过</option><option value="cancelled">取消此阶段</option></select></label><p class="hint">“已完成”不会自动变为“通过”；整份申请被拒也不代表所有阶段均未通过。</p><footer><button class="btn primary" type="submit">保存结果</button></footer></form>`,
  );
  mountDialog(
    'taskDialog',
    '调整安排',
    `<form id="taskScheduleForm"><input id="scheduleTask" type="hidden"><label>事项名称<input id="scheduleTitle" required maxlength="200"></label><p class="hint" id="scheduleZone"></p><div class="form-grid"><label>开始时间<input type="datetime-local" id="scheduleStart"></label><label>结束／截止时间<input type="datetime-local" id="scheduleDue"></label><label>只有截止日期<input type="date" id="scheduleDay"></label></div><label class="checkbox-label"><input type="checkbox" id="scheduleCancelled">取消此事项</label><footer><button type="submit" class="btn primary">保存安排</button></footer></form>`,
  );
  mountDialog(
    'batchDialog',
    '批量补充分组信息',
    `<form id="batchForm"><p class="hint">选择当前模块申请，勾选要修改的字段。日期请逐条核对后在申请编辑中填写。</p><div id="batchJobs" class="batch-jobs"></div><label class="checkbox-label"><input type="checkbox" id="batchAll">全选／取消全选</label><div class="form-grid">${[
      ['direction', '岗位方向'],
      ['channel', '投递渠道'],
      ['resumeVersion', '简历版本'],
    ]
      .map(
        ([key, label]) =>
          `<label><span><input type="checkbox" data-batch-field="${key}"> ${label}</span><input id="batch-${key}" maxlength="100" placeholder="勾选后修改；空白表示清空"></label>`,
      )
      .join(
        '',
      )}</div><footer><button type="submit" class="btn primary">保存所选字段</button></footer></form>`,
  );
  document.addEventListener(
    'click',
    (event) => void handleClick(event).catch((error) => toast(error.message)),
  );
  document.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement;
    if (
      [
        'analyticsForm',
        'reminderSettingsForm',
        'stageForm',
        'outcomeForm',
        'taskScheduleForm',
        'batchForm',
      ].includes(form.id)
    ) {
      event.preventDefault();
      const button = form.querySelector<HTMLButtonElement>('[type="submit"]');
      if (button) button.disabled = true;
      void handleSubmit(form)
        .catch((error) => toast(error.message))
        .finally(() => {
          if (button) button.disabled = false;
        });
    }
  });
  document.addEventListener('keydown', (event) => {
    if (['Enter', ' '].includes(event.key)) {
      const target = (event.target as Element).closest('[data-detail][role="button"]');
      if (target) {
        event.preventDefault();
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    }
  });
  document.addEventListener('input', (event) => {
    const form = (event.target as HTMLElement).closest('form');
    if (form && ['reminderSettingsForm'].includes(form.id)) form.dataset.dirty = 'true';
  });
}

export function selectProductivityMarket(selectedMarket: Market) {
  if (selectedMarket === market) return;
  market = selectedMarket;
  ++version;
  goalsPage.select(selectedMarket);
  for (const id of ['analyticsRoot', 'actionsRoot']) $(`#${id}`).innerHTML = '';
  filters = {
    from: '',
    to: '',
    groupBy: 'direction',
    direction: '',
    channel: '',
    resumeVersion: '',
  };
}

export async function loadProductivity(selectedMarket: Market, availableJobs?: Job[]) {
  selectProductivityMarket(selectedMarket);
  if (availableJobs) {
    catalogue = availableJobs;
    for (const [id, key, defaults] of [
      ['directionOptions', 'direction', []],
      ['channelOptions', 'channel', ['官网', '内推', '招聘平台', '校园渠道', '招聘人员']],
      ['resumeOptions', 'resumeVersion', []],
    ] as const) {
      const values = new Set<string>([
        ...defaults,
        ...catalogue.map((job) => job.application?.[key] || '').filter(Boolean),
      ]);
      $(`#${id}`).innerHTML = [...values]
        .map((value) => `<option value="${escape(value)}"></option>`)
        .join('');
    }
  }
  const token = ++version,
    params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  try {
    const data = await Promise.all([
      api<{
        settings: ProductivitySettings;
        desktopSupported: boolean;
        desktopError: string | null;
      }>('/productivity/settings'),
      api<GoalSummary>('/goals'),
      api<AnalyticsResult>(`/analytics?${params}`, {}, selectedMarket),
      api<{ items: ActionItem[] }>('/actions', {}, selectedMarket),
      api<{ items: Reminder[] }>('/reminders', {}, selectedMarket),
    ]);
    if (token !== version || selectedMarket !== market) return;
    [{ settings, desktopSupported, desktopError }, goals, analytics] = data;
    actions = data[3].items;
    reminders = data[4].items;
    calendarDay ||= goals.today;
    goalsPage.render(goals, market);
    renderAnalytics();
    renderActions();
    renderSummary();
    $('#reminderBadge').textContent = String(reminders.length);
    $('#applicationTimezone').textContent = `${settings.timezone}；仅填写日期也可统计数量`;
  } catch (error) {
    if (token === version) {
      toast(`功能数据加载失败：${(error as Error).message}`);
      for (const id of ['goalsRoot', 'analyticsRoot', 'actionsRoot'])
        if (!$(`#${id}`).children.length)
          $(`#${id}`).innerHTML = '<div class="empty">数据暂未加载，请刷新重试。</div>';
    }
  }
}

export function productivityTimezone() {
  return settings?.timezone || 'America/Chicago';
}
export function populateApplication(job?: Job) {
  const meta = { ...EMPTY_APPLICATION, ...job?.application };
  $<HTMLInputElement>('#appliedOn').value = meta.appliedAt
    ? dayInZone(meta.appliedAt, settings?.timezone)
    : meta.appliedOn || (!job ? nowDay() : '');
  $<HTMLInputElement>('#appliedAt').value = meta.appliedAt
    ? localInZone(meta.appliedAt, settings?.timezone)
    : '';
  for (const [id, key] of [
    ['jobDirection', 'direction'],
    ['jobChannel', 'channel'],
    ['resumeVersion', 'resumeVersion'],
  ] as const)
    $<HTMLInputElement>(`#${id}`).value = meta[key];
  for (const [id, key] of [
    ['jobArchived', 'archived'],
    ['jobExcluded', 'excluded'],
    ['followupPaused', 'followupPaused'],
  ] as const)
    $<HTMLInputElement>(`#${id}`).checked = meta[key];
  $<HTMLFormElement>('#jobForm').dataset.loadedStatus = job?.status || '已投递';
  renderStageHistory(job);
}
function renderStageHistory(job?: Job) {
  $('#stageHistory').innerHTML = job
    ? `<div class="section-head"><h3>阶段历史</h3><button class="btn" type="button" data-add-stage="${job.id}">＋ 记录进度／待办</button></div>${job.events
        .filter((event) => (STAGE_TYPES as readonly string[]).includes(event.type))
        .slice(0, 15)
        .map(
          (event) =>
            `<div class="history-row"><div><strong>${escape(event.title)}</strong><small>${escape(event.round || '轮次未填写')} · ${escape(({ passed: '明确通过', failed: '明确未通过', cancelled: '已取消', unknown: '结果未知' } as Record<string, string>)[event.outcome || 'unknown'])}${event.completedAt ? ' · 已完成' : ''}</small></div><button class="btn" type="button" data-outcome="${event.id}" data-outcome-job="${job.id}">记录结果</button></div>`,
        )
        .join('')}`
    : '';
}
export function readApplicationForm(): ApplicationMeta {
  const local = inputValue('appliedAt'),
    appliedAt = local ? zonedToIso(local, settings?.timezone) : null;
  if (local && !appliedAt) throw new Error('该准确时间在当前时区无效，请检查夏令时切换');
  const appliedOn = inputValue('appliedOn') || null;
  if ((appliedOn && appliedOn > nowDay()) || (appliedAt && Date.parse(appliedAt) > Date.now()))
    throw new Error('实际投递日期不能在未来');
  return {
    ...EMPTY_APPLICATION,
    appliedOn: appliedAt ? null : appliedOn,
    appliedAt,
    dateSource: 'manual',
    direction: inputValue('jobDirection').trim(),
    channel: inputValue('jobChannel').trim(),
    resumeVersion: inputValue('resumeVersion').trim(),
    archived: $<HTMLInputElement>('#jobArchived').checked,
    excluded: $<HTMLInputElement>('#jobExcluded').checked,
    followupPaused: $<HTMLInputElement>('#followupPaused').checked,
  };
}
function renderSummary() {
  const module = goals.modules.find((item) => item.market === market)!;
  $('#productivitySummary').innerHTML =
    `<button class="summary-link" data-go-page="goals">今日投递 <strong>${module.day.actual}${module.day.target !== null ? ` / ${module.day.target}` : ''}</strong> · ${module.day.remaining === null ? '未设目标' : module.day.target === 0 ? '休息日' : module.day.remaining ? `还差 ${module.day.remaining} 份` : '✓ 已达标'}</button><button class="summary-link" data-go-page="actions">${reminders.length} 项提醒 · ${actions.filter((item) => !item.completedAt && !item.cancelledAt && !item.resolvedAt && item.date === goals.today).length} 项今日安排 →</button>`;
}
function renderAnalytics() {
  if (!$('#analyticsRoot').children.length)
    $('#analyticsRoot').innerHTML =
      `<div class="page-heading"><h2>招聘漏斗与分组对比</h2><p>先按实际投递日期选择申请，再观察这些申请截至今天的结果。</p></div><form id="analyticsForm" class="analytics-filters panel"><label>投递起始日<input id="analyticsFrom" type="date"></label><label>投递截止日<input id="analyticsTo" type="date"></label><label>对比维度<select id="analyticsGroup"><option value="direction">岗位方向</option><option value="channel">投递渠道</option><option value="resumeVersion">简历版本</option></select></label><label>限定岗位方向<input id="analyticsDirection" list="directionOptions" placeholder="全部方向"></label><label>限定投递渠道<input id="analyticsChannel" list="channelOptions" placeholder="全部渠道"></label><label>限定简历版本<input id="analyticsResume" list="resumeOptions" placeholder="全部版本"></label><button class="btn primary" type="submit">应用筛选</button><button class="btn" type="button" data-reset-analytics>全部时间</button><button class="btn" type="button" data-batch-open>批量补全标签</button></form><div id="analyticsContent"></div>`;
  if (!$('#analyticsForm').contains(document.activeElement)) {
    for (const [id, key] of [
      ['analyticsFrom', 'from'],
      ['analyticsTo', 'to'],
      ['analyticsGroup', 'groupBy'],
      ['analyticsDirection', 'direction'],
      ['analyticsChannel', 'channel'],
      ['analyticsResume', 'resumeVersion'],
    ] as const)
      $<HTMLInputElement>(`#${id}`).value = filters[key];
  }
  const feedback = analytics.metrics.find((item) => item.key === 'feedback')!,
    interview = analytics.metrics.find((item) => item.key === 'interview')!,
    offer = analytics.metrics.find((item) => item.key === 'offer')!;
  $('#analyticsContent').innerHTML =
    `<p class="hint">${analytics.from || '全部已知及日期未知的历史申请'} → ${analytics.to} · 统计时点 ${format(analytics.asOf)} · ${MARKET_LABELS[market]}</p><div class="analytics-cards"><article class="panel"><span>投递申请数</span><strong>${detailButton(analytics.cohortIds, String(analytics.cohortIds.length))}</strong></article>${[feedback, interview, offer].map((item) => `<article class="panel"><span>${item.label}</span><strong>${detailButton(item.jobIds, pct(item.rate))}</strong><small>${item.numerator} / ${item.denominator} 份申请</small></article>`).join('')}</div>
    ${analytics.missingDateIds.length ? `<div class="notice">${detailButton(analytics.missingDateIds, `${analytics.missingDateIds.length} 条申请日期未知`)}。全部时间视图保留这些真实申请；按日期筛选时排除，耗时指标不使用估算时间。</div>` : ''}
    <div class="feature-columns"><section class="panel"><h3>各阶段到达率</h3><p class="hint">各阶段可跳过或并行；每个阶段按申请去重。收件确认不算后续反馈。</p><div class="funnel-list">${analytics.metrics.map((item) => `<div class="funnel-row"><div><span>${item.label}</span>${detailButton(item.jobIds, `${item.numerator} / ${item.denominator} · ${pct(item.rate)}`)}</div><div class="progress-track"><i style="width:${(item.rate || 0) * 100}%"></i></div></div>`).join('')}</div></section>
    <section class="panel"><h3>等待与反馈速度</h3><div class="time-metric"><span>投递 → 首次有效反馈</span><strong>${hours(analytics.medians.feedbackHours)}</strong><small>${analytics.medians.feedbackSample} 份有准确时间的已反馈申请</small></div><div class="time-metric"><span>完成阶段 → 后续进展</span><strong>${hours(analytics.medians.stageWaitHours)}</strong><small>${analytics.medians.stageWaitSample} 个有后续进展的阶段</small></div><div class="time-metric"><span>投递 → 首次 Offer</span><strong>${hours(analytics.medians.offerHours)}</strong><small>${analytics.medians.offerSample} 份有准确时间的 Offer 申请</small></div><p class="hint">均为中位数；当前无有效反馈 ${analytics.medians.waiting} 份，缺少准确投递时刻 ${analytics.medians.dateOnly} 份。未反馈申请不视为失败，也未计入已反馈耗时。</p></section></div>
    <section class="panel"><h3>阶段完成与明确结果</h3><p class="hint">这里按阶段次数统计。同一申请多轮分别计数；通过率只在明确通过／未通过的阶段中计算。缺少轮次与安排时间的同类通知合并，补充轮次后可分别统计。</p><div class="table-scroll"><table class="feature-table"><thead><tr><th>阶段／轮次</th><th>到达次数</th><th>完成率</th><th>明确通过</th><th>明确未通过</th><th>通过率</th><th>结果覆盖率</th><th>结果未知</th></tr></thead><tbody>${analytics.stages.map((stage) => `<tr><td>${detailButton(stage.jobIds, `${STAGE_LABELS[stage.type]} · ${escape(stage.round || '轮次未知')}`)}</td><td>${stage.reached}</td><td>${stage.completed}/${stage.reached} · ${pct(stage.completionRate)}</td><td>${stage.passed}</td><td>${stage.failed}</td><td>${pct(stage.passRate)}</td><td>${pct(stage.coverage)}</td><td>${stage.unknown}</td></tr>`).join('') || '<tr><td colspan="8">当前申请组暂无阶段记录</td></tr>'}</tbody></table></div></section>
    <section class="panel"><h3>按${({ direction: '岗位方向', channel: '投递渠道', resumeVersion: '简历版本' } as Record<string, string>)[filters.groupBy]}对比</h3><p class="hint">可限定相同市场、方向和投递区间后比较。少于 10 份标注样本较少，不据此推断因果或自动排名。</p><div class="table-scroll"><table class="feature-table"><thead><tr><th>分组</th><th>投递数</th><th>有效反馈</th><th>真人面试</th><th>Offer</th><th>反馈中位耗时</th><th>样本说明</th></tr></thead><tbody>${analytics.groups.map((group) => `<tr><td>${escape(group.name)}</td><td>${group.count}</td>${[group.feedback, group.interview, group.offer].map((item) => `<td>${detailButton(item.jobIds, `${item.numerator}/${item.denominator} · ${pct(item.rate)}`)}</td>`).join('')}<td>${hours(group.feedbackHours)}</td><td>${group.sampleSmall ? '样本较少' : '观察性数据'}</td></tr>`).join('') || '<tr><td colspan="7">暂无符合筛选条件的申请</td></tr>'}</tbody></table></div></section>`;
}
function actionCard(action: ActionItem) {
  return `<article class="action-card ${action.overdue ? 'overdue' : ''}"><div><span class="action-type">${STAGE_LABELS[action.type]}${action.conflict ? ' · ⚠ 时间冲突' : ''}${action.overdue ? ' · 已逾期' : ''}</span><h4>${escape(action.company)} · ${escape(action.title)}</h4><p>${escape(action.position)}</p><small>${action.startsAt ? `开始 ${format(action.startsAt)}` : ''}${action.dueAt ? ` · 截止 ${format(action.dueAt)}` : ''}${!action.startsAt && !action.dueAt ? '未提供安排时间，请补充' : ''}</small></div><div class="action-buttons">${editButton(action.jobId)}<button class="btn" data-schedule="${action.id}">调整安排</button><button class="btn primary" data-product-complete="${action.id}">✓ 完成</button></div></article>`;
}
function renderActions() {
  if (!$('#actionsRoot').children.length)
    $('#actionsRoot').innerHTML =
      `<div class="page-heading"><h2>今日行动与日历</h2><p>把需要完成的安排与等待企业回复的跟进分开处理。</p></div><div id="todayActions"></div><section class="panel"><div class="section-head"><h3>日历</h3><div class="form-actions"><button class="btn" data-calendar-prev>←</button><input type="date" id="calendarDate"><button class="btn" data-calendar-next>→</button><select id="calendarMode"><option value="month">月视图</option><option value="week">周视图</option></select><button class="btn" data-calendar-go>查看</button><button class="btn" data-export-calendar>导出 .ics</button></div></div><p class="hint" id="calendarCaption"></p><div id="calendarGrid"></div><p class="hint">日期事项显示为全天。缺少时长的面试只检测同一开始时刻；导出为快照，已导入日历不会自动跟随更新。</p></section><section class="panel"><h3>长期无进展与待办提醒</h3><div id="reminderList"></div></section><section class="panel" id="reminderConfig"></section>`;
  const active = actions.filter(
      (item) => !item.completedAt && !item.cancelledAt && !item.resolvedAt,
    ),
    today = active.filter(
      (item) =>
        item.overdue ||
        item.date === goals.today ||
        Boolean(item.dueAt && dayInZone(item.dueAt, settings.timezone) === goals.today),
    ),
    upcoming = active.filter(
      (item) =>
        !item.overdue &&
        !today.some((today) => today.id === item.id) &&
        [item.startsAt, item.dueAt].some(
          (time) =>
            time &&
            dayInZone(time, settings.timezone) > goals.today &&
            dayInZone(time, settings.timezone) <= addDays(goals.today, 7),
        ),
    ),
    missing = active.filter((item) => !item.date);
  const module = goals.modules.find((item) => item.market === market)!;
  $('#todayActions').innerHTML =
    `<div class="total-strip"><strong>${goals.today} · ${settings.timezone}</strong><span>今日已投 ${module.day.actual} 份${module.day.remaining !== null ? `，剩余 ${module.day.remaining} 份` : '，尚未设置目标'}</span><button class="text-button" data-go-page="goals">查看目标 →</button></div><div class="feature-columns"><section class="panel"><h3>今天与逾期 · ${today.length}</h3>${today.map(actionCard).join('') || '<p class="hint">今天没有待完成的已知安排。</p>'}</section><section class="panel"><h3>未来 7 天 · ${upcoming.length}</h3>${upcoming.map(actionCard).join('') || '<p class="hint">未来 7 天暂无已知安排。</p>'}</section></div>${missing.length ? `<section class="panel"><h3>待补充时间 · ${missing.length}</h3>${missing.map(actionCard).join('')}</section>` : ''}`;
  $<HTMLInputElement>('#calendarDate').value = calendarDay;
  $<HTMLSelectElement>('#calendarMode').value = calendarMode;
  renderCalendar();
  $('#reminderList').innerHTML = reminders.length
    ? reminders
        .map(
          (item) =>
            `<article class="reminder-card"><div><span class="action-type">${item.kind === 'stale' ? '跟进提醒' : '时间提醒'}</span><h4>${escape(item.company)} · ${escape(item.position)}</h4><strong>${escape(item.title)}</strong><p>${escape(item.reason)}</p></div><div class="action-buttons">${editButton(item.jobId)}${item.kind === 'stale' ? `<button class="btn" data-reminder-action="followed_up" data-reminder-key="${escape(item.key)}">已跟进，7 天后提醒</button><button class="btn" data-pause-job="${item.jobId}">暂停跟进提醒</button>` : ''}<button class="btn" data-reminder-action="snooze" data-reminder-key="${escape(item.key)}">3 天后提醒</button><button class="btn" data-reminder-action="dismiss" data-reminder-key="${escape(item.key)}">忽略本次</button></div></article>`,
        )
        .join('')
    : '<p class="hint">暂无需要处理的提醒。新进展到来后，旧提醒会自动消失。</p>';
  if ($('#reminderSettingsForm')?.getAttribute('data-dirty') !== 'true')
    $('#reminderConfig').innerHTML =
      `<h3>统计时区与提醒设置</h3><p class="hint">电脑在线时计算。恢复后合并补发仍有效事项；新进展、完成和取消会使旧提醒失效。</p><form id="reminderSettingsForm"><div class="form-grid"><label>统计／日历时区<input id="statsTimezone" value="${escape(settings.timezone)}" list="timezoneOptions" required><datalist id="timezoneOptions"><option>America/Chicago</option><option>America/New_York</option><option>America/Los_Angeles</option><option>Asia/Shanghai</option></datalist></label><label>投递后无反馈（天）<input id="staleApplication" type="number" min="1" max="365" value="${settings.staleDays.application}" required></label><label>完成测评／笔试后无进展（天）<input id="staleAssessment" type="number" min="1" max="365" value="${settings.staleDays.assessment}" required></label><label>完成面试后无进展（天）<input id="staleInterview" type="number" min="1" max="365" value="${settings.staleDays.interview}" required></label><label>免打扰开始（0–23 点）<input id="quietStart" type="number" min="0" max="23" value="${settings.quietStart}" required></label><label>免打扰结束（0–23 点）<input id="quietEnd" type="number" min="0" max="23" value="${settings.quietEnd}" required></label></div><label class="checkbox-label"><input id="desktopEnabled" type="checkbox" ${settings.desktopEnabled ? 'checked' : ''} ${desktopSupported ? '' : 'disabled'}>启用 Mac 系统通知</label><div class="form-actions"><button class="btn primary" type="submit">保存设置</button><button class="btn" type="button" data-test-notification ${desktopSupported ? '' : 'disabled'}>发送电脑测试通知</button></div></form><p class="hint">助手内提醒默认可用。开启电脑通知后可关闭网页，由本地后台服务发送；系统权限和专注模式会影响显示。准确时间按统计时区填写；修改时区会重算准确时间记录的日／周归属。免打扰开始与结束相同时关闭免打扰。</p>${desktopError ? `<p class="notice">上次系统通知提交失败：${escape(desktopError)}</p>` : ''}`;
}
function renderCalendar() {
  let from: string, to: string;
  if (calendarMode === 'week') {
    from = weekStart(calendarDay);
    to = addDays(from, 6);
  } else {
    const first = calendarDay.slice(0, 7) + '-01';
    from = weekStart(first);
    const date = new Date(`${first}T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + 1);
    date.setUTCDate(0);
    to = addDays(weekStart(date.toISOString().slice(0, 10)), 6);
  }
  $('#calendarCaption').textContent =
    `${calendarMode === 'month' ? calendarDay.slice(0, 7) : `${from} — ${to}`} · ${settings.timezone} · 紫色为有安排，勾号为已完成`;
  $('#calendarGrid').innerHTML =
    `<div class="calendar-grid">${['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((day) => `<div class="calendar-weekday">${day}</div>`).join('')}${dateRange(
      from,
      to,
    )
      .map((day) => {
        const items = actions.filter(
          (item) =>
            !item.cancelledAt &&
            (item.date === day || (item.dueAt && dayInZone(item.dueAt, settings.timezone) === day)),
        );
        return `<div class="calendar-cell ${day === goals.today ? 'today' : ''} ${day.slice(0, 7) !== calendarDay.slice(0, 7) && calendarMode === 'month' ? 'muted' : ''}"><time>${day.slice(8)}</time>${items.map((item) => `<button class="calendar-event ${item.completedAt ? 'done' : ''}" data-product-edit="${item.jobId}" title="${escape(item.position)} · ${escape(format(item.startsAt || item.dueAt))}">${item.completedAt ? '✓ ' : ''}${escape(item.company)}<small>${escape(item.title)}${item.conflict ? ' ⚠' : ''}</small></button>`).join('')}</div>`;
      })
      .join('')}</div>`;
}

async function showDetails(ids: string[], selectedMarket: Market) {
  const list = await api<Job[]>('/jobs', {}, selectedMarket),
    selected = list.filter((job) => ids.includes(job.id));
  $('#featureDetailsBody').innerHTML =
    `<p class="hint">${MARKET_LABELS[selectedMarket]} · ${selected.length} 份申请</p>${selected.map((job) => `<div class="detail-row"><div><strong>${escape(job.company)} · ${escape(job.position)}</strong><small>${escape(job.application?.appliedAt ? format(job.application.appliedAt) : job.application?.appliedOn || '投递日期未知')} · ${escape(job.status)}</small></div><button class="btn" data-product-edit="${job.id}" data-edit-market="${selectedMarket}">编辑申请</button></div>`).join('') || '<p class="hint">暂无对应申请。</p>'}`;
  $<HTMLDialogElement>('#featureDetails').showModal();
}
async function handleClick(event: MouseEvent) {
  const target = event.target as Element;
  if (!target.closest) return;
  const close = target.closest('[data-feature-close]');
  if (close) {
    close.closest('dialog')?.close();
    return;
  }
  const go = target.closest<HTMLElement>('[data-go-page]');
  if (go) {
    $<HTMLButtonElement>(`[data-page="${go.dataset.goPage}"]`).click();
    return;
  }
  const detail = target.closest<HTMLElement>('[data-detail]');
  if (detail) {
    await showDetails(
      (detail.dataset.detail || '').split(',').filter(Boolean),
      (detail.dataset.detailMarket || market) as Market,
    );
    return;
  }
  const edit = target.closest<HTMLElement>('[data-product-edit]');
  if (edit) {
    $<HTMLDialogElement>('#featureDetails').close();
    await editJob(edit.dataset.productEdit!, (edit.dataset.editMarket || market) as Market);
    return;
  }
  const complete = target.closest<HTMLElement>('[data-product-complete]');
  if (complete) {
    await write(`/tasks/${complete.dataset.productComplete}/complete`, {}, 'POST');
    toast('已记录完成，招聘结果仍需明确证据');
    await refresh();
    return;
  }
  const addStage = target.closest<HTMLElement>('[data-add-stage]');
  if (addStage) {
    $<HTMLFormElement>('#stageForm').reset();
    $<HTMLInputElement>('#stageJob').value = addStage.dataset.addStage!;
    $<HTMLInputElement>('#stageOccurred').value = localInZone(
      new Date().toISOString(),
      settings.timezone,
    );
    $('#stageZone').textContent = `以下准确时间均按 ${settings.timezone} 填写`;
    $<HTMLDialogElement>('#stageDialog').showModal();
    return;
  }
  const outcome = target.closest<HTMLElement>('[data-outcome]');
  if (outcome) {
    const job = (await api<Job[]>('/jobs')).find((job) => job.id === outcome.dataset.outcomeJob)!,
      item = job.events.find((item) => item.id === outcome.dataset.outcome)!;
    $<HTMLInputElement>('#outcomeEvent').value = item.id;
    $<HTMLInputElement>('#outcomeRound').value = item.round || '';
    $<HTMLSelectElement>('#stageOutcome').value = item.outcome || 'unknown';
    $('#outcomeTitle').textContent = `${job.company} · ${item.title}`;
    $<HTMLDialogElement>('#outcomeDialog').showModal();
    return;
  }
  const schedule = target.closest<HTMLElement>('[data-schedule]');
  if (schedule) {
    const item = actions.find((item) => item.id === schedule.dataset.schedule)!;
    $<HTMLInputElement>('#scheduleTask').value = item.id;
    $<HTMLInputElement>('#scheduleTitle').value = item.title;
    $<HTMLInputElement>('#scheduleStart').value =
      item.startsAt && !isDay(item.startsAt) ? localInZone(item.startsAt, settings.timezone) : '';
    $<HTMLInputElement>('#scheduleDue').value =
      item.dueAt && !isDay(item.dueAt) ? localInZone(item.dueAt, settings.timezone) : '';
    $<HTMLInputElement>('#scheduleDay').value = item.dueAt && isDay(item.dueAt) ? item.dueAt : '';
    $<HTMLInputElement>('#scheduleCancelled').checked = Boolean(item.cancelledAt);
    $('#scheduleZone').textContent = `时间按 ${settings.timezone} 填写`;
    $<HTMLDialogElement>('#taskDialog').showModal();
    return;
  }
  const action = target.closest<HTMLElement>('[data-reminder-action]');
  if (action) {
    await write(
      '/reminders/action',
      {
        key: action.dataset.reminderKey,
        action: action.dataset.reminderAction,
        days: action.dataset.reminderAction === 'followed_up' ? 7 : 3,
      },
      'POST',
    );
    toast('提醒已处理');
    await refresh();
    return;
  }
  const pause = target.closest<HTMLElement>('[data-pause-job]');
  if (pause) {
    await write('/applications/batch', {
      ids: [pause.dataset.pauseJob],
      application: { followupPaused: true },
    });
    toast('已暂停，可在申请编辑中恢复');
    await refresh();
    return;
  }
  if (target.closest('[data-test-notification]')) {
    const response = await api<{ message: string }>('/reminders/test-desktop', { method: 'POST' });
    toast(response.message);
    return;
  }
  if (target.closest('[data-calendar-go]')) {
    calendarDay = inputValue('calendarDate') || nowDay();
    calendarMode = inputValue('calendarMode');
    renderCalendar();
    return;
  }
  if (target.closest('[data-calendar-prev],[data-calendar-next]')) {
    const step = target.closest('[data-calendar-prev]') ? -1 : 1;
    if (calendarMode === 'week') calendarDay = addDays(calendarDay, 7 * step);
    else {
      const date = new Date(`${calendarDay.slice(0, 7)}-01T12:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() + step);
      calendarDay = date.toISOString().slice(0, 10);
    }
    $<HTMLInputElement>('#calendarDate').value = calendarDay;
    renderCalendar();
    return;
  }
  if (target.closest('[data-export-calendar]')) {
    const link = document.createElement('a');
    link.href = `/api/v1/calendar.ics?market=${market}`;
    link.download = '校招安排.ics';
    link.click();
    return;
  }
  if (target.closest('[data-reset-analytics]')) {
    filters = {
      from: '',
      to: '',
      groupBy: 'direction',
      direction: '',
      channel: '',
      resumeVersion: '',
    };
    await loadProductivity(market);
    return;
  }
  if (target.closest('[data-batch-open]')) {
    const jobs = await api<Job[]>('/jobs');
    $('#batchJobs').innerHTML = jobs
      .map(
        (job) =>
          `<label class="checkbox-label"><input type="checkbox" name="batchJob" value="${job.id}">${escape(job.company)} · ${escape(job.position)}<small>${escape(job.application?.direction || '方向未填')} / ${escape(job.application?.channel || '渠道未填')} / ${escape(job.application?.resumeVersion || '简历未填')}</small></label>`,
      )
      .join('');
    $<HTMLFormElement>('#batchForm').reset();
    $<HTMLDialogElement>('#batchDialog').showModal();
    return;
  }
  if (target.closest('#batchAll'))
    document
      .querySelectorAll<HTMLInputElement>('[name="batchJob"]')
      .forEach((input) => (input.checked = $<HTMLInputElement>('#batchAll').checked));
}
function numberOrNull(value: string) {
  return value === '' ? null : Number(value);
}
async function handleSubmit(form: HTMLFormElement) {
  if (form.id === 'analyticsForm') {
    filters = {
      from: inputValue('analyticsFrom'),
      to: inputValue('analyticsTo'),
      groupBy: inputValue('analyticsGroup'),
      direction: inputValue('analyticsDirection').trim(),
      channel: inputValue('analyticsChannel').trim(),
      resumeVersion: inputValue('analyticsResume').trim(),
    };
    await loadProductivity(market);
    return;
  } else if (form.id === 'reminderSettingsForm') {
    await write('/productivity/settings', {
      timezone: inputValue('statsTimezone').trim(),
      staleDays: {
        application: Number(inputValue('staleApplication')),
        assessment: Number(inputValue('staleAssessment')),
        interview: Number(inputValue('staleInterview')),
      },
      desktopEnabled: $<HTMLInputElement>('#desktopEnabled').checked,
      quietStart: Number(inputValue('quietStart')),
      quietEnd: Number(inputValue('quietEnd')),
    });
  } else if (form.id === 'stageForm') {
    const convert = (id: string) => {
      const value = inputValue(id),
        iso = value ? zonedToIso(value, settings.timezone) : null;
      if (value && !iso) throw new Error('时间无效，请检查时区和夏令时');
      return iso;
    };
    await write(
      `/jobs/${inputValue('stageJob')}/events`,
      {
        type: inputValue('stageType'),
        title: inputValue('stageTitle'),
        round: inputValue('stageRound'),
        occurredAt: convert('stageOccurred'),
        startsAt: convert('stageStart'),
        dueAt: convert('stageDue') || inputValue('stageDate') || null,
        evidence: inputValue('stageEvidence'),
      },
      'POST',
    );
    $<HTMLDialogElement>('#stageDialog').close();
  } else if (form.id === 'outcomeForm') {
    await write(`/events/${inputValue('outcomeEvent')}`, {
      round: inputValue('outcomeRound'),
      outcome: inputValue('stageOutcome'),
    });
    $<HTMLDialogElement>('#outcomeDialog').close();
  } else if (form.id === 'taskScheduleForm') {
    const convert = (id: string) => {
      const value = inputValue(id),
        iso = value ? zonedToIso(value, settings.timezone) : null;
      if (value && !iso) throw new Error('时间无效，请检查时区和夏令时');
      return iso;
    };
    await write(`/tasks/${inputValue('scheduleTask')}`, {
      title: inputValue('scheduleTitle'),
      startsAt: convert('scheduleStart'),
      dueAt: convert('scheduleDue') || inputValue('scheduleDay') || null,
      cancelledAt: $<HTMLInputElement>('#scheduleCancelled').checked
        ? new Date().toISOString()
        : null,
    });
    $<HTMLDialogElement>('#taskDialog').close();
  } else if (form.id === 'batchForm') {
    const ids = [...form.querySelectorAll<HTMLInputElement>('[name="batchJob"]:checked')].map(
        (input) => input.value,
      ),
      application: Record<string, string> = {};
    form.querySelectorAll<HTMLInputElement>('[data-batch-field]:checked').forEach((input) => {
      application[input.dataset.batchField!] = inputValue(
        `batch-${input.dataset.batchField}`,
      ).trim();
    });
    if (!ids.length || !Object.keys(application).length)
      throw new Error('请选择申请，并勾选至少一个要修改的字段');
    await write('/applications/batch', { ids, application });
    $<HTMLDialogElement>('#batchDialog').close();
  }
  form.dataset.dirty = 'false';
  toast('已保存');
  await refresh();
  const editingId = inputValue('jobId');
  if (
    $<HTMLDialogElement>('#jobDialog').open &&
    editingId &&
    ['stageForm', 'outcomeForm'].includes(form.id)
  ) {
    const job = await api<Job>(`/jobs/${editingId}`);
    renderStageHistory(job);
    const field = $<HTMLSelectElement>('#jobStatus'),
      parent = $<HTMLFormElement>('#jobForm');
    if (field.value === parent.dataset.loadedStatus) field.value = job.status;
    parent.dataset.loadedStatus = job.status;
  }
}
