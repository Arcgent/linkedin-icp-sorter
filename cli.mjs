// Terminal use:
//   node cli.mjs one c04213              one record, prints the bucket and the exact request
//   node cli.mjs run [--limit N] [--concurrency 300]   full run, saved to data/runs/
//   node cli.mjs bench [--n 1000]        speed/cost test on synthetic records (no real data sent)
//   node cli.mjs signals [--run ID] [--limit N] [--maybe]   step 4: buying signals + Jev's "why now" for the Warm list
//   node cli.mjs openers [--run ID] [--which now|soon] [--redo]   step 4: draft openers (nothing is sent)
import { loadRecords, listRuns, loadRun } from './lib/store.mjs';
import { loadSetup } from './lib/setup.mjs';
import { judgeOne, runBatch } from './lib/runner.mjs';
import { runSignals, runOpeners, loadReach } from './lib/reachout.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, def) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : def; };
const setup = loadSetup();

if (cmd === 'one') {
  const rec = loadRecords().byId.get(rest[0]);
  if (!rec) throw new Error(`No record ${rest[0]}`);
  const r = await judgeOne(setup, rec);
  console.log(JSON.stringify({ input: rec.state, bucket: r.bucket, confidence: r.confidence, probabilities: r.probabilities, ms: r.ms, cost: r.cost, model: r.model }, null, 2));
} else if (cmd === 'run' || cmd === 'bench') {
  let records;
  if (cmd === 'bench') {
    const titles = ['CEO', 'COO', 'Eigenaar', 'Operations Director', 'Student', 'Recruiter', 'AI consultant', 'Sales rep', 'Finance Manager', 'Founder', 'Head of Operations', 'Software developer', 'Coach', 'Managing Director', 'Intern'];
    const cos = ['Van Dijk Transport B.V.', 'Acme Inc', 'Bakkerij de Vries', 'Global Logistics Group', 'Freelance', 'AutomateAI Agency', 'Jansen Installatietechniek', 'University of Amsterdam'];
    records = Array.from({ length: Number(flag('n', 1000)) }, (_, i) => ({ id: `s${i}`, state: { job_title: titles[i % 15], company: cos[(i * 7) % 8], headline: `${titles[i % 15]} at ${cos[(i * 7) % 8]}`, engaged_with_my_posts: i % 7 ? 'No reactions or comments on my posts in the last 90 days' : 'Yes: 2 reactions on my posts in the last 90 days' } }));
  } else {
    const all = loadRecords().records;
    const limit = Number(flag('limit', 0));
    records = limit ? all.slice(-limit) : all;
  }
  let last = 0;
  const run = await runBatch({
    setup, records, concurrency: Number(flag('concurrency', 300)), label: cmd === 'bench' ? `benchmark ${records.length} synthetic` : undefined, save: cmd !== 'bench',
    onProgress: (p) => { if (p.done - last >= 1000 || p.done === p.total) { last = p.done; console.log(`${p.done}/${p.total}  ${(p.elapsed_ms / 1000).toFixed(1)}s  $${p.cost.toFixed(4)}  ${JSON.stringify(p.counts)}`); } },
  });
  console.log(JSON.stringify({ id: run.id, n: run.n, answered: run.answered, runtime_s: run.runtime_ms / 1000, cost_usd: run.cost_usd, retries: run.retries, counts: run.counts, errors: run.errors, model: run.model }, null, 2));
} else if (cmd === 'signals' || cmd === 'openers') {
  const runId = flag('run', listRuns()[0]?.id);
  const run = runId && loadRun(runId);
  if (!run) throw new Error('No full run yet. Do a full run first: npm run run');
  let last = -1;
  const onProgress = (p) => {
    if (p.done === last) return;
    last = p.done;
    if (p.done % 10 === 0 || p.done === p.total) console.log(`${p.done}/${p.total}  ${(p.elapsed_ms / 1000).toFixed(0)}s  $${(p.cost || 0).toFixed(4)}${p.counts ? '  ' + JSON.stringify(p.counts) : ''}${p.status ? '  ' + p.status : ''}`);
  };
  const res = cmd === 'signals'
    ? await runSignals({ setup, run, includeMaybe: rest.includes('--maybe'), limit: Number(flag('limit', 0)), onProgress })
    : await runOpeners({ setup, run, which: flag('which', 'now'), redo: rest.includes('--redo'), onProgress });
  console.log(JSON.stringify(res, null, 2));
  if (cmd === 'openers') {
    const reach = loadReach();
    for (const [id, o] of Object.entries(reach.openers).slice(-5)) if (o.text) console.log(`\n${id}: ${o.text}`);
  }
} else {
  console.log('Usage: node cli.mjs one <id> | run [--limit N] [--concurrency 300] | bench [--n 1000] | signals [--run ID] [--limit N] [--maybe] | openers [--run ID] [--which now] [--redo]');
}
