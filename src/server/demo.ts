import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from './app.js';
import { Store } from './db.js';
import { webDistPath } from './paths.js';
import { seedDemoData, runDemoScenario } from './demo-data.js';

function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}

const pageStyles = `
*{box-sizing:border-box}body{margin:0;background:#f7f8fc;color:#28334b;font:15px/1.6 system-ui,sans-serif}
main{max-width:1000px;margin:48px auto;padding:0 28px}h1{font-size:32px;letter-spacing:-1px;margin:12px 0}h2{font-size:18px}
a{color:#6755bc}small,.muted{color:#66728a}.label{font-size:12px;letter-spacing:1.4px;font-weight:800;color:#7560bd}
.card{background:white;border:1px solid #e1e5ef;border-radius:18px;padding:24px;margin:18px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}
button,.link{display:inline-block;border:0;border-radius:9px;background:#7763c4;color:white;padding:12px 18px;cursor:pointer;font:inherit;text-decoration:none}
button:disabled{opacity:.45;cursor:not-allowed}.secondary{background:#edf0f8;color:#394967}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}#result{min-height:90px}.badge{padding:5px 10px;background:#ece8f9;border-radius:8px}
`;

const controlPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic demo · Campus Recruitment Assistant</title><style>${pageStyles}</style><main>
<div class="label">SYNTHETIC DEMO DATA · BUILT WITH VIBE CODING</div><h1>Explore the application lifecycle</h1>
<p>40 fictional applications. Two workspaces. No mailbox or personal records required.</p>
<a class="link" href="/" target="_blank" rel="noopener">Open application dashboard ↗</a>
<div class="card"><h2>1. Plan, track, and review</h2><p>Explore 投递目标 (goals), open a fictional 进度页 (status page), complete a to-do, or compare cohorts in 漏斗与对比 (analytics).</p></div>
<div class="grid">
<section class="card"><h2>2. Receive an assessment</h2><p>A fictional message passes through the real parser and matcher. Its application receives a stage event and a deadline task.</p><button data-scenario="assessment">模拟收到测评通知</button></section>
<section class="card"><h2>3. Replay the same message</h2><p>Replay the identical message ID. It should not create another event or task.</p><button data-scenario="replay">重复处理同一通知</button></section>
<section class="card"><h2>4. Review an ambiguous match</h2><p>Two roles at the same fictional company require a human decision. Open 待确认 to select the right application.</p><button data-scenario="ambiguous">模拟岗位不明确的通知</button></section>
</div><section class="card" aria-live="polite"><h2>Scenario result</h2><div id="result">Choose a scenario, then refresh the application dashboard to see its result.</div></section>
<p class="muted">All records, employers, outcomes and links are fictional. Email configuration, synchronization and system notifications are disabled. Stop and restart the demo to restore the initial data.</p>
<script>
for(const button of document.querySelectorAll('[data-scenario]'))button.addEventListener('click',async()=>{
 button.disabled=true;const output=document.querySelector('#result');output.textContent='Processing synthetic notification…';
 try{const response=await fetch('/demo/scenarios/'+button.dataset.scenario,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const result=await response.json();if(!response.ok)throw new Error(result.error);
 output.textContent=result.scenario==='ambiguous'
  ? result.explanation+'  状态：待确认；尚未写入申请。核对原因：'+result.candidate.reviewReason+'。请打开看板的“待确认”。'
  : result.explanation+'  状态：'+(result.job?.status||'—')+'；目标申请事件：'+(result.job?.events.length||0)+'；待办：'+(result.job?.tasks.length||0)+'。请刷新看板。';}
 catch(error){output.textContent=error.message;}finally{button.disabled=false;}
});
</script></main></html>`;

export async function createDemoServer(
  options: { now?: Date; port?: number; webRoot?: string } = {},
) {
  const now = options.now || new Date();
  const port = options.port ?? 43112;
  const directory = await mkdtemp(join(tmpdir(), 'campus-demo-'));
  let store: Store | undefined;
  try {
    const webRoot = join(directory, 'web');
    await cp(options.webRoot || webDistPath, webRoot, { recursive: true });
    const index = await readFile(join(webRoot, 'index.html'), 'utf8');
    const banner = `<aside style="padding:10px 24px;background:#eae5fa;color:#49377d;font:13px/1.4 system-ui;display:flex;justify-content:space-between;gap:16px;align-items:center"><strong>Synthetic demo data · 40 fictional applications</strong><a href="/demo" style="color:#49377d" target="_blank" rel="noopener">Scenario controls ↗</a></aside>`;
    await writeFile(
      join(webRoot, 'index.html'),
      index.replace(/<body([^>]*)>/i, `<body$1>${banner}`),
    );
    store = new Store(join(directory, 'demo.sqlite'), { legacyDataPath: null });
    seedDemoData(store, `http://127.0.0.1:${port}`, now);
    const server = await createServer({
      store,
      webRoot,
      demoMode: true,
      startMail: false,
      mailOptions: {
        readCredential: async () => {
          throw new Error('Demo mode cannot read credentials');
        },
        createClient: () => {
          throw new Error('Demo mode cannot connect to IMAP');
        },
      },
    });
    server.app.get('/demo', async (_request, reply) => reply.type('text/html').send(controlPage));
    server.app.get<{ Params: { id: string } }>('/demo/application/:id', async (request, reply) => {
      const job = server.store.getJob(request.params.id);
      if (!job) return reply.code(404).send({ error: 'Fictional application not found' });
      return reply
        .type('text/html')
        .send(
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>Fictional application status</title><style>${pageStyles}</style><main><div class="label">SYNTHETIC DEMO DATA</div><h1>${escape(job.company)}</h1><div class="card"><h2>${escape(job.position)}</h2><p>Current stage: <span class="badge">${escape(job.status)}</span></p><p>This is a fictional recruitment status page served only by the local demo. It is not an employer website.</p></div><a href="/?market=${job.market}">← Return to application dashboard</a></main></html>`,
        );
    });
    server.app.post<{ Params: { scenario: string } }>(
      '/demo/scenarios/:scenario',
      async (request, reply) => {
        try {
          return runDemoScenario(
            server.store,
            server.candidateService,
            request.params.scenario,
            now,
          );
        } catch (error) {
          return reply.code(400).send({ error: (error as Error).message });
        }
      },
    );
    let closed = false;
    return {
      ...server,
      directory,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await server.app.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    store?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
