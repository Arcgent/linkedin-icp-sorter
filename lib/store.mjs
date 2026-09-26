// Local files under data/: records, private names, runs, labels. Nothing here leaves the machine.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
const RUNS = path.join(DATA, 'runs');
fs.mkdirSync(RUNS, { recursive: true });

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

let recordsCache = null;
export function loadRecords() {
  const file = path.join(DATA, 'records.json');
  const mtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  if (!recordsCache || recordsCache.mtime !== mtime) {
    const d = readJson(file, { meta: { count: 0 }, records: [] });
    recordsCache = { mtime, meta: d.meta, records: d.records, byId: new Map(d.records.map((r) => [r.id, r])) };
  }
  return recordsCache;
}

let peopleCache = null;
export function loadPeople() {
  if (!peopleCache) peopleCache = readJson(path.join(DATA, 'people.json'), {});
  return peopleCache;
}

const runFile = (id) => path.join(RUNS, `${id.replace(/[^\w-]/g, '')}.json`);
const runCache = new Map();

export function saveRun(run) {
  fs.writeFileSync(runFile(run.id), JSON.stringify(run));
  runCache.set(run.id, run);
}

export function loadRun(id) {
  if (!runCache.has(id)) {
    const run = readJson(runFile(id), null);
    if (!run) return null;
    run.byId = new Map(run.results.map((r) => [r.id, r]));
    runCache.set(id, run);
  }
  const run = runCache.get(id);
  if (!run.byId) run.byId = new Map(run.results.map((r) => [r.id, r]));
  return run;
}

export function listRuns() {
  return fs.readdirSync(RUNS).filter((f) => f.endsWith('.json')).sort().reverse().map((f) => {
    const run = loadRun(f.replace(/\.json$/, ''));
    return run && summarizeRun(run);
  }).filter(Boolean);
}

export function summarizeRun(run) {
  const { results, byId, setup, ...rest } = run;
  return { ...rest, setup_version: setup?.version };
}

const LABELS = path.join(DATA, 'labels.json');
export const loadLabels = () => readJson(LABELS, {});
export function saveLabel(id, bucket) {
  const labels = loadLabels();
  if (bucket) labels[id] = { bucket, at: new Date().toISOString() };
  else delete labels[id];
  fs.writeFileSync(LABELS, JSON.stringify(labels, null, 1));
  return labels;
}

export function appendSingle(entry) {
  fs.appendFileSync(path.join(DATA, 'single-runs.jsonl'), JSON.stringify(entry) + '\n');
}
