import './goals.css';
import { MARKET_LABELS, type Market } from '../shared/types';
import type { GoalSummary, GoalModule, GoalPoint, GoalRules } from '../shared/productivity';
import { addDays, dayInZone } from '../shared/time';
import { GoalDraftBook } from './goal-drafts';

type Api = <T>(path: string, options?: RequestInit, market?: Market) => Promise<T>;
type Trend = 'daily' | 'cumulative' | 'weekly';
interface Options {
  root: HTMLElement;
  api: Api;
  toast: (message: string) => void;
  refresh: () => Promise<void>;
}
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const ratio = (actual: number, target: number | null) =>
  target ? `${Math.round((actual / target) * 1000) / 10}%` : '—';
const detail = (ids: string[], label: string, market: Market) =>
  `<button type="button" class="text-button" data-detail="${esc(ids.join(','))}" data-detail-market="${market}">${label}</button>`;
const labels: Record<Trend, string> = {
  daily: '每日投递',
  cumulative: '本周累计',
  weekly: '每周投递',
};

export class GoalPage {
  private market: Market = 'cn';
  private summary: GoalSummary | null = null;
  private trend: Trend = 'daily';
  private drafts = new GoalDraftBook();
  private dialog: HTMLDialogElement;
  private moreDrafts = new Map<Market, Record<string, string>>();
  private moreSaving = new Set<Market>();
  constructor(private options: Options) {
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'goalSettingsDialog';
    document.body.append(this.dialog);
    options.root.addEventListener('input', (event) => {
      const input = event.target as HTMLInputElement,
        field = input.dataset.goalField as 'day' | 'week' | undefined;
      if (field && this.summary) {
        this.drafts.edit(this.market, field, input.value, this.summary);
        this.updateEditor();
      }
    });
    options.root.addEventListener('click', (event) => {
      const target = event.target as Element;
      const trend = target.closest<HTMLElement>('[data-goal-trend]');
      if (trend) {
        this.trend = trend.dataset.goalTrend as Trend;
        this.renderChart();
      }
      if (target.closest('[data-goal-more]')) this.openMore();
      if (target.closest('[data-goal-reset]') && this.summary) {
        this.drafts.reset(this.market, this.summary);
        this.updateEditor();
      }
    });
    options.root.addEventListener('submit', (event) => {
      if ((event.target as HTMLFormElement).id !== 'currentGoalTargetsForm') return;
      event.preventDefault();
      void this.save();
    });
    this.dialog.addEventListener('input', (event) => {
      const input = event.target as HTMLInputElement;
      if (input.name)
        this.moreDrafts.get(this.dialog.dataset.market as Market)![input.name] = input.value;
    });
    this.dialog.addEventListener('change', (event) => {
      const input = event.target as HTMLSelectElement;
      if (input.name)
        this.moreDrafts.get(this.dialog.dataset.market as Market)![input.name] = input.value;
    });
    this.dialog.addEventListener('click', (event) => {
      if ((event.target as Element).closest('[data-goal-dialog-close]')) this.dialog.close();
    });
    this.dialog.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.saveMore(event.target as HTMLFormElement);
    });
  }
  select(market: Market) {
    if (market === this.market) return;
    this.market = market;
    this.dialog.close();
    if (this.summary) this.render(this.summary, market);
    else
      this.options.root.innerHTML = `<div class="empty" role="status">正在加载${MARKET_LABELS[market]}目标…</div>`;
  }
  render(summary: GoalSummary, market: Market) {
    this.summary = summary;
    this.market = market;
    const root = this.options.root;
    if (root.dataset.goalMarket !== market || !root.querySelector('#currentGoalTargetsForm')) {
      root.dataset.goalMarket = market;
      root.innerHTML = `<div class="page-heading goal-heading"><div><h2>${MARKET_LABELS[market]} · 投递目标</h2><p>设定今日与本周目标，跟踪每一次真实投递。</p></div><span class="goal-module-label">${MARKET_LABELS[market]}</span></div>
      <div class="goals-workspace"><aside class="panel goal-editor" aria-labelledby="goalEditorTitle"><div class="goal-editor-kicker">APPLICATION GOALS</div><h3 id="goalEditorTitle">${MARKET_LABELS[market]} · 设置目标</h3><p class="hint" id="goalEditorPeriod"></p>
      <form id="currentGoalTargetsForm" data-market="${market}"><label for="currentDayTarget">今日目标<span class="goal-input-unit"><input id="currentDayTarget" data-goal-field="day" type="number" min="0" max="10000" step="1" placeholder="未设置"><span>份</span></span></label><label for="currentWeekTarget">本周目标<span class="goal-input-unit"><input id="currentWeekTarget" data-goal-field="week" type="number" min="0" max="10000" step="1" placeholder="未设置"><span>份</span></span></label><p class="hint">留空表示未设置，0 表示休息。</p><p id="goalSaveMessage" class="goal-save-message" role="status" aria-live="polite"></p><button class="btn primary goal-save" type="submit">保存目标</button><button class="text-button goal-reset" type="button" data-goal-reset hidden>恢复当前生效目标</button></form>
      <button type="button" class="btn goal-more" data-goal-more>更多目标设置 ↗</button><p class="hint goal-more-hint">设置每周默认计划或调整历史目标</p></aside>
      <div class="goals-content"><div class="goal-progress-grid" id="goalCards"></div><p class="hint" id="goalTimezone"></p><section class="panel goal-trends"><div class="section-head"><h3>${MARKET_LABELS[market]} · 投递趋势</h3></div><div class="goal-trend-tabs" role="group" aria-label="趋势类型">${(Object.keys(labels) as Trend[]).map((type) => `<button type="button" data-goal-trend="${type}" aria-pressed="${type === this.trend}">${labels[type]}</button>`).join('')}</div><div id="goalChartContent"></div></section><div id="goalMissing"></div><p class="hint" id="goalAdherence"></p></div></div>`;
    }
    const module = this.module();
    root.querySelector('#goalCards')!.innerHTML =
      this.card('今日', module.day) + this.card('本周', module.week);
    root.querySelector('#goalTimezone')!.textContent =
      `统计时区 ${summary.timezone} · 今日 ${summary.today} · 本周 ${summary.weekStart} — ${addDays(summary.weekStart, 6)}`;
    root.querySelector('#goalMissing')!.innerHTML = module.missingDateIds.length
      ? `<div class="notice">${detail(module.missingDateIds, `${module.missingDateIds.length} 条申请缺少实际投递日期`, market)}，暂未计入趋势。补全后会计入真实投递日期。</div>`
      : '';
    root.querySelector('#goalAdherence')!.textContent =
      `近 28 天已结束的目标日：达标 ${module.dailyAdherence.achieved} / ${module.dailyAdherence.total} 天。${module.neededPerDay !== null ? `本周剩余计划日平均需投 ${module.neededPerDay} 份。` : '本周剩余计划日尚未设置正目标。'}`;
    this.renderChart();
    this.updateEditor();
  }
  private module(): GoalModule {
    return this.summary!.modules.find((module) => module.market === this.market)!;
  }
  private card(label: string, point: GoalPoint) {
    const achieved = Boolean(point.target && point.remaining === 0),
      state =
        point.target === null
          ? '未设目标'
          : point.target === 0
            ? '休息日'
            : achieved
              ? '✓ 已达标'
              : `还差 ${point.remaining} 份`;
    return `<article class="goal-card ${achieved ? 'achieved' : ''}"><div class="section-head"><h3>${label}投递</h3><span class="goal-state">${state}</span></div><div class="goal-number">${detail(point.jobIds, String(point.actual), this.market)}<span> / ${point.target ?? '—'} 份</span></div><div class="progress-track"><i style="width:${point.target ? Math.min((point.actual / point.target) * 100, 100) : 0}%"></i></div><div class="goal-foot"><span>完成 ${ratio(point.actual, point.target)}</span><span>${point.target !== null && point.actual > point.target ? `超额 ${point.actual - point.target} 份` : ''}</span></div></article>`;
  }
  private updateEditor() {
    if (!this.summary) return;
    const root = this.options.root,
      form = root.querySelector<HTMLFormElement>('#currentGoalTargetsForm');
    if (!form) return;
    const draft = this.drafts.sync(this.market, this.summary),
      stale = this.drafts.stale(draft, this.summary);
    root.querySelector('#goalEditorPeriod')!.textContent =
      `今日 ${draft.date} · 本周 ${draft.weekStart.slice(5)} — ${addDays(draft.weekStart, 6).slice(5)}\n${draft.timezone}`;
    for (const key of ['day', 'week'] as const) {
      const input = form.querySelector<HTMLInputElement>(`[data-goal-field="${key}"]`)!;
      if (input.value !== draft.values[key]) input.value = draft.values[key];
      input.disabled = draft.saving || stale;
    }
    const save = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    save.disabled = draft.saving || stale || !draft.dirty.size;
    save.textContent = draft.saving ? '正在保存…' : '保存目标';
    const reset = form.querySelector<HTMLButtonElement>('[data-goal-reset]')!;
    reset.hidden = !draft.dirty.size && !stale;
    reset.disabled = draft.saving;
    reset.textContent = stale ? '刷新到当前日期目标' : '恢复当前生效目标';
    const message = root.querySelector<HTMLElement>('#goalSaveMessage')!;
    message.textContent = stale
      ? '日期或统计时区已变化，请先刷新设置。'
      : draft.message || (draft.dirty.size ? '有未保存的修改' : '');
    message.classList.toggle('error', stale || draft.error);
  }
  private async save() {
    if (!this.summary) return;
    const selected = this.market,
      summary = this.summary,
      draft = this.drafts.sync(selected, summary);
    if (draft.saving) return;
    try {
      if (this.drafts.stale(draft, summary)) throw new Error('日期已变化，请先刷新目标设置');
      const body = this.drafts.request(draft);
      draft.saving = true;
      draft.message = '';
      this.updateEditor();
      const updated = await this.options.api<GoalSummary>(
        '/goals/current-targets',
        { method: 'PUT', body: JSON.stringify(body) },
        selected,
      );
      this.drafts.saved(draft, updated, selected);
      if (this.market === selected) this.render(updated, selected);
      this.options.toast(`${MARKET_LABELS[selected]}目标已保存`);
      await this.options.refresh();
    } catch (error) {
      draft.message = (error as Error).message;
      draft.error = true;
      if (draft.message.includes('日期') || draft.message.includes('时区'))
        await this.options.refresh();
    } finally {
      draft.saving = false;
      if (this.market === selected) this.updateEditor();
    }
  }
  private renderChart() {
    if (!this.summary) return;
    const summary = this.summary,
      module = this.module(),
      root = this.options.root,
      container = root.querySelector('#goalChartContent');
    if (!container) return;
    let points: GoalPoint[], caption: string;
    if (this.trend === 'weekly') {
      points = module.weeks;
      caption = '每周投递与周目标 · 最近 8 周';
    } else if (this.trend === 'cumulative') {
      const week = module.days.filter((day) => day.date >= summary.weekStart);
      points = week.map((point, index) => ({
        ...point,
        actual: week.slice(0, index + 1).reduce((sum, day) => sum + day.actual, 0),
        target: week.slice(0, index + 1).some((day) => day.target === null)
          ? null
          : week.slice(0, index + 1).reduce((sum, day) => sum + day.target!, 0),
        jobIds: week.slice(0, index + 1).flatMap((day) => day.jobIds),
      }));
      caption = '本周累计投递与每日计划';
    } else {
      points = module.days.filter((day) => day.date <= summary.today).slice(-28);
      caption = '每日投递与目标 · 最近 28 天';
    }
    root
      .querySelectorAll<HTMLButtonElement>('[data-goal-trend]')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.goalTrend === this.trend)),
      );
    container.innerHTML = `<p class="hint goal-chart-caption">${caption} · ${points[0]?.date || summary.today} — ${points.at(-1)?.date || summary.today}</p>${this.chart(points)}${points.every((point) => !point.actual) ? '<p class="goal-empty-data">暂无可计入的投递记录</p>' : ''}${this.trend === 'cumulative' ? `<p class="hint">独立周目标 ${module.week.target ?? '未设置'}；每日计划合计 ${module.days.filter((day) => day.date >= summary.weekStart).reduce((sum, day) => sum + (day.target || 0), 0)}。两类目标可独立设置。</p>` : ''}<p class="hint goal-chart-help">点击图表查看${MARKET_LABELS[this.market]}的对应申请。</p>`;
  }
  private chart(points: GoalPoint[]) {
    const width = 900,
      height = 250,
      left = 40,
      top = 18,
      bottom = 200,
      plot = width - left - 18,
      max = Math.max(1, ...points.flatMap((point) => [point.actual, point.target || 0]));
    const x = (i: number) => left + ((i + 0.5) * plot) / points.length,
      y = (value: number) => bottom - (value / max) * (bottom - top),
      bar = Math.min(45, (plot / points.length) * 0.6),
      cumulative = this.trend === 'cumulative';
    let line = '',
      connected = false;
    points.forEach((point, index) => {
      if (point.target === null) {
        connected = false;
        return;
      }
      line += `${connected ? 'L' : 'M'}${x(index)} ${y(point.target)} `;
      connected = true;
    });
    const actual = points
      .filter((point) => !cumulative || point.date <= this.summary!.today)
      .map((point, index) => `${index ? 'L' : 'M'}${x(index)} ${y(point.actual)}`)
      .join(' ');
    return `<svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${MARKET_LABELS[this.market]}${labels[this.trend]}数量与目标图"><line x1="${left}" x2="882" y1="${bottom}" y2="${bottom}" stroke="#d9ddec"/><line x1="${left}" x2="882" y1="${top}" y2="${top}" stroke="#f0eef7"/><text x="6" y="24">${max}</text><text x="18" y="203">0</text><path d="${line}" fill="none" stroke="#bd8b32" stroke-width="2" stroke-dasharray="5 4"/>${cumulative ? `<path d="${actual}" fill="none" stroke="#6c60db" stroke-width="3"/>` : ''}${points.map((point, index) => `<g data-detail="${point.jobIds.join(',')}" data-detail-market="${this.market}" tabindex="0" role="button" aria-label="${point.date} 实际 ${point.actual} 目标 ${point.target ?? '未设置'}"><title>${point.date} · 实际 ${point.actual} · 目标 ${point.target ?? '未设置'}</title>${cumulative ? (point.date <= this.summary!.today ? `<circle cx="${x(index)}" cy="${y(point.actual)}" r="5" fill="#6c60db"/>` : '') : `<rect x="${x(index) - bar / 2}" y="${y(point.actual)}" width="${bar}" height="${Math.max(2, bottom - y(point.actual))}" rx="3" fill="#8777e4"/>`}${points.length <= 8 || index % 4 === 0 || index === points.length - 1 ? `<text x="${x(index)}" y="228" text-anchor="middle">${point.date.slice(5)}</text>` : ''}</g>`).join('')}</svg><div class="chart-legend"><span>● 实际投递</span><span>┄ 目标／计划</span></div>`;
  }
  private openMore() {
    if (!this.summary) return;
    const selected = this.market,
      module = this.module();
    let draft = this.moreDrafts.get(selected);
    if (!draft) {
      draft = {
        weeklyTarget: module.rules.weeklyTarget === null ? '' : String(module.rules.weeklyTarget),
        date: this.summary.today,
        kind: 'day',
        historyTarget: '',
      };
      module.rules.weekdays.forEach(
        (value, index) => (draft![`weekday${index}`] = value === null ? '' : String(value)),
      );
      this.moreDrafts.set(selected, draft);
    }
    this.dialog.dataset.market = selected;
    this.dialog.innerHTML = `<div class="feature-dialog goal-settings-dialog"><header><div><p class="goal-editor-kicker">${MARKET_LABELS[selected]}</p><h2>更多目标设置</h2></div><button type="button" class="icon-button" aria-label="关闭更多目标设置" data-goal-dialog-close>×</button></header><p class="hint">仅修改${MARKET_LABELS[selected]}。日目标与独立周目标分别设置。</p><form id="goalDefaultsForm"><h3>每周默认计划</h3><div class="week-goal-inputs">${['一', '二', '三', '四', '五', '六', '日'].map((day, index) => `<label>周${day}<input type="number" name="weekday${index}" min="0" max="10000" step="1" value="${esc(draft![`weekday${index}`])}"></label>`).join('')}</div><label>每周默认目标<input type="number" name="weeklyTarget" min="0" max="10000" step="1" value="${esc(draft.weeklyTarget)}"></label><p class="hint">留空为未设置，0 为休息。从今天／本周生效；已单独设置的目标继续优先使用。</p><button type="submit" class="btn primary">保存默认计划</button></form><form id="goalHistoryForm"><h3>指定日期／历史目标</h3><label>目标类型<select name="kind"><option value="day" ${draft.kind === 'day' ? 'selected' : ''}>当日目标</option><option value="week" ${draft.kind === 'week' ? 'selected' : ''}>该日期所属周目标</option></select></label><label>日期<input type="date" name="date" value="${esc(draft.date)}" required></label><label>目标数<input type="number" name="historyTarget" min="0" max="10000" step="1" value="${esc(draft.historyTarget)}"></label><button type="submit" class="btn">保存指定目标</button></form><p class="goal-save-message" id="moreGoalMessage" role="status"></p></div>`;
    this.dialog
      .querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
        'input,select,button[type="submit"]',
      )
      .forEach((input) => (input.disabled = this.moreSaving.has(selected)));
    this.dialog.showModal();
  }
  private async saveMore(form: HTMLFormElement) {
    const selected = this.dialog.dataset.market as Market;
    if (this.moreSaving.has(selected)) return;
    const data = new FormData(form),
      number = (name: string) => {
        const value = String(data.get(name) || '');
        return value === '' ? null : Number(value);
      };
    const body =
      form.id === 'goalDefaultsForm'
        ? {
            weekdays: Array.from({ length: 7 }, (_, i) => number(`weekday${i}`)),
            weeklyTarget: number('weeklyTarget'),
          }
        : {
            kind: String(data.get('kind')),
            date: String(data.get('date')),
            target: number('historyTarget'),
          };
    this.moreSaving.add(selected);
    this.dialog
      .querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
        'input,select,button[type="submit"]',
      )
      .forEach((input) => (input.disabled = true));
    try {
      await this.options.api(
        form.id === 'goalDefaultsForm' ? '/goals' : '/goals/override',
        { method: 'PUT', body: JSON.stringify(body) },
        selected,
      );
      if (form.id === 'goalDefaultsForm') this.moreDrafts.delete(selected);
      if (this.dialog.dataset.market === selected) this.dialog.close();
      this.options.toast(`${MARKET_LABELS[selected]}目标设置已保存`);
      await this.options.refresh();
    } catch (error) {
      if (this.dialog.dataset.market === selected) {
        const message = this.dialog.querySelector<HTMLElement>('#moreGoalMessage')!;
        message.textContent = (error as Error).message;
        message.classList.add('error');
      }
    } finally {
      this.moreSaving.delete(selected);
      if (this.dialog.dataset.market === selected)
        this.dialog
          .querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
            'input,select,button[type="submit"]',
          )
          .forEach((input) => (input.disabled = false));
    }
  }
}
