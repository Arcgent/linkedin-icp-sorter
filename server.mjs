import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadRecords, loadPeople, loadRun, listRuns, summarizeRun, loadLabels, saveLabel, appendSingle } from './lib/store.mjs';
import { loadSetup, saveSetup, requestFor, DEFAULT_SETUP } from './lib/setup.mjs';
import { judgeOne, runBatch, retryFailed } from './lib/runner.mjs';
import { jevConfig } from './lib/jev.mjs';

const PORT = Number(process.env.PORT || 3161);
const PUBLIC = path.join(ROOT, 'public');

// ---------- helpers ----------
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 2e6) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});

function row(rec, { run, names, labels } = {}) {
  const out = { id: rec.id, connected_on: rec.connected_on, engaged: rec.engaged, state: rec.state };
  if (names) Object.assign(out, loadPeople()[rec.id] || {});
  const r = run?.byId.get(rec.id);
  if (r) Object.assign(out, { bucket: r.bucket, confidence: r.confidence, p: r.p, error: r.error });
  if (labels?.[rec.id]) out.my_label = labels[rec.id].bucket;
  return out;
}

const BANDS = [[0.95, 1.01, '95-100%'], [0.9, 0.95, '90-95%'], [0.8, 0.9, '80-90%'], [0.6, 0.8, '60-80%'], [0, 0.6, 'below 60%']];

function checkStats(run) {
  const labels = loadLabels();
  const rows = Object.entries(labels).map(([id, l]) => ({ id, mine: l.bucket, r: run.byId.get(id) })).filter((x) => x.r?.bucket);
  const match = rows.filter((x) => x.mine === x.r.bucket).length;
  const bands = BANDS.map(([lo, hi, name]) => {
    const inBand = rows.filter((x) => x.r.confidence >= lo && x.r.confidence < hi);
    return { name, n: inBand.length, match: inBand.filter((x) => x.mine === x.r.bucket).length };
  });
  // Lowest confidence line where every checked answer at or above it matched your label.
  let suggestion = null;
  for (let t = 0.99; t >= 0.5 - 1e-9; t -= 0.01) {
    const above = rows.filter((x) => x.r.confidence >= t - 1e-9);
    if (!above.length) continue;
    if (above.some((x) => x.mine !== x.r.bucket)) break;
    suggestion = { threshold: Math.round(t * 100) / 100, checked_above: above.length };
  }
  if (suggestion) suggestion.run_share = run.results.filter((r) => r.confidence >= suggestion.threshold - 1e-9).length / run.results.length;
  const confusion = {};
  for (const x of rows) { const k = `${x.mine}>${x.r.bucket}`; confusion[k] = (confusion[k] || 0) + 1; }
  return { labeled: rows.length, match, rate: rows.length ? match / rows.length : null, bands, suggestion, confusion };
}

function nextToCheck(run) {
  const labels = loadLabels();
  const per = Object.fromEntries(run.bucket_keys.map((k) => [k, 0]));
  for (const id of Object.keys(labels)) { const b = run.byId.get(id)?.bucket; if (b in per) per[b]++; }
  const order = run.bucket_keys.filter((k) => run.counts[k] > 0).sort((a, b) => per[a] - per[b]);
  for (const bucket of order) {
    const pool = run.results.filter((r) => r.bucket === bucket && !labels[r.id]);
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)].id;
  }
  return null;
}

function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

// ---------- batch job (one at a time, progress over SSE) ----------
let job = null;
function startJob(total, work) {
  if (job && !job.finished) throw new Error('A run is already in progress');
  const ctrl = new AbortController();
  job = { finished: false, listeners: new Set(), last: { event: 'progress', data: { done: 0, total, cost: 0, elapsed_ms: 0, counts: {}, errors: 0 } }, abort: () => ctrl.abort() };
  const emit = (event, data) => { job.last = { event, data }; for (const l of job.listeners) l(event, data); };
  work({ signal: ctrl.signal, onProgress: (p) => emit('progress', p) })
    .then((run) => emit('done', summarizeRun(run)))
    .catch((e) => emit('error', { message: e.message }))
    .finally(() => { job.finished = true; });
  return job;
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), 'text/html; charset=utf-8');

    if (p === '/api/state') {
      const { meta } = loadRecords();
      const cfg = jevConfig();
      return send(res, 200, { meta, setup: loadSetup(), default_setup: DEFAULT_SETUP, runs: listRuns(), jev: { via: cfg.via, model: cfg.model, key: Boolean(cfg.key) }, job: job && !job.finished ? job.last : null });
    }

    if (p === '/api/setup' && req.method === 'POST') return send(res, 200, saveSetup(await readBody(req)));

    if (p === '/api/records') {
      const { records } = loadRecords();
      const run = q.run ? loadRun(q.run) : null;
      const names = q.names === '1';
      let list = records;
      if (q.engaged === '1') list = list.filter((r) => r.engaged);
      if (q.q) { const s = q.q.toLowerCase(); list = list.filter((r) => r.id === s || Object.values(r.state).some((v) => v.toLowerCase().includes(s))); }
      const offset = Number(q.offset || 0), limit = Math.min(Number(q.limit || 1), 200);
      return send(res, 200, { total: list.length, offset, rows: list.slice(offset, offset + limit).map((r) => row(r, { run, names })) });
    }

    if (p.startsWith('/api/record/')) {
      const rec = loadRecords().byId.get(p.split('/').pop());
      if (!rec) return send(res, 404, { error: 'not found' });
      const run = q.run ? loadRun(q.run) : null;
      return send(res, 200, { row: row(rec, { run, names: q.names === '1', labels: loadLabels() }), request: requestFor(loadSetup(), rec) });
    }

    if (p === '/api/one' && req.method === 'POST') {
      const { id } = await readBody(req);
      const rec = loadRecords().byId.get(id);
      if (!rec) return send(res, 404, { error: 'not found' });
      const setup = loadSetup();
      const r = await judgeOne(setup, rec);
      appendSingle({ at: new Date().toISOString(), id, setup_version: setup.version, bucket: r.bucket, confidence: r.confidence, ms: r.ms, cost: r.cost, model: r.model });
      return send(res, 200, { ...r, setup_version: setup.version });
    }

    if (p === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      const { records } = loadRecords();
      if (!records.length) throw new Error('No connections loaded. Run: npm run build -- path/to/Connections.csv');
      const limit = Number(body.limit) || 0;
      const list = limit ? records.slice(-limit) : records;
      const concurrency = Math.min(600, Number(body.concurrency) || 300);
      startJob(list.length, (o) => runBatch({ setup: loadSetup(), records: list, concurrency, ...o }));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/run/cancel' && req.method === 'POST') { job?.abort(); return send(res, 200, { ok: true }); }
    if (p === '/api/run/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (!job) { write('idle', {}); return res.end(); }
      write(job.last.event, job.last.data);
      if (job.finished) return res.end();
      const l = (event, data) => { write(event, data); if (event !== 'progress') res.end(); };
      job.listeners.add(l);
      req.on('close', () => job?.listeners.delete(l));
      return;
    }

    const m = p.match(/^\/api\/runs\/([\w-]+)(?:\/(\w+))?(?:\.(csv))?$/);
    if (m) {
      const run = loadRun(m[1]);
      if (!run) return send(res, 404, { error: 'run not found' });
      const sub = m[2];
      const { byId } = loadRecords();
      const names = q.names === '1';

      if (!sub) {
        const hist = Array(20).fill(0);
        for (const r of run.results) if (typeof r.confidence === 'number') hist[Math.min(19, Math.floor(r.confidence * 20))]++;
        return send(res, 200, { ...summarizeRun(run), setup: run.setup, confidence_hist: hist });
      }
      if (sub === 'retry' && req.method === 'POST') {
        const missing = run.results.filter((r) => !r.bucket).length;
        if (!missing) return send(res, 200, { ok: true, missing: 0 });
        startJob(missing, (o) => retryFailed(run, { concurrency: 200, ...o }));
        return send(res, 200, { ok: true, missing });
      }
      if (sub === 'rows') {
        let list = run.results;
        if (q.bucket) list = list.filter((r) => r.bucket === q.bucket);
        if (q.below) list = list.filter((r) => (r.confidence ?? 0) < Number(q.below));
        if (q.engaged === '1') list = list.filter((r) => byId.get(r.id)?.engaged);
        if (q.sort === 'confidence') list = [...list].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
        const offset = Number(q.offset || 0), limit = Math.min(Number(q.limit || 12), 200);
        return send(res, 200, { total: list.length, offset, rows: list.slice(offset, offset + limit).map((r) => row(byId.get(r.id) || { id: r.id, state: {} }, { run, names })) });
      }
      if (sub === 'threshold') {
        const t = Number(q.t || 0.9);
        const per = Object.fromEntries(run.bucket_keys.map((k) => [k, { auto: 0, review: 0 }]));
        for (const r of run.results) if (r.bucket in per) per[r.bucket][r.confidence >= t ? 'auto' : 'review']++;
        const auto = Object.values(per).reduce((s, x) => s + x.auto, 0);
        return send(res, 200, { t, auto, review: run.results.length - auto, per });
      }
      if (sub === 'check') {
        if (req.method === 'POST') { const b = await readBody(req); saveLabel(b.id, b.bucket); }
        const next = q.next === '1' ? nextToCheck(run) : null;
        return send(res, 200, { stats: checkStats(run), next: next ? row(byId.get(next), { run, names }) : null });
      }
      if (sub === 'export') {
        const t = q.t ? Number(q.t) : null;
        let list = run.results;
        if (q.bucket) list = list.filter((r) => r.bucket === q.bucket);
        if (q.review === '1' && t != null) list = list.filter((r) => r.bucket && r.confidence < t);
        const people = names ? loadPeople() : {};
        const head = ['id', ...(names ? ['name', 'profile_url'] : []), 'job_title', 'company', 'headline', 'engaged_with_my_posts', 'bucket', 'confidence', ...(t != null ? ['route'] : [])];
        const lines = [head.join(',')];
        for (const r of list) {
          const rec = byId.get(r.id);
          const s = rec?.state || {};
          lines.push([r.id, ...(names ? [people[r.id]?.name, people[r.id]?.url] : []), s.job_title, s.company, s.headline, s.engaged_with_my_posts, r.bucket, r.confidence, ...(t != null ? [r.confidence >= t ? 'next step' : 'review task'] : [])].map(csvCell).join(','));
        }
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${run.id}${q.bucket ? '-' + q.bucket : ''}${q.review === '1' ? '-review' : ''}.csv"` });
        return res.end(lines.join('\n'));
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`LinkedIn ICP Sorter on http://localhost:${PORT}`));
