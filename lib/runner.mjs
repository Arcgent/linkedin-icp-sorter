// Runs the one ICP decision over many records: one Jev call per record, many calls in parallel.
// Runtime is wall clock from the first request to the last answer. Cost is the sum of usage.cost Jev reports.
// When OpenRouter throttles (429), the number of parallel calls drops and a short pause applies to all workers;
// it climbs back while calls succeed. That avoids retry storms and unanswered records.
import { decide } from './jev.mjs';
import { requestFor } from './setup.mjs';
import { saveRun, loadRecords } from './store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function judgeOne(setup, record, { signal, onRetry } = {}) {
  const req = requestFor(setup, record);
  const r = await decide({ ...req, signal, onRetry });
  const a = r.answers[setup.question_id] || {};
  return { bucket: a.choice ?? null, confidence: a.confidence ?? null, probabilities: a.probabilities || {}, model: r.model, cost: r.cost, tokens: r.tokens, ms: r.ms, attempts: r.attempts, request: req };
}

const round = (x, d = 4) => (typeof x === 'number' ? Number(x.toFixed(d)) : null);

export async function runBatch({ setup, records, concurrency = 300, onProgress, signal, label, save = true }) {
  const keys = setup.buckets.map((b) => b.key);
  const counts = Object.fromEntries(keys.map((k) => [k, 0]));
  const results = new Array(records.length);
  const errors = [];
  let done = 0, cost = 0, tokens = 0, retries = 0, throttled = 0, model = null, next = 0;
  let active = concurrency, pauseUntil = 0, okStreak = 0, minActive = concurrency, lastCut = 0;
  const floor = Math.min(concurrency, 80);
  // One cut per 2 seconds, not one per rejected call: when throttling starts, hundreds of in-flight calls
  // get a 429 at once, and cutting for each of them collapses the run to a crawl.
  const onRetry = (e) => {
    retries++;
    if (e.status !== 429) return;
    throttled++;
    const now = Date.now();
    if (now - lastCut < 2000) return;
    lastCut = now;
    active = Math.max(floor, Math.floor(active * 0.75));
    minActive = Math.min(minActive, active);
    pauseUntil = now + 500;
    okStreak = 0;
  };
  const started = new Date();
  const t0 = performance.now();
  let lastEmit = 0;
  const emit = (force) => {
    const now = performance.now();
    if (!force && now - lastEmit < 200) return;
    lastEmit = now;
    onProgress?.({ done, total: records.length, cost, elapsed_ms: Math.round(now - t0), counts: { ...counts }, errors: errors.length, parallel: active, throttled });
  };

  async function worker(w) {
    while (next < records.length) {
      if (signal?.aborted) return;
      const wait = Math.max(pauseUntil - Date.now(), w >= active ? 200 : 0);
      if (wait > 0) { await sleep(wait); continue; }
      const i = next++;
      const rec = records[i];
      try {
        const r = await judgeOne(setup, rec, { signal, onRetry });
        model ||= r.model;
        cost += r.cost || 0;
        tokens += r.tokens || 0;
        if (r.bucket in counts) counts[r.bucket]++;
        results[i] = { id: rec.id, bucket: r.bucket, confidence: round(r.confidence, 3), p: keys.map((k) => round(r.probabilities[k] ?? 0, 3)) };
        if (++okStreak >= 100 && active < concurrency) { active = Math.min(concurrency, active + 20); okStreak = 0; }
      } catch (e) {
        if (signal?.aborted) return;
        errors.push({ id: rec.id, error: e.message });
        results[i] = { id: rec.id, bucket: null, confidence: null, p: [], error: e.message };
      }
      done++;
      emit(false);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, (_, w) => worker(w)));
  const runtime_ms = Math.round(performance.now() - t0);
  if (signal?.aborted) throw new Error('cancelled');
  emit(true);

  const stamp = started.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const run = {
    id: `run-${stamp}`,
    label: label || `${records.length.toLocaleString('en-US')} connections`,
    created_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    model,
    n: records.length,
    answered: records.length - errors.length,
    concurrency,
    lowest_parallel: minActive,
    runtime_ms,
    cost_usd: round(cost, 6),
    input_tokens: tokens,
    retries,
    throttled,
    counts,
    errors: errors.length,
    error_samples: errors.slice(0, 5),
    bucket_keys: keys,
    setup,
    results,
  };
  if (save) saveRun(run);
  return run;
}

// Re-ask Jev for the records in a run that have no answer, with the run's own setup, and merge them in.
export async function retryFailed(run, { concurrency = 200, onProgress, signal } = {}) {
  const { byId } = loadRecords();
  const failed = run.results.filter((r) => !r.bucket).map((r) => byId.get(r.id)).filter(Boolean);
  if (!failed.length) return run;
  const sub = await runBatch({ setup: run.setup, records: failed, concurrency, onProgress, signal, save: false });
  const fixed = new Map(sub.results.filter((r) => r.bucket).map((r) => [r.id, r]));
  const { byId: _drop, ...rest } = run;
  const results = run.results.map((r) => fixed.get(r.id) || r);
  const counts = Object.fromEntries(run.bucket_keys.map((k) => [k, 0]));
  for (const r of results) if (r.bucket in counts) counts[r.bucket]++;
  const missing = results.filter((r) => !r.bucket);
  const merged = {
    ...rest,
    results,
    counts,
    answered: results.length - missing.length,
    errors: missing.length,
    error_samples: missing.slice(0, 5).map((r) => ({ id: r.id, error: r.error })),
    cost_usd: round((run.cost_usd || 0) + (sub.cost_usd || 0), 6),
    input_tokens: (run.input_tokens || 0) + (sub.input_tokens || 0),
    retry_runtime_ms: (run.retry_runtime_ms || 0) + sub.runtime_ms,
    retried: (run.retried || 0) + failed.length,
  };
  saveRun(merged);
  merged.byId = new Map(results.map((r) => [r.id, r]));
  return merged;
}
