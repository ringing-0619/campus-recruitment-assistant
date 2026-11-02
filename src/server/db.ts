import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Candidate, Job, JobEvent, JobStatus, JobTask } from '../shared/types.js';
import { EMPTY_APPLICATION, normalizeMarket, type Market } from '../shared/types.js';
import { databasePath, migrationDataPath } from './paths.js';

import { migrateProductivity } from './productivity-schema.js';
import { readApplication, applicationFromEvidence } from './application.js';

type Row = Record<string, unknown>;
export interface StoreOptions {
  legacyDataPath?: string | null;
}

export class Store {
  readonly db: DatabaseSync;
  private transactionSequence = 0;

  constructor(
    private readonly path = databasePath,
    options: StoreOptions = {},
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;',
      );
      this.migrateSchema();
      const candidateColumns = this.db.prepare('PRAGMA table_info(candidates)').all() as Row[];
      if (!candidateColumns.some((column) => column.name === 'review_reason'))
        this.db.exec("ALTER TABLE candidates ADD COLUMN review_reason TEXT NOT NULL DEFAULT ''");
      if (!candidateColumns.some((column) => column.name === 'parsing_confidence'))
        this.db.exec('ALTER TABLE candidates ADD COLUMN parsing_confidence REAL');
      this.migrateMarkets();
      migrateProductivity(this.db);
      this.importLegacyOnce(
        options.legacyDataPath === undefined ? migrationDataPath : options.legacyDataPath,
      );
      this.migrateAiEventTypesOnce();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  transaction<T>(work: () => T): T {
    const name = `store_tx_${++this.transactionSequence}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = work();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }

  private migrateMarkets() {
    this.db.exec('BEGIN');
    try {
      for (const table of ['jobs', 'candidates', 'audit_log']) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
        if (!columns.some((column) => column.name === 'market')) {
          this.db.exec(
            `ALTER TABLE ${table} ADD COLUMN market TEXT NOT NULL DEFAULT 'cn' CHECK(market IN ('cn','us'))`,
          );
        }
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_market ON ${table}(market)`);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  backupIfDue() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.getSetting('last_backup_date') === today) return;
    this.db.exec('PRAGMA wal_checkpoint(FULL)');
    const backupDir = join(dirname(this.path), 'backups');
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(this.path, join(backupDir, `campus-assistant-${today}.sqlite`));
    const files = readdirSync(backupDir)
      .filter((name) => name.endsWith('.sqlite'))
      .sort()
      .reverse();
    files.slice(7).forEach((name) => unlinkSync(join(backupDir, name)));
    this.setSetting('last_backup_date', today);
  }

  private migrateSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, company TEXT NOT NULL, position TEXT NOT NULL,
        status TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
        external_application_id TEXT NOT NULL DEFAULT '', progress_urls TEXT NOT NULL DEFAULT '[]',
        last_synced_at TEXT, sync_health TEXT NOT NULL DEFAULT 'never',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        type TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL,
        occurred_at TEXT NOT NULL, starts_at TEXT, due_at TEXT, completed_at TEXT,
        confidence REAL NOT NULL DEFAULT 1, evidence TEXT NOT NULL DEFAULT '',
        dedupe_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES events(id) ON DELETE SET NULL, type TEXT NOT NULL,
        title TEXT NOT NULL, starts_at TEXT, due_at TEXT, completed_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id, completed_at, due_at);
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, source_ref TEXT NOT NULL UNIQUE,
        company TEXT NOT NULL DEFAULT '', position TEXT NOT NULL DEFAULT '',
        external_application_id TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL, title TEXT NOT NULL, occurred_at TEXT NOT NULL,
        starts_at TEXT, due_at TEXT, evidence TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL,
        suggested_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY, action TEXT NOT NULL, entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT,
        undo_payload TEXT, created_at TEXT NOT NULL, undone_at TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS unrecognized_domains (
        domain TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 1, last_seen_at TEXT NOT NULL
      );
    `);
  }

  private importLegacyOnce(legacyDataPath?: string | null) {
    if (this.getSetting('legacy_migration_v3') === 'done') return;
    if (!legacyDataPath) {
      this.setSetting('legacy_migration_v3', 'done');
      return;
    }
    const count = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as Row).count,
    );
    if (count === 0) {
      const raw = JSON.parse(readFileSync(legacyDataPath, 'utf8')) as Array<
        Record<string, unknown>
      >;
      if (!Array.isArray(raw)) throw new Error('旧数据迁移文件必须为 JSON 数组');
      const insertJob = this.db.prepare(`INSERT OR IGNORE INTO jobs
        (id, company, position, status, notes, source, external_application_id, progress_urls, sync_health, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '', '', ?, 'never', ?, ?)`);
      const insertEvent = this.db.prepare(`INSERT OR IGNORE INTO events
        (id, job_id, type, title, source, occurred_at, starts_at, due_at, completed_at, confidence, evidence, dedupe_key, created_at)
        VALUES (?, ?, ?, ?, 'manual', ?, NULL, NULL, NULL, 1, ?, ?, ?)`);
      const now = new Date().toISOString();
      this.db.exec('BEGIN');
      try {
        for (const item of raw) {
          const id = String(item.id || randomUUID());
          const urls = item.link ? JSON.stringify([item.link]) : '[]';
          insertJob.run(
            id,
            String(item.company || ''),
            String(item.position || ''),
            String(item.status || '已投递'),
            String(item.notes || ''),
            urls,
            now,
            now,
          );
          const stages = Array.isArray(item.stages)
            ? (item.stages as Array<Record<string, unknown>>)
            : [];
          stages.forEach((stage, index) => {
            const title = String(stage.title || '进度');
            const occurred = normalizeLegacyDate(String(stage.date || ''), now);
            const key = `legacy:${id}:${index}:${title}:${occurred}`;
            insertEvent.run(
              randomUUID(),
              id,
              eventTypeFromText(title),
              title,
              occurred,
              String(stage.note || ''),
              key,
              now,
            );
          });
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    this.setSetting('legacy_migration_v3', 'done');
  }

  private migrateAiEventTypesOnce() {
    if (this.getSetting('ai_event_types_v1') === 'done') return;
    const aiInterview = `(lower(title || ' ' || evidence) LIKE '%ai面试%' OR lower(title || ' ' || evidence) LIKE '%ai 面试%'
      OR lower(title || ' ' || evidence) LIKE '%ai interview%' OR title || ' ' || evidence LIKE '%智能面试%'
      OR title || ' ' || evidence LIKE '%数字人面试%')`;
    const aiAssessment = `(lower(title || ' ' || evidence) LIKE '%ai测评%' OR lower(title || ' ' || evidence) LIKE '%ai 测评%'
      OR lower(title || ' ' || evidence) LIKE '%ai评估%' OR lower(title || ' ' || evidence) LIKE '%ai assessment%'
      OR title || ' ' || evidence LIKE '%智能测评%')`;
    this.db.exec('BEGIN');
    try {
      this.db.exec(`UPDATE events SET type='ai_interview' WHERE ${aiInterview};
        UPDATE events SET type='ai_assessment' WHERE ${aiAssessment};
        UPDATE events SET title='AI面试通知' WHERE type='ai_interview' AND lower(title) NOT LIKE '%ai%';
        UPDATE events SET title='AI测评通知' WHERE type='ai_assessment' AND lower(title) NOT LIKE '%ai%';
        UPDATE candidates SET event_type='ai_interview', title='AI面试通知'
          WHERE lower(title || ' ' || evidence) LIKE '%ai面试%' OR lower(title || ' ' || evidence) LIKE '%ai interview%' OR title || ' ' || evidence LIKE '%智能面试%' OR title || ' ' || evidence LIKE '%数字人面试%';
        UPDATE candidates SET event_type='ai_assessment', title='AI测评通知'
          WHERE lower(title || ' ' || evidence) LIKE '%ai测评%' OR lower(title || ' ' || evidence) LIKE '%ai评估%' OR lower(title || ' ' || evidence) LIKE '%ai assessment%' OR title || ' ' || evidence LIKE '%智能测评%';
        UPDATE tasks SET type=(SELECT type FROM events WHERE events.id=tasks.event_id),
          title=CASE (SELECT type FROM events WHERE events.id=tasks.event_id) WHEN 'ai_interview' THEN 'AI面试通知' WHEN 'ai_assessment' THEN 'AI测评通知' ELSE title END
          WHERE event_id IN (SELECT id FROM events WHERE type IN ('ai_interview','ai_assessment'));
        UPDATE jobs SET status='AI面试中' WHERE status NOT IN ('已offer','已拒绝','流程结束') AND id IN (SELECT job_id FROM tasks WHERE type='ai_interview' AND completed_at IS NULL);
        UPDATE jobs SET status='AI测评中' WHERE status NOT IN ('已offer','已拒绝','流程结束','AI面试中') AND id IN (SELECT job_id FROM tasks WHERE type='ai_assessment' AND completed_at IS NULL);`);
      this.db
        .exec(`UPDATE jobs SET status='AI面试中' WHERE status NOT IN ('已offer','已拒绝','流程结束','等待结果')
        AND (SELECT type FROM events WHERE job_id=jobs.id AND completed_at IS NULL ORDER BY occurred_at DESC LIMIT 1)='ai_interview';
        UPDATE jobs SET status='AI测评中' WHERE status NOT IN ('已offer','已拒绝','流程结束','等待结果','AI面试中')
        AND (SELECT type FROM events WHERE job_id=jobs.id AND completed_at IS NULL ORDER BY occurred_at DESC LIMIT 1)='ai_assessment';`);
      this.setSetting('ai_event_types_v1', 'done');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getSetting(key: string) {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined)
      ?.value as string | undefined;
  }

  setSetting(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }

  listJobs(market: Market = 'cn'): Job[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs WHERE market=? ORDER BY updated_at DESC')
      .all(market) as Row[];
    return rows.map((row) => this.hydrateJob(row));
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return row ? this.hydrateJob(row) : null;
  }

  createJob(input: Partial<Job>): Job {
    const now = new Date().toISOString();
    const id = input.id || randomUUID();
    this.db
      .prepare(
        `INSERT INTO jobs
      (id, company, position, status, notes, source, external_application_id, progress_urls, last_synced_at, sync_health, created_at, updated_at, market, application_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.company || '',
        input.position || '',
        input.status || '已投递',
        input.notes || '',
        input.source || '',
        input.externalApplicationId || '',
        JSON.stringify(input.progressUrls || []),
        input.lastSyncedAt || null,
        input.syncHealth || 'never',
        now,
        now,
        normalizeMarket(input.market),
        JSON.stringify({ ...EMPTY_APPLICATION, ...input.application }),
      );
    const job = this.getJob(id)!;
    this.audit('create', 'job', id, null, job, { kind: 'delete_job', id });
    return job;
  }

  updateJob(id: string, input: Partial<Job>): Job | null {
    const before = this.getJob(id);
    if (!before) return null;
    const merged = {
      ...before,
      ...input,
      application: { ...before.application, ...input.application },
      id,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE jobs SET company=?, position=?, status=?, notes=?, source=?, external_application_id=?,
      progress_urls=?, last_synced_at=?, sync_health=?, updated_at=?, application_json=? WHERE id=?`,
      )
      .run(
        merged.company,
        merged.position,
        merged.status,
        merged.notes,
        merged.source,
        merged.externalApplicationId,
        JSON.stringify(merged.progressUrls),
        merged.lastSyncedAt,
        merged.syncHealth,
        merged.updatedAt,
        JSON.stringify(merged.application),
        id,
      );
    const after = this.getJob(id)!;
    this.audit('update', 'job', id, before, after, { kind: 'restore_job', job: before });
    return after;
  }

  deleteJob(id: string) {
    const before = this.getJob(id);
    if (!before) return false;
    this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
    this.audit('delete', 'job', id, before, null, { kind: 'restore_job', job: before });
    return true;
  }

  addEvent(jobId: string, input: Partial<JobEvent>): JobEvent | null {
    const now = new Date().toISOString();
    const dedupeKey =
      input.dedupeKey || `manual:${jobId}:${input.type}:${input.occurredAt}:${randomUUID()}`;
    const existing = this.db.prepare('SELECT * FROM events WHERE dedupe_key=?').get(dedupeKey) as
      Row | undefined;
    if (existing) {
      if (existing.job_id !== jobId) throw new Error('EVENT_BELONGS_TO_ANOTHER_JOB');
      return mapEvent(existing);
    }
    const event: JobEvent = {
      id: input.id || randomUUID(),
      jobId,
      type: input.type || 'other',
      title: input.title || '进度更新',
      source: input.source || 'manual',
      occurredAt: input.occurredAt || now,
      startsAt: input.startsAt || null,
      dueAt: input.dueAt || null,
      completedAt: input.completedAt || null,
      confidence: input.confidence ?? 1,
      evidence: input.evidence || '',
      dedupeKey,
      createdAt: now,
      round: input.round || '',
      outcome: input.outcome || 'unknown',
      resultAt: input.resultAt || null,
    };
    this.db
      .prepare(
        `INSERT INTO events
      (id,job_id,type,title,source,occurred_at,starts_at,due_at,completed_at,confidence,evidence,dedupe_key,created_at,round_label,outcome,result_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.id,
        event.jobId,
        event.type,
        event.title,
        event.source,
        event.occurredAt,
        event.startsAt,
        event.dueAt,
        event.completedAt,
        event.confidence,
        event.evidence,
        event.dedupeKey,
        event.createdAt,
        event.round || '',
        event.outcome || 'unknown',
        event.resultAt || null,
      );
    this.db.prepare('UPDATE jobs SET updated_at=? WHERE id=?').run(now, jobId);
    this.audit('create', 'event', event.id, null, event, {
      kind: 'delete_event',
      id: event.id,
      jobId,
    });
    return event;
  }

  addTask(jobId: string, input: Partial<JobTask>): JobTask {
    if (input.id) {
      const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(input.id) as
        Row | undefined;
      if (row) {
        if (row.job_id !== jobId) throw new Error('TASK_BELONGS_TO_ANOTHER_JOB');
        return mapTask(row);
      }
    }
    if (input.eventId) {
      const event = this.db.prepare('SELECT job_id FROM events WHERE id=?').get(input.eventId) as
        Row | undefined;
      if (!event || event.job_id !== jobId) throw new Error('EVENT_BELONGS_TO_ANOTHER_JOB');
    }
    const now = new Date().toISOString();
    const task: JobTask = {
      id: input.id || randomUUID(),
      jobId,
      eventId: input.eventId || null,
      type: input.type || 'other',
      title: input.title || '待处理事项',
      startsAt: input.startsAt || null,
      dueAt: input.dueAt || null,
      completedAt: input.completedAt || null,
      cancelledAt: input.cancelledAt || null,
      createdAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO tasks(id,job_id,event_id,type,title,starts_at,due_at,completed_at,created_at,cancelled_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        task.id,
        jobId,
        task.eventId,
        task.type,
        task.title,
        task.startsAt,
        task.dueAt,
        task.completedAt,
        task.createdAt,
        task.cancelledAt || null,
      );
    this.audit('create', 'task', task.id, null, task, { kind: 'delete_task', id: task.id, jobId });
    return task;
  }

  completeTask(
    id: string,
    completedAt = new Date().toISOString(),
    overwrite = false,
  ): JobTask | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Row | undefined;
    if (!row) return null;
    const before = mapTask(row);
    if (before.cancelledAt) throw new Error('TASK_CANCELLED');
    if (before.completedAt && !overwrite) throw new Error('TASK_ALREADY_COMPLETED');
    this.db.prepare('UPDATE tasks SET completed_at=? WHERE id=?').run(completedAt, id);
    if (before.eventId)
      this.db
        .prepare('UPDATE events SET completed_at=? WHERE id=?')
        .run(completedAt, before.eventId);
    const job = this.getJob(before.jobId);
    if (job && before.type !== 'other' && !['已offer', '已拒绝', '流程结束'].includes(job.status)) {
      this.db
        .prepare("UPDATE jobs SET status='等待结果', updated_at=? WHERE id=?")
        .run(completedAt, before.jobId);
    }
    const after = mapTask(this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Row);
    this.audit('complete', 'task', id, before, after, {
      kind: 'restore_task',
      task: before,
      jobBefore: job,
    });
    return after;
  }

  listCandidates(status = 'pending', market: Market = 'cn'): Candidate[] {
    return (
      this.db
        .prepare('SELECT * FROM candidates WHERE status=? AND market=? ORDER BY created_at DESC')
        .all(status, market) as Row[]
    ).map(mapCandidate);
  }

  insertCandidate(candidate: Candidate): Candidate {
    const existing = this.db
      .prepare('SELECT * FROM candidates WHERE source_ref=?')
      .get(candidate.sourceRef) as Row | undefined;
    if (existing) {
      const current = mapCandidate(existing);
      // 规则升级后重放同一封邮件时，只刷新尚未处理的解析结果；
      // 已应用/已忽略的记录保持不变，避免改写历史。
      if (current.status === 'pending') {
        this.db
          .prepare(
            `UPDATE candidates SET source=?,company=?,position=?,external_application_id=?,url=?,event_type=?,title=?,
          occurred_at=?,starts_at=?,due_at=?,evidence=?,confidence=?,suggested_job_id=?,review_reason=?,parsing_confidence=?,application_json=? WHERE id=?`,
          )
          .run(
            candidate.source,
            candidate.company,
            candidate.position,
            candidate.externalApplicationId,
            candidate.url,
            candidate.eventType,
            candidate.title,
            candidate.occurredAt,
            candidate.startsAt,
            candidate.dueAt,
            candidate.evidence,
            candidate.confidence,
            candidate.suggestedJobId,
            candidate.reviewReason || '',
            candidate.parsingConfidence ?? candidate.confidence,
            JSON.stringify(candidate.application || current.application || {}),
            current.id,
          );
        return this.getCandidate(current.id)!;
      }
      return current;
    }
    this.db
      .prepare(
        `INSERT INTO candidates
      (id,source,source_ref,company,position,external_application_id,url,event_type,title,occurred_at,starts_at,due_at,evidence,confidence,suggested_job_id,status,created_at,market,review_reason,parsing_confidence,application_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        candidate.id,
        candidate.source,
        candidate.sourceRef,
        candidate.company,
        candidate.position,
        candidate.externalApplicationId,
        candidate.url,
        candidate.eventType,
        candidate.title,
        candidate.occurredAt,
        candidate.startsAt,
        candidate.dueAt,
        candidate.evidence,
        candidate.confidence,
        candidate.suggestedJobId,
        candidate.status,
        candidate.createdAt,
        candidate.market,
        candidate.reviewReason || '',
        candidate.parsingConfidence ?? candidate.confidence,
        JSON.stringify(candidate.application || {}),
      );
    return candidate;
  }

  setCandidateStatus(id: string, status: Candidate['status']) {
    this.db.prepare('UPDATE candidates SET status=? WHERE id=?').run(status, id);
  }

  getCandidate(id: string): Candidate | null {
    const row = this.db.prepare('SELECT * FROM candidates WHERE id=?').get(id) as Row | undefined;
    return row ? mapCandidate(row) : null;
  }

  emailCandidatesByRef(sourceRef: string): Candidate[] {
    return (
      this.db
        .prepare("SELECT * FROM candidates WHERE source='email' AND source_ref IN (?,?)")
        .all(sourceRef, `market:us:${sourceRef}`) as Row[]
    ).map(mapCandidate);
  }

  recordDomain(domain: string) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO unrecognized_domains(domain,count,last_seen_at) VALUES (?,1,?)
      ON CONFLICT(domain) DO UPDATE SET count=count+1,last_seen_at=excluded.last_seen_at`,
      )
      .run(domain, now);
  }

  listDomains() {
    return this.db
      .prepare(
        'SELECT domain,count,last_seen_at AS lastSeenAt FROM unrecognized_domains ORDER BY count DESC,last_seen_at DESC',
      )
      .all() as Array<{ domain: string; count: number; lastSeenAt: string }>;
  }

  audit(
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
    undoPayload?: unknown,
  ) {
    const entity = (after || before || {}) as { market?: Market; jobId?: string };
    const market = normalizeMarket(
      entity.market || (entity.jobId ? this.getJob(entity.jobId)?.market : undefined),
    );
    this.db
      .prepare(
        `INSERT INTO audit_log(id,action,entity_type,entity_id,before_json,after_json,undo_payload,created_at,market)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        action,
        entityType,
        entityId,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        undoPayload ? JSON.stringify(undoPayload) : null,
        new Date().toISOString(),
        market,
      );
  }

  listAudit(limit = 50, market: Market = 'cn') {
    return this.db
      .prepare(
        `SELECT id,action,entity_type AS entityType,entity_id AS entityId,before_json AS beforeJson,
      after_json AS afterJson,created_at AS createdAt,undone_at AS undoneAt,
      CASE WHEN undo_payload IS NOT NULL THEN 1 ELSE 0 END AS canUndo
      FROM audit_log WHERE market=? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(market, limit);
  }

  entityMarket(kind: string, id: string): Market | null {
    const queries: Record<string, string> = {
      jobs: 'SELECT market FROM jobs WHERE id=?',
      candidates: 'SELECT market FROM candidates WHERE id=?',
      audit: 'SELECT market FROM audit_log WHERE id=?',
      events: 'SELECT jobs.market FROM events JOIN jobs ON jobs.id=events.job_id WHERE events.id=?',
      tasks: 'SELECT jobs.market FROM tasks JOIN jobs ON jobs.id=tasks.job_id WHERE tasks.id=?',
    };
    if (!queries[kind]) return null;
    const row = this.db.prepare(queries[kind]).get(id) as Row | undefined;
    return row ? normalizeMarket(row.market) : null;
  }

  undoAudit(id: string) {
    const row = this.db.prepare('SELECT * FROM audit_log WHERE id=?').get(id) as Row | undefined;
    if (!row || row.undone_at || !row.undo_payload) return false;
    const payload = JSON.parse(String(row.undo_payload)) as Record<string, unknown>;
    this.db.exec('BEGIN');
    try {
      if (payload.kind === 'undo_candidate') {
        const jobId = String(payload.jobId);
        if (payload.createdJob) {
          this.db.prepare('DELETE FROM jobs WHERE id=?').run(jobId);
        } else {
          if (payload.taskId)
            this.db.prepare('DELETE FROM tasks WHERE id=?').run(String(payload.taskId));
          if (payload.eventId)
            this.db.prepare('DELETE FROM events WHERE id=?').run(String(payload.eventId));
          if (payload.jobBefore) this.restoreJobColumns(payload.jobBefore as Job);
        }
        // 邮件撤销是用户明确否定此次自动写入，重识别时不能再次自动应用。
        if (payload.candidateId)
          this.db
            .prepare(
              "UPDATE candidates SET status=CASE source WHEN 'email' THEN 'ignored' ELSE 'pending' END WHERE id=?",
            )
            .run(String(payload.candidateId));
      } else if (payload.kind === 'delete_event') {
        this.db.prepare('DELETE FROM events WHERE id=?').run(String(payload.id));
      } else if (payload.kind === 'delete_task') {
        this.db.prepare('DELETE FROM tasks WHERE id=?').run(String(payload.id));
      } else if (payload.kind === 'delete_job') {
        this.db.prepare('DELETE FROM jobs WHERE id=?').run(String(payload.id));
      } else if (payload.kind === 'restore_job' && payload.job) {
        this.restoreJobColumns(payload.job as Job);
      } else if (payload.kind === 'restore_task' && payload.task) {
        const task = payload.task as JobTask;
        this.db
          .prepare('UPDATE tasks SET completed_at=? WHERE id=?')
          .run(task.completedAt, task.id);
        this.db
          .prepare('UPDATE tasks SET cancelled_at=? WHERE id=?')
          .run(task.cancelledAt || null, task.id);
        if (task.eventId)
          this.db
            .prepare('UPDATE events SET completed_at=?,starts_at=?,due_at=? WHERE id=?')
            .run(task.completedAt, task.startsAt, task.dueAt, task.eventId);
        this.db
          .prepare('UPDATE tasks SET starts_at=?,due_at=?,title=? WHERE id=?')
          .run(task.startsAt, task.dueAt, task.title, task.id);
        if (payload.jobBefore) this.restoreJobColumns(payload.jobBefore as Job);
      } else if (payload.kind === 'restore_event' && payload.event) {
        const event = payload.event as JobEvent;
        this.db
          .prepare('UPDATE events SET round_label=?,outcome=?,result_at=? WHERE id=?')
          .run(event.round || '', event.outcome || 'unknown', event.resultAt || null, event.id);
      } else return false;
      this.db
        .prepare('UPDATE audit_log SET undone_at=? WHERE id=?')
        .run(new Date().toISOString(), id);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private restoreJobColumns(job: Job) {
    const exists = this.db.prepare('SELECT id FROM jobs WHERE id=?').get(job.id);
    if (!exists) {
      this.db
        .prepare(
          `INSERT INTO jobs(id,company,position,status,notes,source,external_application_id,progress_urls,last_synced_at,sync_health,created_at,updated_at,market)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          job.id,
          job.company,
          job.position,
          job.status,
          job.notes,
          job.source,
          job.externalApplicationId,
          JSON.stringify(job.progressUrls),
          job.lastSyncedAt,
          job.syncHealth,
          job.createdAt,
          job.updatedAt,
          normalizeMarket(job.market),
        );
    } else {
      this.db
        .prepare(
          `UPDATE jobs SET company=?,position=?,status=?,notes=?,source=?,external_application_id=?,progress_urls=?,last_synced_at=?,sync_health=?,updated_at=? WHERE id=?`,
        )
        .run(
          job.company,
          job.position,
          job.status,
          job.notes,
          job.source,
          job.externalApplicationId,
          JSON.stringify(job.progressUrls),
          job.lastSyncedAt,
          job.syncHealth,
          job.updatedAt,
          job.id,
        );
    }
    this.db
      .prepare('UPDATE jobs SET application_json=? WHERE id=?')
      .run(
        JSON.stringify(job.application || this.getJob(job.id)?.application || EMPTY_APPLICATION),
        job.id,
      );
    if (!exists) {
      for (const event of job.events || []) this.addEvent(job.id, event);
      for (const task of job.tasks || []) this.addTask(job.id, task);
    }
  }

  private applicationWithEvidence(value: unknown, events: JobEvent[]) {
    const meta = readApplication(value);
    return meta.dateSource === 'unknown' && !meta.appliedOn && !meta.appliedAt
      ? { ...meta, ...applicationFromEvidence(events) }
      : meta;
  }

  updateEvent(id: string, input: Partial<JobEvent>): JobEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id=?').get(id) as Row | undefined;
    if (!row) return null;
    const before = mapEvent(row),
      after = { ...before, ...input };
    this.db
      .prepare('UPDATE events SET round_label=?,outcome=?,result_at=? WHERE id=?')
      .run(after.round || '', after.outcome || 'unknown', after.resultAt || null, id);
    this.audit('update', 'event', id, before, after, { kind: 'restore_event', event: before });
    return after;
  }

  updateTask(id: string, input: Partial<JobTask>): JobTask | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Row | undefined;
    if (!row) return null;
    const before = mapTask(row),
      after = { ...before, ...input };
    this.db
      .prepare('UPDATE tasks SET title=?,starts_at=?,due_at=?,cancelled_at=? WHERE id=?')
      .run(after.title, after.startsAt, after.dueAt, after.cancelledAt || null, id);
    if (after.eventId)
      this.db
        .prepare('UPDATE events SET starts_at=?,due_at=? WHERE id=?')
        .run(after.startsAt, after.dueAt, after.eventId);
    this.audit('update', 'task', id, before, after, { kind: 'restore_task', task: before });
    return after;
  }

  private hydrateJob(row: Row): Job {
    const id = String(row.id);
    const events = (
      this.db
        .prepare('SELECT * FROM events WHERE job_id=? ORDER BY occurred_at DESC')
        .all(id) as Row[]
    ).map(mapEvent);
    const tasks = (
      this.db
        .prepare(
          'SELECT * FROM tasks WHERE job_id=? ORDER BY completed_at IS NOT NULL,due_at,created_at',
        )
        .all(id) as Row[]
    )
      .map(mapTask)
      .map((task) => {
        const event = events.find((event) => event.id === task.eventId);
        return event?.outcome === 'cancelled'
          ? { ...task, cancelledAt: task.cancelledAt || event.resultAt || event.occurredAt }
          : event && ['passed', 'failed'].includes(event.outcome || '')
            ? { ...task, resolvedAt: event.resultAt || event.occurredAt }
            : task;
      });
    const deadline =
      tasks
        .filter((task) => !task.completedAt && !task.cancelledAt && !task.resolvedAt && task.dueAt)
        .map((task) => task.dueAt!)
        .sort()[0] || null;
    return {
      id,
      market: normalizeMarket(row.market),
      company: String(row.company),
      position: String(row.position),
      status: row.status as JobStatus,
      notes: String(row.notes),
      source: String(row.source),
      externalApplicationId: String(row.external_application_id),
      progressUrls: safeJsonArray(row.progress_urls),
      lastSyncedAt: row.last_synced_at as string | null,
      syncHealth: row.sync_health as Job['syncHealth'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      nextDeadline: deadline,
      events,
      tasks,
      application: this.applicationWithEvidence(row.application_json, events),
    };
  }
}

export function stableHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeLegacyDate(value: string, fallback: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00.000Z` : fallback;
}

function safeJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function eventTypeFromText(value: string): JobEvent['type'] {
  if (/投递|申请/.test(value)) return 'application';
  if (/(?:AI|智能|人工智能).*测评|(?:测评|评估).*AI|AI\s*assessment/i.test(value))
    return 'ai_assessment';
  if (/(?:AI|智能|数字人|人工智能).*面试|面试.*AI|AI\s*interview/i.test(value))
    return 'ai_interview';
  if (/测评|assessment/i.test(value)) return 'assessment';
  if (/笔试|written/i.test(value)) return 'written_test';
  if (/面试|面谈|interview/i.test(value)) return 'interview';
  if (/offer|录用/i.test(value)) return 'offer';
  if (/拒|淘汰|不匹配/i.test(value)) return 'rejection';
  if (/结束|关闭/.test(value)) return 'ended';
  return 'other';
}

function mapEvent(row: Row): JobEvent {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    type: row.type as JobEvent['type'],
    title: String(row.title),
    source: row.source as JobEvent['source'],
    occurredAt: String(row.occurred_at),
    startsAt: row.starts_at as string | null,
    dueAt: row.due_at as string | null,
    completedAt: row.completed_at as string | null,
    confidence: Number(row.confidence),
    evidence: String(row.evidence),
    dedupeKey: String(row.dedupe_key),
    createdAt: String(row.created_at),
    round: String(row.round_label || ''),
    outcome: (row.outcome || 'unknown') as JobEvent['outcome'],
    resultAt: row.result_at as string | null,
  };
}

function mapTask(row: Row): JobTask {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    eventId: row.event_id as string | null,
    type: row.type as JobTask['type'],
    title: String(row.title),
    startsAt: row.starts_at as string | null,
    dueAt: row.due_at as string | null,
    completedAt: row.completed_at as string | null,
    cancelledAt: row.cancelled_at as string | null,
    createdAt: String(row.created_at),
  };
}

function mapCandidate(row: Row): Candidate {
  return {
    id: String(row.id),
    market: normalizeMarket(row.market),
    source: row.source as Candidate['source'],
    sourceRef: String(row.source_ref),
    company: String(row.company),
    position: String(row.position),
    externalApplicationId: String(row.external_application_id),
    url: String(row.url),
    eventType: row.event_type as Candidate['eventType'],
    title: String(row.title),
    occurredAt: String(row.occurred_at),
    startsAt: row.starts_at as string | null,
    dueAt: row.due_at as string | null,
    evidence: String(row.evidence),
    confidence: Number(row.confidence),
    parsingConfidence:
      row.parsing_confidence == null ? Number(row.confidence) : Number(row.parsing_confidence),
    reviewReason: String(row.review_reason || ''),
    suggestedJobId: row.suggested_job_id as string | null,
    status: row.status as Candidate['status'],
    createdAt: String(row.created_at),
    application: readApplication(row.application_json),
  };
}
