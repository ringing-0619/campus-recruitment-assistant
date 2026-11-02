import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/server/db.js';

const legacyDataPath = fileURLToPath(new URL('./fixtures/legacy-jobs.json', import.meta.url));

describe('空库与旧数据迁移', () => {
  it('首次启动没有个人迁移文件也能创建空库，重复打开保持为空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'campus-empty-'));
    const path = join(dir, 'db.sqlite');
    try {
      let store = new Store(path, { legacyDataPath: null });
      expect(store.listJobs()).toEqual([]);
      expect(store.listJobs('us')).toEqual([]);
      store.close();
      store = new Store(path, { legacyDataPath: null });
      expect(store.listJobs()).toEqual([]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('旧库新增模块字段后原数据归国内，美国为空，重复打开不重复迁移', () => {
    const dir = mkdtempSync(join(tmpdir(), 'campus-market-migration-'));
    const path = join(dir, 'db.sqlite');
    let store = new Store(path, { legacyDataPath });
    const before = store.listJobs();
    for (const table of ['jobs', 'candidates', 'audit_log']) {
      store.db.exec(`DROP INDEX idx_${table}_market; ALTER TABLE ${table} DROP COLUMN market;`);
    }
    store.close();
    store = new Store(path);
    expect(store.listJobs()).toEqual(before);
    expect(store.listJobs('us')).toHaveLength(0);
    store.createJob({ market: 'us', company: 'Acme', position: 'Data Analyst' });
    store.close();
    store = new Store(path);
    expect(store.listJobs()).toHaveLength(3);
    expect(store.listJobs('us')).toHaveLength(1);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('显式指定的脱敏旧数据只导入一次', () => {
    const dir = mkdtempSync(join(tmpdir(), 'campus-migration-'));
    const path = join(dir, 'db.sqlite');
    let store = new Store(path, { legacyDataPath });
    expect(store.listJobs()).toHaveLength(3);
    store.close();
    store = new Store(path, { legacyDataPath });
    expect(store.listJobs()).toHaveLength(3);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('指定无效迁移文件时报告错误，不偷偷导入本地个人文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'campus-invalid-migration-'));
    try {
      expect(
        () => new Store(join(dir, 'db.sqlite'), { legacyDataPath: join(dir, 'missing.json') }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('备份来自当前数据库且保存在其旁边，不读取默认个人数据库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'campus-isolated-backup-'));
    const store = new Store(join(dir, 'custom.sqlite'), { legacyDataPath: null });
    try {
      store.createJob({ company: '示例科技', position: '测试岗位' });
      store.backupIfDue();
      const backups = readdirSync(join(dir, 'backups'));
      expect(backups).toHaveLength(1);
      const backup = new Store(join(dir, 'backups', backups[0]), { legacyDataPath: null });
      expect(backup.listJobs()).toMatchObject([{ company: '示例科技', position: '测试岗位' }]);
      backup.close();
      store.backupIfDue();
      expect(readdirSync(join(dir, 'backups'))).toEqual(backups);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
