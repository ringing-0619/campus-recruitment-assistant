import { CandidateService } from './candidates.js';
import { Store } from './db.js';
import { GoalService } from './goals.js';
import { parseRecruitmentMessage } from './parser.js';
import { addDays, dayInZone, zonedToIso } from '../shared/time.js';
import { DEFAULT_PRODUCTIVITY_SETTINGS } from '../shared/productivity.js';
import { EMPTY_APPLICATION, type EventType, type JobStatus, type Market } from '../shared/types.js';

export const DEMO_TIMEZONE = 'America/Chicago';
export const DEMO_TARGET_ID = 'demo-cn-01';
export const DEMO_AMBIGUOUS_ID = 'demo-cn-02';

const companies = [
  '星桥演示科技',
  '云杉演示数据',
  '云杉演示数据',
  '晴川演示科技',
  '白鹭演示研究',
  '海棠演示咨询',
  '木棉演示科技',
  '银杏演示分析',
  '青禾演示数据',
  '南风演示研究',
  '远帆演示科技',
  '晨光演示咨询',
  '竹海演示科技',
  '雨桐演示数据',
  '蓝湾演示研究',
  '长青演示咨询',
  '拾光演示科技',
  '林间演示数据',
  '松石演示研究',
  '清泉演示科技',
];

export function seedDemoData(store: Store, origin: string, now = new Date()) {
  if (store.getSetting('demo_seed_version') === '1') return;
  if (store.listJobs('cn').length || store.listJobs('us').length)
    throw new Error('Demo seeding requires an empty, isolated database');
  const today = dayInZone(now, DEMO_TIMEZONE);
  const at = (offset: number, hour = 10) =>
    zonedToIso(`${addDays(today, offset)}T${String(hour).padStart(2, '0')}:00`, DEMO_TIMEZONE)!;
  store.transaction(() => {
    store.setSetting('productivity_settings', JSON.stringify(DEFAULT_PRODUCTIVITY_SETTINGS));
    for (const market of ['cn', 'us'] as const) {
      new GoalService(store).saveRules(
        market,
        { weekdays: [3, 3, 3, 3, 3, 0, 0], weeklyTarget: 12 },
        addDays(today, -28),
      );
      for (let index = 0; index < 20; index++) {
        const id = `demo-${market}-${String(index + 1).padStart(2, '0')}`;
        const company =
          market === 'cn'
            ? companies[index]
            : `Demo ${['Cedar', 'Harbor', 'Maple', 'Orchid'][index % 4]} ${index + 1}`;
        const position =
          market === 'cn'
            ? index === 0
              ? '数据分析师'
              : index === 1
                ? '商业分析师'
                : index === 2
                  ? '产品分析师'
                  : ['数据分析师', '商业分析师', '策略分析师'][index % 3]
            : ['Data Analyst', 'Business Analyst', 'Product Analyst'][index % 3];
        const type: EventType =
          index < 5
            ? 'application'
            : index < 9
              ? 'assessment'
              : index < 12
                ? 'written_test'
                : index < 16
                  ? 'interview'
                  : index < 18
                    ? 'offer'
                    : 'rejection';
        const status: JobStatus = (
          {
            application: '已投递',
            assessment: '测评中',
            written_test: '笔试中',
            interview: '面试中',
            offer: '已offer',
            rejection: '已拒绝',
          } as Partial<Record<EventType, JobStatus>>
        )[type]!;
        const appliedAt = index === 3 ? at(0, 0) : at(-((index % 18) + 3));
        store.createJob({
          id,
          market,
          company,
          position,
          status,
          source: 'manual',
          notes: 'Synthetic demo data · 虚构申请，仅用于展示。',
          progressUrls: [`${origin}/demo/application/${id}`],
          application: {
            ...EMPTY_APPLICATION,
            appliedOn: index === 19 ? null : dayInZone(appliedAt, DEMO_TIMEZONE),
            appliedAt: index === 19 ? null : appliedAt,
            dateSource: index === 19 ? 'unknown' : 'manual',
            direction: market === 'cn' ? '数据与商业分析' : 'Data & Business Analytics',
            channel: index < 10 ? '公司官网 / Careers' : '校园渠道 / Campus',
            resumeVersion: index % 2 ? 'Demo resume B' : 'Demo resume A',
          },
        });
        store.addEvent(id, {
          type: 'application',
          title: '投递记录 · Synthetic demo',
          source: 'manual',
          occurredAt: appliedAt,
          dedupeKey: `demo:application:${id}`,
          evidence: 'Independently invented application; no real employer outcome.',
        });
        if (type !== 'application') {
          const completed = type === 'assessment' && index < 7;
          const event = store.addEvent(id, {
            type,
            title: `${position} · ${type} · 演示`,
            source: 'manual',
            occurredAt: at(-1),
            dedupeKey: `demo:stage:${id}`,
            startsAt:
              type === 'interview' ? at(index < 14 ? 0 : (index % 2) + 1, 9 + (index % 5)) : null,
            dueAt: ['assessment', 'written_test'].includes(type)
              ? at([7, 9].includes(index) ? 0 : (index % 2) + 1, 18)
              : null,
            completedAt: completed ? at(-1, 16) : null,
            outcome: completed ? (index === 5 ? 'passed' : 'failed') : 'unknown',
            resultAt: completed ? at(-1, 17) : null,
            evidence: 'Synthetic demo data; not a real recruiting result.',
          })!;
          if (['assessment', 'written_test', 'interview'].includes(type))
            store.addTask(id, {
              id: `demo-task-${id}`,
              eventId: event.id,
              type: type as 'assessment' | 'written_test' | 'interview',
              title: `${position} · ${type === 'interview' ? '面试安排' : '完成测评或笔试'}`,
              startsAt: event.startsAt,
              dueAt: event.dueAt,
              completedAt: event.completedAt,
            });
        }
      }
      const order = [
        0,
        12,
        7,
        16,
        ...Array.from({ length: 20 }, (_, i) => i).filter((i) => ![0, 12, 7, 16].includes(i)),
      ];
      order.forEach((index, rank) => {
        store.db
          .prepare('UPDATE jobs SET updated_at=? WHERE id=?')
          .run(
            new Date(now.getTime() - rank * 1000).toISOString(),
            `demo-${market}-${String(index + 1).padStart(2, '0')}`,
          );
      });
    }
    store.setSetting('demo_seed_version', '1');
  });
}

export function runDemoScenario(
  store: Store,
  candidates: CandidateService,
  scenario: string,
  receivedAt: Date,
) {
  if (!['assessment', 'replay', 'ambiguous'].includes(scenario))
    throw new Error('Unknown demo scenario');
  const assessmentRef = 'mail:demo-assessment-001@example.com';
  if (
    scenario === 'replay' &&
    !store.db.prepare('SELECT id FROM candidates WHERE source_ref=?').get(assessmentRef)
  )
    throw new Error('请先运行“模拟收到测评通知”。');
  const ambiguous = scenario === 'ambiguous';
  const parsed = parseRecruitmentMessage({
    subject: ambiguous ? '云杉演示数据测评邀请' : '星桥演示科技测评邀请',
    from: 'Demo Recruiting <recruiting@example.com>',
    text: ambiguous
      ? '公司：云杉演示数据\n现邀请您参加测评，请在72小时内完成测评。本通知为虚构演示。'
      : '公司：星桥演示科技\n应聘岗位：数据分析师\n现邀请您参加测评，请在72小时内完成测评。本通知为虚构演示。',
    receivedAt,
    messageId: ambiguous ? 'demo-ambiguous-001@example.com' : 'demo-assessment-001@example.com',
  });
  if (!parsed) throw new Error('The synthetic notification was not recognized');
  const result = candidates.ingest({ ...parsed, market: 'cn' as Market });
  return {
    scenario,
    autoApplied: result.autoApplied,
    candidate: result.candidate,
    job: store.getJob(DEMO_TARGET_ID),
    explanation: ambiguous
      ? '两个岗位均可能匹配，交由人工确认。'
      : scenario === 'replay'
        ? '同一通知已重放；事件与待办数量保持不变。'
        : '已通过真实解析与关联流程处理虚构通知。',
  };
}
