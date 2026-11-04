import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoServer } from '../src/server/demo.js';
import { seedDemoData, DEMO_TARGET_ID, DEMO_AMBIGUOUS_ID } from '../src/server/demo-data.js';
import { calculateAnalytics } from '../src/server/analytics.js';
import { createServer } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import { GoalService } from '../src/server/goals.js';
import {
  saveMailCredential,
  readMailCredential,
  deleteMailCredential,
} from '../src/server/keychain.js';

vi.mock('../src/server/keychain.js', () => ({
  saveMailCredential: vi.fn(),
  readMailCredential: vi.fn(),
  deleteMailCredential: vi.fn(),
}));

const now = new Date('2026-11-04T18:00:00Z');
let fixture: string;
let demo: Awaited<ReturnType<typeof createDemoServer>>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  vi.clearAllMocks();
  fixture = await mkdtemp(join(tmpdir(), 'campus-demo-web-test-'));
  await writeFile(
    join(fixture, 'index.html'),
    '<!doctype html><html><body><main>Test workspace</main></body></html>',
  );
  demo = await createDemoServer({ now, webRoot: fixture });
});
afterEach(async () => {
  await demo?.close();
  await rm(fixture, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('isolated synthetic demonstration', () => {
  it('ignores inherited production database and migration paths in a fresh process', async () => {
    const production = join(fixture, 'production-sentinel.sqlite');
    const migration = join(fixture, 'private-migration-sentinel.json');
    await writeFile(production, 'untouched production sentinel');
    await writeFile(migration, 'not a migration file');
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `const { createDemoServer } = await import('./src/server/demo.ts');
       const demo = await createDemoServer({ webRoot: ${JSON.stringify(fixture)} });
       console.log(JSON.stringify({ count: demo.store.listJobs('cn').length, directory: demo.directory }));
       await demo.close();`,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          CAMPUS_DB_PATH: production,
          CAMPUS_LEGACY_DATA_PATH: migration,
        },
      },
    );
    const result = JSON.parse(output.trim());
    expect(result.count).toBe(20);
    expect(existsSync(result.directory)).toBe(false);
    expect(await readFile(production, 'utf8')).toBe('untouched production sentinel');
    expect(await readFile(migration, 'utf8')).toBe('not a migration file');
  });
  it('seeds twenty applications per market, goals and no configured mailbox', () => {
    expect(demo.store.listJobs('cn')).toHaveLength(20);
    expect(demo.store.listJobs('us')).toHaveLength(20);
    expect(demo.mail.configured()).toBe(false);
    expect(demo.store.getSetting('mail_address')).toBeUndefined();
    const before = demo.store.listJobs('cn');
    seedDemoData(demo.store, 'http://127.0.0.1:43112', now);
    expect(demo.store.listJobs('cn')).toEqual(before);
    expect(
      new GoalService(demo.store).summary('America/Chicago', now.toISOString()).modules[0].week
        .target,
    ).toBe(12);
  });

  it('calculates known synthetic cohort results without mixing markets', () => {
    for (const market of ['cn', 'us'] as const) {
      const analytics = calculateAnalytics(demo.store.listJobs(market), {
        timezone: 'America/Chicago',
        asOf: now.toISOString(),
      });
      expect(analytics.cohortIds).toHaveLength(20);
      expect(analytics.missingDateIds).toHaveLength(1);
      expect(analytics.metrics.find((item) => item.key === 'offer')).toMatchObject({
        numerator: 2,
        denominator: 20,
        rate: 0.1,
      });
      expect(analytics.metrics.find((item) => item.key === 'feedback')).toMatchObject({
        numerator: 15,
        denominator: 20,
        rate: 0.75,
      });
    }
  });

  it('passes the fictional assessment through the real parser, matcher and task pipeline', async () => {
    const response = await demo.app.inject({ method: 'POST', url: '/demo/scenarios/assessment' });
    expect(response.statusCode).toBe(200);
    expect(response.json().autoApplied).toBe(true);
    const job = demo.store.getJob(DEMO_TARGET_ID)!;
    expect(job.status).toBe('测评中');
    expect(job.events.filter((item) => item.type === 'assessment')).toHaveLength(1);
    expect(job.tasks).toHaveLength(1);
    expect(Date.parse(job.tasks[0].dueAt!)).toBe(now.getTime() + 72 * 3600_000);
    expect(
      demo.store
        .listJobs('us')
        .every((item) =>
          item.events.every((event) => !event.dedupeKey.includes('demo-assessment-001')),
        ),
    ).toBe(true);
  });

  it('replaying the same message does not add events, tasks or applications', async () => {
    await demo.app.inject({ method: 'POST', url: '/demo/scenarios/assessment' });
    const before = demo.store.getJob(DEMO_TARGET_ID)!;
    const response = await demo.app.inject({ method: 'POST', url: '/demo/scenarios/replay' });
    expect(response.statusCode).toBe(200);
    expect(demo.store.getJob(DEMO_TARGET_ID)!.events).toHaveLength(before.events.length);
    expect(demo.store.getJob(DEMO_TARGET_ID)!.tasks).toHaveLength(before.tasks.length);
    expect(demo.store.listJobs('cn')).toHaveLength(20);
  });

  it('keeps ambiguous evidence pending until a person chooses the application', async () => {
    const response = await demo.app.inject({ method: 'POST', url: '/demo/scenarios/ambiguous' });
    expect(response.statusCode).toBe(200);
    const candidate = response.json().candidate;
    expect(response.json().autoApplied).toBe(false);
    expect(candidate.status).toBe('pending');
    expect(candidate.reviewReason).not.toBe('');
    demo.candidateService.apply(candidate.id, DEMO_AMBIGUOUS_ID);
    expect(demo.store.getJob(DEMO_AMBIGUOUS_ID)!.tasks).toHaveLength(1);
    expect(demo.store.listJobs('cn')).toHaveLength(20);
  });

  it('blocks email and desktop notification entrypoints before credentials are touched', async () => {
    for (const [method, url] of [
      ['POST', '/api/v1/email/configure'],
      ['DELETE', '/api/v1/email/configure'],
      ['POST', '/api/v1/email/sync'],
      ['POST', '/api/v1/reminders/test-desktop'],
    ] as const) {
      const response = await demo.app.inject({
        method,
        url,
        payload: { address: 'demo@example.com', authorizationCode: 'fixture-only' },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(saveMailCredential).not.toHaveBeenCalled();
    expect(readMailCredential).not.toHaveBeenCalled();
    expect(deleteMailCredential).not.toHaveBeenCalled();
  });

  it('serves a clearly labelled dashboard, controls and fictional status pages', async () => {
    const dashboard = await demo.app.inject('/');
    expect(dashboard.body).toContain('Synthetic demo data');
    expect((await demo.app.inject('/demo')).body).toContain('Explore the application lifecycle');
    const page = await demo.app.inject(`/demo/application/${DEMO_TARGET_ID}`);
    expect(page.body).toContain('星桥演示科技');
    expect(page.body).toContain('not an employer website');
    expect((await demo.app.inject('/demo/application/missing')).statusCode).toBe(404);
  });

  it('cleans the temporary database and is safe to close twice', async () => {
    const directory = demo.directory;
    expect(existsSync(join(directory, 'demo.sqlite'))).toBe(true);
    await demo.close();
    expect(existsSync(directory)).toBe(false);
    await demo.close();
  });

  it('rejects invalid scenarios and replay before any assessment was processed', async () => {
    expect(
      (await demo.app.inject({ method: 'POST', url: '/demo/scenarios/missing' })).statusCode,
    ).toBe(400);
    expect(
      (await demo.app.inject({ method: 'POST', url: '/demo/scenarios/replay' })).statusCode,
    ).toBe(400);
    expect(demo.store.getJob(DEMO_TARGET_ID)!.tasks).toHaveLength(0);
  });

  it('requires an injected store in demo mode and leaves production routes unchanged', async () => {
    await expect(createServer({ demoMode: true })).rejects.toThrow('isolated store');
    const store = new Store(join(fixture, 'production-test.sqlite'), { legacyDataPath: null });
    const normal = await createServer({ store, startMail: false, webRoot: fixture });
    try {
      expect(normal.app.hasRoute({ method: 'POST', url: '/demo/scenarios/:scenario' })).toBe(false);
      expect(store.listJobs()).toHaveLength(0);
      expect((await normal.app.inject('/')).body).not.toContain('Synthetic demo data');
    } finally {
      await normal.app.close();
    }
  });
});
