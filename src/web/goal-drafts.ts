import type {
  CurrentGoalChanges,
  CurrentGoalTargetsInput,
  GoalModule,
  GoalSummary,
} from '../shared/productivity';
import type { Market } from '../shared/types';

type Field = 'day' | 'week';
export interface GoalDraft {
  date: string;
  weekStart: string;
  timezone: string;
  values: Record<Field, string>;
  dirty: Set<Field>;
  saving: boolean;
  message: string;
  error: boolean;
}
/** Keep user input apart from polled server data, separately for each market and period. */
export class GoalDraftBook {
  private drafts = new Map<Market, GoalDraft>();
  sync(market: Market, summary: GoalSummary): GoalDraft {
    const module = summary.modules.find((item) => item.market === market)!;
    let draft = this.drafts.get(market);
    if (!draft || (!draft.dirty.size && !draft.saving && this.stale(draft, summary))) {
      draft = {
        date: summary.today,
        weekStart: summary.weekStart,
        timezone: summary.timezone,
        values: { day: '', week: '' },
        dirty: new Set(),
        saving: false,
        message: '',
        error: false,
      };
      this.drafts.set(market, draft);
    }
    if (!this.stale(draft, summary))
      for (const key of ['day', 'week'] as const)
        if (!draft.dirty.has(key)) draft.values[key] = this.value(module, key);
    return draft;
  }
  stale(draft: GoalDraft, summary: GoalSummary) {
    return (
      draft.date !== summary.today ||
      draft.weekStart !== summary.weekStart ||
      draft.timezone !== summary.timezone
    );
  }
  edit(market: Market, key: Field, value: string, summary: GoalSummary) {
    const draft = this.sync(market, summary);
    if (draft.saving) return;
    draft.values[key] = value;
    draft.dirty.add(key);
    draft.message = '';
    draft.error = false;
    const module = summary.modules.find((item) => item.market === market)!;
    if (!this.stale(draft, summary) && value === this.value(module, key)) draft.dirty.delete(key);
  }
  reset(market: Market, summary: GoalSummary) {
    this.drafts.delete(market);
    return this.sync(market, summary);
  }
  request(draft: GoalDraft): CurrentGoalTargetsInput {
    const changes: CurrentGoalChanges = {};
    for (const key of draft.dirty) {
      const raw = draft.values[key],
        value = raw === '' ? null : Number(raw);
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 10000))
        throw new Error('目标须为 0–10000 的整数；未设置请留空');
      changes[key] = value;
    }
    if (!draft.dirty.size) throw new Error('请先修改今日或本周目标');
    return { date: draft.date, weekStart: draft.weekStart, timezone: draft.timezone, changes };
  }
  saved(draft: GoalDraft, summary: GoalSummary, market: Market) {
    draft.dirty.clear();
    draft.saving = false;
    draft.error = false;
    draft.message = '目标已保存';
    this.sync(market, summary);
  }
  private value(module: GoalModule, key: Field) {
    return module[key].target === null ? '' : String(module[key].target);
  }
}
