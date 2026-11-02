import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import { CandidateService } from '../src/server/candidates.js';
import type { Job, Market } from '../src/shared/types.js';

let dir: string, store: Store, server: Awaited<ReturnType<typeof createServer>>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'campus-markets-'));
  store = new Store(join(dir, 'test.sqlite'));
  store.db.exec(
    'DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM events; DELETE FROM candidates; DELETE FROM jobs;',
  );
  store.setSetting('extension_token', 'test-token');
  server = await createServer({ store, startMail: false });
});
afterEach(async () => {
  await server.app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('国内秋招与美国求职模块', () => {
  it('新增、读取、编辑、删除和持久化均按模块隔离', async () => {
    const create = async (market: Market) =>
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/v1/jobs?market=${market}`,
          payload: { company: 'Acme', position: 'Data Analyst', status: '已投递' },
        })
      ).json<Job>();
    const cn = await create('cn'),
      us = await create('us');
    expect(cn.market).toBe('cn');
    expect(us.market).toBe('us');
    expect((await server.app.inject('/api/v1/jobs')).json()).toMatchObject([{ id: cn.id }]);
    expect((await server.app.inject('/api/v1/jobs?market=us')).json()).toMatchObject([
      { id: us.id },
    ]);
    expect((await server.app.inject(`/api/v1/jobs/${cn.id}?market=us`)).statusCode).toBe(404);
    expect(
      (
        await server.app.inject({
          method: 'PUT',
          url: `/api/v1/jobs/${us.id}?market=us`,
          payload: { company: 'Acme', position: 'Data Analyst II', status: '面试中' },
        })
      ).statusCode,
    ).toBe(200);
    expect(store.getJob(cn.id)).toMatchObject({ status: '已投递', position: 'Data Analyst' });
    expect(store.getJob(us.id)).toMatchObject({ status: '面试中', position: 'Data Analyst II' });
    const reopened = new Store(join(dir, 'test.sqlite'));
    expect(reopened.listJobs('us')).toMatchObject([{ id: us.id, market: 'us' }]);
    reopened.close();
    expect(
      (await server.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${us.id}` })).statusCode,
    ).toBe(404);
    expect(
      (await server.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${us.id}?market=us` }))
        .statusCode,
    ).toBe(200);
    expect(store.listJobs('us')).toHaveLength(0);
    expect(store.listJobs()).toHaveLength(1);
  });

  it('相同网站申请编号与去重键可分属两地，不跨模块匹配或改状态', () => {
    const service = new CandidateService(store);
    const input = {
      source: 'website' as const,
      sourceRef: 'web:shared',
      company: 'Acme',
      position: 'Data Analyst',
      externalApplicationId: 'ABC123',
      eventType: 'application' as const,
      confidence: 0.99,
    };
    const cn = service.ingest({ ...input, market: 'cn' }),
      us = service.ingest({ ...input, market: 'us' });
    expect(cn.autoApplied).toBe(true);
    expect(us.autoApplied).toBe(true);
    expect(cn.candidate.id).not.toBe(us.candidate.id);
    const cnJob = store.listJobs()[0],
      usJob = store.listJobs('us')[0];
    service.ingest({
      ...input,
      market: 'us',
      sourceRef: 'web:assessment',
      eventType: 'assessment',
    });
    expect(store.getJob(cnJob.id)).toMatchObject({ status: '已投递', tasks: [] });
    expect(store.getJob(usJob.id)?.status).toBe('测评中');
    expect(store.getJob(usJob.id)?.tasks).toHaveLength(1);
    expect(service.ingest({ ...input, market: 'us' }).candidate.id).toBe(us.candidate.id);
    expect(store.listJobs('us')).toHaveLength(1);
  });

  it('待确认、统计和人工确认不会越过模块边界', async () => {
    const cn = store.createJob({ company: 'Acme', position: 'Analyst' });
    const us = store.createJob({ market: 'us', company: 'Acme', position: 'Analyst' });
    const candidate = server.candidateService.ingest({
      market: 'us',
      source: 'email',
      sourceRef: 'mail:low',
      company: 'Acme',
      position: 'Analyst',
      eventType: 'assessment',
      confidence: 0.82,
    }).candidate;
    expect((await server.app.inject('/api/v1/candidates')).json()).toHaveLength(0);
    expect((await server.app.inject('/api/v1/candidates?market=us')).json()).toMatchObject([
      { id: candidate.id },
    ]);
    expect((await server.app.inject('/api/v1/status?market=us')).json().pendingCandidates).toBe(1);
    expect((await server.app.inject('/api/v1/status')).json().pendingCandidates).toBe(0);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/v1/candidates/${candidate.id}/ignore`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/v1/candidates/${candidate.id}/confirm?market=us`,
          payload: { jobId: cn.id },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/v1/candidates/${candidate.id}/confirm?market=us`,
          payload: { jobId: us.id, overrides: { market: 'cn' } },
        })
      ).statusCode,
    ).toBe(200);
    expect(store.getCandidate(candidate.id)).toMatchObject({ market: 'us', status: 'applied' });
    expect(store.getJob(cn.id)?.status).toBe('已投递');
    const task = store.getJob(us.id)!.tasks[0];
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/v1/tasks/${task.id}/complete`,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/v1/tasks/${task.id}/complete?market=us`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(store.getJob(us.id)?.status).toBe('等待结果');
  });

  it('网站自动识别按保存的归属处理，也支持已有岗位的明确归属', async () => {
    expect(
      (
        await server.app.inject({
          method: 'PUT',
          url: '/api/v1/routing',
          payload: { email: 'us', website: 'us' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await server.app.inject('/api/v1/status')).json().routing).toEqual({
      email: 'us',
      website: 'us',
    });
    const input = {
      source: 'website',
      sourceRef: 'web:default-routing',
      company: 'Acme',
      position: 'Data Analyst',
      eventType: 'application',
      confidence: 0.99,
    };
    const post = async (payload: object) =>
      server.app.inject({
        method: 'POST',
        url: '/api/v1/candidates',
        headers: { 'x-campus-token': 'test-token' },
        payload,
      });
    expect((await post(input)).json().candidate.market).toBe('us');
    expect((await post({ ...input, market: 'cn' })).json().candidate.market).toBe('cn');
    expect(store.listJobs('us')).toHaveLength(1);
    expect(store.listJobs()).toHaveLength(1);
    expect(
      (
        await server.app.inject({
          method: 'PUT',
          url: '/api/v1/routing',
          payload: { email: 'invalid', website: 'us' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('导出只包含当前模块，备份不能覆盖其他模块，旧备份可导入美国模块', async () => {
    const cn = store.createJob({ company: '国内公司', position: '数据分析' });
    const us = store.createJob({ market: 'us', company: 'Acme', position: 'Analyst' });
    const exported = (await server.app.inject('/api/v1/export?market=us')).json();
    expect(exported).toMatchObject({
      version: 4,
      market: 'us',
      jobs: [{ id: us.id, market: 'us' }],
    });
    expect(
      (await server.app.inject({ method: 'POST', url: '/api/v1/import', payload: exported }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/v1/import?market=us',
          payload: [{ id: cn.id, company: '错误覆盖', position: '错误' }],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/v1/import?market=us',
          payload: [{ company: '新公司', position: '新岗位' }],
        })
      ).json(),
    ).toMatchObject({ imported: 1 });
    expect(store.getJob(cn.id)?.company).toBe('国内公司');
    expect(store.listJobs('us')).toHaveLength(2);
  });

  it('美国审计与撤销只作用于美国记录', async () => {
    const cn = store.createJob({ company: '国内公司', position: '岗位' });
    const us = store.createJob({ market: 'us', company: 'Acme', position: 'Analyst' });
    const rows = (await server.app.inject('/api/v1/audit?market=us')).json();
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe(us.id);
    expect(
      (await server.app.inject({ method: 'POST', url: `/api/v1/audit/${rows[0].id}/undo` }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/v1/audit/${rows[0].id}/undo?market=us`,
        })
      ).statusCode,
    ).toBe(200);
    expect(store.getJob(us.id)).toBeNull();
    expect(store.getJob(cn.id)).not.toBeNull();
  });

  it('美国记录删除后撤销仍恢复到美国模块', async () => {
    const us = store.createJob({ market: 'us', company: 'Acme', position: 'Analyst' });
    store.deleteJob(us.id);
    const rows = (await server.app.inject('/api/v1/audit?market=us')).json();
    const deletion = rows.find((row: { action: string }) => row.action === 'delete');
    await server.app.inject({ method: 'POST', url: `/api/v1/audit/${deletion.id}/undo?market=us` });
    expect(store.listJobs('us')).toMatchObject([{ id: us.id }]);
    expect(store.listJobs()).toHaveLength(0);
  });
});
