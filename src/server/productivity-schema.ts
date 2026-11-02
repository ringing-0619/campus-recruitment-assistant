import type { DatabaseSync } from 'node:sqlite';

export function migrateProductivity(db: DatabaseSync) {
  db.exec('BEGIN');
  try {
    const add = (table: string, name: string, definition: string) => {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((column) => column.name === name))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    };
    add('jobs', 'application_json', "TEXT NOT NULL DEFAULT '{}'");
    add('candidates', 'application_json', "TEXT NOT NULL DEFAULT '{}'");
    add('events', 'round_label', "TEXT NOT NULL DEFAULT ''");
    add('events', 'outcome', "TEXT NOT NULL DEFAULT 'unknown'");
    add('events', 'result_at', 'TEXT');
    add('tasks', 'cancelled_at', 'TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS goal_rules (
      market TEXT NOT NULL, kind TEXT NOT NULL, effective_on TEXT NOT NULL, config_json TEXT NOT NULL,
      PRIMARY KEY(market,kind,effective_on)
    );
    CREATE TABLE IF NOT EXISTS goal_overrides (
      market TEXT NOT NULL, kind TEXT NOT NULL, period_start TEXT NOT NULL, target INTEGER,
      PRIMARY KEY(market,kind,period_start)
    );
    CREATE TABLE IF NOT EXISTS reminder_state (
      key TEXT PRIMARY KEY, market TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      snoozed_until TEXT, dismissed_at TEXT, desktop_sent_at TEXT, last_error TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO settings(key,value) VALUES('desktop_features_schema','1') ON CONFLICT(key) DO UPDATE SET value='1';`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
