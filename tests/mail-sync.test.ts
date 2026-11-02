import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImapFlow } from 'imapflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server/app.js';
import { CandidateService } from '../src/server/candidates.js';
import { Store } from '../src/server/db.js';
import { MAIL_RULES_VERSION, MailSyncService, safeError } from '../src/server/mail.js';
import {
  asiainfoApplication,
  dewuApplication,
  huabaoApplication,
  kpmgAssessments,
  yonyouAssessment,
} from './fixtures/recruitment-mails.js';

class FakeImapClient extends EventEmitter {
  constructor(private readonly connectResult: () => Promise<void>) {
    super();
  }
  connect() {
    return this.connectResult();
  }
  async mailboxOpen() {
    return { uidValidity: 1n };
  }
  async search() {
    return [] as number[];
  }
  async fetchOne() {
    return false;
  }
  async logout() {
    /* no-op */
  }
}

function dnsError() {
  return Object.assign(new Error('getaddrinfo ENOTFOUND imap.126.com'), {
    code: 'ENOTFOUND',
    syscall: 'getaddrinfo',
    hostname: 'imap.126.com',
  });
}

function temporaryStore() {
  const directory = mkdtempSync(join(tmpdir(), 'campus-mail-sync-'));
  const store = new Store(join(directory, 'db.sqlite'));
  store.setSetting('mail_address', 'student@126.com');
  return { store, directory };
}

function messageClient(
  messages: Array<{ subject: string; text: string; messageId: string; receivedAt?: Date }>,
) {
  const client = new FakeImapClient(async () => undefined);
  const search = vi.fn(async (query: { uid?: string }) =>
    messages
      .map((_, i) => i + 1)
      .filter((uid) => !query.uid || uid >= Number(query.uid.split(':')[0])),
  );
  const fetchOne = vi.fn(async (uid: number, query: { source?: boolean }) => {
    const message = messages[uid - 1];
    if (!message) return false;
    if (!query.source)
      return {
        uid,
        size: 1024,
        envelope: {
          subject: message.subject,
          messageId: `<${message.messageId}@example.com>`,
          date: message.receivedAt || new Date('2026-10-30T10:00:00Z'),
          from: [{ name: '校园招聘', address: 'notice@shmail.ibeisen.com' }],
        },
      };
    return {
      uid,
      source: Buffer.from(
        [
          `Message-ID: <${message.messageId}@example.com>`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from(message.text).toString('base64'),
        ].join('\r\n'),
      ),
    };
  });
  Object.assign(client, { search, fetchOne });
  return { client, search, fetchOne };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('126 邮箱容错同步', () => {
  it('规则升级重解析把重要误作公司且日期错误的用友待确认，保留原模块和候选ID并自动写入唯一岗位', async () => {
    const { store, directory } = temporaryStore();
    store.db.exec(
      'DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM events; DELETE FROM candidates; DELETE FROM jobs;',
    );
    const job = store.createJob({
      market: 'cn',
      company: '用友',
      position: '售前解决方案管培生-江苏区',
      status: '已投递',
    });
    const service = new CandidateService(store);
    const original = service.ingest({
      source: 'email',
      sourceRef: 'mail:<yonyou-assessment@example.com>',
      market: 'cn',
      company: '重要',
      position: '',
      eventType: 'assessment',
      confidence: 0.95,
      startsAt: '2026-11-03T05:59:00Z',
    });
    store.setSetting('mail_rules_version', '2026-11-01-application-receipt-v4');
    store.setSetting('mail_last_uid', '100');
    store.setSetting('mail_uid_validity', '1');
    store.setSetting('mail_market', 'us');
    const { client, search } = messageClient([yonyouAssessment]);
    const mail = new MailSyncService(store, service, {
      readCredential: async () => 'test',
      createClient: () => client as unknown as ImapFlow,
    });
    try {
      await expect(mail.sync()).resolves.toMatchObject({ processed: 1 });
      expect(search.mock.calls[0][0]).toHaveProperty('since');
      expect(store.getCandidate(original.candidate.id)).toMatchObject({
        id: original.candidate.id,
        market: 'cn',
        company: '用友集团',
        position: job.position,
        status: 'applied',
        startsAt: null,
        dueAt: '2026-10-04T09:00:00.000Z',
      });
      expect(store.getJob(job.id)).toMatchObject({
        status: '测评中',
        tasks: [{ type: 'assessment', startsAt: null, dueAt: '2026-10-04T09:00:00.000Z' }],
      });
      expect(store.listCandidates('pending', 'cn')).toHaveLength(0);
      expect(store.listJobs('us')).toHaveLength(0);
      await mail.sync();
      expect(search.mock.calls[1][0]).toEqual({ uid: '101:*' });
      expect(store.getJob(job.id)?.tasks).toHaveLength(1);
      expect(store.getJob(job.id)?.events).toHaveLength(1);
    } finally {
      mail.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('升级后重新找回游标前的亚信回执，缺失岗位进入待确认，完整岗位自动建档并保持幂等', async () => {
    const { store, directory } = temporaryStore();
    store.db.exec(
      'DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM events; DELETE FROM candidates; DELETE FROM jobs;',
    );
    store.setSetting('mail_rules_version', '2026-10-30-progress-v3');
    store.setSetting('mail_last_uid', '100');
    store.setSetting('mail_uid_validity', '1');
    const messages = [{ ...asiainfoApplication }];
    const { client, search } = messageClient(messages);
    const service = new CandidateService(store);
    const mail = new MailSyncService(store, service, {
      readCredential: async () => 'test',
      createClient: () => client as unknown as ImapFlow,
    });
    try {
      await expect(mail.sync()).resolves.toMatchObject({ processed: 1 });
      expect(search.mock.calls[0][0]).toHaveProperty('since');
      expect(store.listJobs()).toHaveLength(0);
      expect(store.listCandidates()).toMatchObject([
        {
          company: '亚信科技',
          position: '',
          eventType: 'application',
          reviewReason: '投递回执缺少明确岗位，不能据此新建或合并申请',
        },
      ]);
      messages[0].text = asiainfoApplication.text.replace(
        '感谢您应聘本公司。',
        '感谢您应聘本公司。岗位：数据分析师。',
      );
      store.setSetting('mail_rules_version', '2026-10-30-progress-v3');
      await mail.sync();
      expect(store.listCandidates()).toHaveLength(0);
      expect(store.listJobs()).toMatchObject([
        {
          company: '亚信科技',
          position: '数据分析师',
          status: '已投递',
          events: [{ source: 'email', type: 'application' }],
        },
      ]);
      await mail.sync();
      expect(store.listJobs()).toHaveLength(1);
      expect(store.listJobs()[0].events).toHaveLength(1);
    } finally {
      mail.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('广告与无进度邮件不创建待确认；规则升级会清理旧误收待确认', async () => {
    const { store, directory } = temporaryStore();
    const service = new CandidateService(store);
    const stale = service.ingest({
      source: 'email',
      sourceRef: 'mail:<ad@example.com>',
      company: '星河科技',
      eventType: 'other',
      title: 'AI面试训练营限时优惠',
      confidence: 0.5,
    });
    const { client, fetchOne } = messageClient([
      { subject: 'AI面试训练营限时优惠', text: '立即购买AI面试课程', messageId: 'ad' },
      { subject: '候选人服务说明', text: '欢迎了解面试和测评流程', messageId: 'help' },
    ]);
    const mail = new MailSyncService(store, service, {
      readCredential: async () => 'test',
      createClient: () => client as unknown as ImapFlow,
    });
    try {
      await expect(mail.sync()).resolves.toMatchObject({ processed: 0 });
      expect(store.getCandidate(stale.candidate.id)?.status).toBe('ignored');
      expect(store.listCandidates()).toHaveLength(0);
      expect(fetchOne.mock.calls.filter(([uid, query]) => uid === 1 && query.source)).toHaveLength(
        0,
      );
    } finally {
      mail.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('规则升级回溯旧邮件并保留原模块，完成后恢复增量同步', async () => {
    const { store, directory } = temporaryStore();
    store.db.exec(
      'DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM events; DELETE FROM candidates; DELETE FROM jobs;',
    );
    const service = new CandidateService(store);
    const job = store.createJob({ market: 'cn', company: '星河科技', position: '数据分析师' });
    const original = service.ingest({
      source: 'email',
      sourceRef: 'mail:<upgrade@example.com>',
      company: '星河科技',
      eventType: 'ai_assessment',
      confidence: 0.82,
    });
    store.setSetting('mail_last_uid', '100');
    store.setSetting('mail_uid_validity', '1');
    store.setSetting('mail_market', 'us');
    const { client, search } = messageClient([
      { subject: '【星河科技】AI测评邀请', text: '请完成AI测评。', messageId: 'upgrade' },
    ]);
    const mail = new MailSyncService(store, service, {
      readCredential: async () => 'test',
      createClient: () => client as unknown as ImapFlow,
    });
    try {
      await mail.sync();
      expect(search.mock.calls[0][0]).toHaveProperty('since');
      expect(store.getCandidate(original.candidate.id)).toMatchObject({
        market: 'cn',
        status: 'applied',
      });
      expect(store.getJob(job.id)?.status).toBe('AI测评中');
      expect(store.listCandidates('applied', 'us')).toHaveLength(0);
      expect(store.getSetting('mail_rules_version')).toBe(MAIL_RULES_VERSION);
      await mail.sync();
      expect(search.mock.calls[1][0]).toEqual({ uid: '101:*' });
      expect(store.getJob(job.id)?.events).toHaveLength(1);
    } finally {
      mail.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('投递回执晚于测评被读取时，同一轮同步仍自动关联测评', async () => {
    const { store, directory } = temporaryStore();
    store.db.exec(
      'DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM events; DELETE FROM candidates; DELETE FROM jobs;',
    );
    const { client } = messageClient([
      {
        subject: '【星河科技】AI测评邀请',
        text: '请完成AI测评。',
        messageId: 'assessment-first',
        receivedAt: new Date('2026-10-30T10:00:00Z'),
      },
      {
        subject: '【星河科技】投递成功',
        text: '感谢您投递，岗位：数据分析师。',
        messageId: 'application-second',
        receivedAt: new Date('2026-10-30T09:00:00Z'),
      },
    ]);
    const mail = new MailSyncService(store, new CandidateService(store), {
      readCredential: async () => 'test',
      createClient: () => client as unknown as ImapFlow,
    });
    try {
      await expect(mail.sync()).resolves.toMatchObject({ processed: 2 });
      expect(store.listCandidates()).toHaveLength(0);
      expect(store.listJobs()).toMatchObject([
        {
          company: '星河科技',
          position: '数据分析师',
          status: 'AI测评中',
          events: [{}, {}],
          tasks: [{ type: 'ai_assessment' }],
        },
      ]);
    } finally {
      mail.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('正文下载失败不越过该邮件游标，下一轮会重新下载并自动应用', async () => {
    const { store, directory } = temporaryStore();
    store.setSetting('mail_rules_version', MAIL_RULES_VERSION);
    store.setSetting('mail_last_uid', '1');
    store.setSetting('mail_uid_validity', '1');
    const job = store.createJob({ company: '星河科技', position: '数据分析师' });
    const { client, fetchOne, search } = messageClient([
      { subject: '已处理', text: '', messageId: 'old' },
      {
        subject: '【星河科技】AI测评邀请',
        text: '岗位：数据分析师。请完成AI测评。',
        messageId: 'retry',
      },
    ]);
    const originalFetch = fetchOne.getMockImplementation()!;
    fetchOne.mockImplementation(async (uid, query) =>
      query.source ? false : originalFetch(uid, query),
    );
    const mail = new MailSyncService(store, new CandidateService(store), {
      readCredential: async () => 'test',
      createClient: () => client as unknown as ImapFlow,
    });
    try {
      await expect(mail.sync()).rejects.toThrow('正文下载未完成');
      expect(store.getSetting('mail_last_uid')).toBe('1');
      fetchOne.mockImplementation(originalFetch);
      await mail.sync();
      expect(search.mock.calls.map(([query]) => query)).toEqual([{ uid: '2:*' }, { uid: '2:*' }]);
      expect(store.getSetting('mail_last_uid')).toBe('2');
      expect(store.getJob(job.id)?.status).toBe('AI测评中');
    } finally {
      mail.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['cn', 'us'] as const)(
    '同步到 %s 模块时自动关联华宝、毕马威和得物且不跨模块',
    async (market) => {
      const { store, directory } = temporaryStore();
      store.db.exec(
        'DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM events; DELETE FROM candidates; DELETE FROM jobs;',
      );
      store.setSetting('mail_market', market);
      const huabao = store.createJob({
        market,
        company: '华宝新能',
        position: '研发管培生',
        status: '面试中',
      });
      const kpmg = store.createJob({
        market,
        company: '毕马威',
        position: '咨询顾问',
        status: '已投递',
      });
      const messages = [huabaoApplication, ...kpmgAssessments, dewuApplication];
      const client = new FakeImapClient(async () => undefined);
      const fetchOne = vi.fn(async (uid: number, query: { source?: boolean }) => {
        const message = messages[uid - 1];
        if (!query.source)
          return {
            uid,
            size: 1024,
            envelope: {
              subject: message.subject,
              date: message.receivedAt,
              from: [{ name: '校园招聘', address: 'notice@shmail.ibeisen.com' }],
            },
          };
        return {
          uid,
          source: Buffer.from(
            [
              `Message-ID: <${message.messageId}@example.com>`,
              'MIME-Version: 1.0',
              'Content-Type: text/plain; charset=utf-8',
              'Content-Transfer-Encoding: base64',
              '',
              Buffer.from(message.text).toString('base64'),
            ].join('\r\n'),
          ),
        };
      });
      Object.assign(client, { search: async () => [1, 2, 3, 4], fetchOne });
      const mail = new MailSyncService(store, new CandidateService(store), {
        readCredential: async () => 'test-credential',
        createClient: () => client as unknown as ImapFlow,
      });
      try {
        await expect(mail.sync()).resolves.toMatchObject({ processed: 4 });
        expect(store.listCandidates('pending', market)).toHaveLength(0);
        expect(store.listCandidates('applied', market)).toHaveLength(4);
        expect(store.getJob(huabao.id)).toMatchObject({
          status: '面试中',
          events: [{}],
          tasks: [],
        });
        expect(store.getJob(kpmg.id)).toMatchObject({
          status: '测评中',
          events: [{}, {}],
          tasks: [{}, {}],
        });
        expect(store.listJobs(market)).toHaveLength(3);
        expect(store.listJobs(market === 'us' ? 'cn' : 'us')).toHaveLength(0);
        expect(store.getSetting('mail_last_uid')).toBe('4');
        await mail.sync();
        expect(store.listCandidates('pending', market)).toHaveLength(0);
        expect(store.listCandidates('applied', market)).toHaveLength(4);
        expect(store.listJobs(market).find((job) => job.company === '得物')?.events).toHaveLength(
          1,
        );
      } finally {
        mail.stop();
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('DNS 错误会生成可读状态，并按 30s、60s 指数退避重试', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T10:00:00.000Z'));
    const { store, directory } = temporaryStore();
    const clients: FakeImapClient[] = [];
    const backgroundErrors: string[] = [];
    const mail = new MailSyncService(store, new CandidateService(store), {
      readCredential: async () => 'abcdefghijklmnop',
      createClient: () => {
        const client = new FakeImapClient(async () => {
          throw dnsError();
        });
        clients.push(client);
        return client as unknown as ImapFlow;
      },
      onBackgroundError: (message) => backgroundErrors.push(message),
    });

    mail.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(clients).toHaveLength(1);
    expect(mail.status()).toMatchObject({
      connected: false,
      retryAttempt: 1,
      nextRetryAt: '2026-09-23T10:00:32.000Z',
    });
    expect(mail.status().lastError).toContain('DNS/网络错误');
    expect(backgroundErrors).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(clients).toHaveLength(2);
    expect(mail.status()).toMatchObject({
      retryAttempt: 2,
      nextRetryAt: '2026-09-23T10:01:32.000Z',
    });
    expect(backgroundErrors).toHaveLength(2);

    mail.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('IMAP 在连接完成后发出 error 事件也不会抛出未处理异常', async () => {
    const { store, directory } = temporaryStore();
    const client = new FakeImapClient(async () => undefined);
    const mail = new MailSyncService(store, new CandidateService(store), {
      readCredential: async () => 'abcdefghijklmnop',
      createClient: () => client as unknown as ImapFlow,
    });

    await expect(mail.sync()).resolves.toMatchObject({ skipped: false, processed: 0 });
    expect(() =>
      client.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })),
    ).not.toThrow();
    expect(mail.status()).toMatchObject({ connected: false, retryAttempt: 0 });
    expect(mail.status().lastError).toContain('连接网易邮箱服务器失败');

    mail.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('后台 DNS 同步失败后，静态网页、健康检查和本地 API 仍然可用', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'));
    const { store, directory } = temporaryStore();
    const webRoot = join(directory, 'web');
    mkdirSync(webRoot);
    writeFileSync(
      join(webRoot, 'index.html'),
      '<!doctype html><title>校招进度助手测试页面</title>',
    );
    const { app, mail } = await createServer({
      store,
      webRoot,
      mailOptions: {
        initialDelayMs: 1,
        readCredential: async () => 'abcdefghijklmnop',
        createClient: () =>
          new FakeImapClient(async () => {
            throw dnsError();
          }) as unknown as ImapFlow,
      },
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(mail.status().lastError).toContain('DNS/网络错误');

    const [page, health, jobs, status] = await Promise.all([
      app.inject({ method: 'GET', url: '/' }),
      app.inject({ method: 'GET', url: '/api/v1/health' }),
      app.inject({ method: 'GET', url: '/api/v1/jobs' }),
      app.inject({ method: 'GET', url: '/api/v1/status' }),
    ]);

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });
    expect(jobs.statusCode).toBe(200);
    expect(Array.isArray(jobs.json())).toBe(true);
    expect(status.statusCode).toBe(200);
    expect(status.json().email).toMatchObject({ retryAttempt: 1 });
    expect(status.json().email.lastError).toContain('DNS/网络错误');

    const manualSync = await app.inject({ method: 'POST', url: '/api/v1/email/sync' });
    expect(manualSync.statusCode).toBe(502);
    expect(manualSync.json().error).toContain('DNS/网络错误');

    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('ENOTFOUND 不再直接暴露为难懂的底层错误', () => {
    expect(safeError(dnsError())).toBe(
      '无法解析网易邮箱服务器地址（DNS/网络错误），请检查网络或 DNS 设置。',
    );
  });
});
