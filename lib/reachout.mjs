// Step 4: who to message this week, and the first message.
// For every Warm connection: fetch buying signals (lib/signals.mjs), let Jev answer "Is now a good moment to
// reach out?" (Now / Soon / Later), and let Claude draft a short opener for the people you pick.
// Nothing is ever sent. You copy the message and send it yourself.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadRecords, loadPeople } from './store.mjs';
import { decide } from './jev.mjs';
import { fetchSignals, loadSignals, signalFacts } from './signals.mjs';

const FILE = path.join(DATA, 'reachout.json');
export const loadReach = () => { try { return { why: {}, openers: {}, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { why: {}, openers: {} }; } };
export function saveReach(r) { fs.writeFileSync(FILE, JSON.stringify(r, null, 1)); }

export const WHY_ANSWERS = [
  { key: 'now', label: 'Now', description: 'A clear trigger in the last few months that makes my offer relevant now, and the checked company still fits my ideal customer.' },
  { key: 'soon', label: 'Soon', description: 'Fits my ideal customer, but there is no clear trigger right now. Worth a light touch later.' },
  { key: 'later', label: 'Later', description: 'No trigger, or the checked data shows the company does not fit after all (too small, too far away, wrong kind of business), or the profile could not be checked.' },
];

// The people step 4 works on: the first bucket of a run (Warm), optionally the second (Maybe warm) too.
export function targetsFor(run, { includeMaybe = false } = {}) {
  const keys = run.bucket_keys.slice(0, includeMaybe ? 2 : 1);
  const people = loadPeople();
  return run.results.filter((r) => keys.includes(r.bucket)).map((r) => ({ id: r.id, bucket: r.bucket, url: people[r.id]?.url || '', name: people[r.id]?.name || '' }));
}

// ---------- Jev: is now a good moment? ----------
// The state holds the role and the checked facts. No name, no profile link.
export function whyNowRequest(setup, record, s) {
  const unknown = 'unknown';
  const role = s?.role || {};
  const posts = s?.posts || {};
  const state = {
    job_title: role.title || record?.state?.job_title || unknown,
    company: s?.company?.name || record?.state?.company || unknown,
    months_in_current_role: role.months_in_role != null ? `${role.months_in_role} (started ${role.started})` : unknown,
    company_size_on_linkedin: s?.company?.employees != null ? `${s.company.employees} employees${s.company.size_range ? `, range ${s.company.size_range}` : ''}` : unknown,
    company_headquarters: s?.company?.hq || unknown,
    company_industry: s?.company?.industry || unknown,
    person_location: s?.location || unknown,
    open_jobs_at_company: !s?.jobs ? unknown : s.jobs.open ? `${s.jobs.open} open${s.jobs.titles.length ? `: ${s.jobs.titles.join('; ')}` : ''}${s.jobs.newest_at ? ` (newest posted ${s.jobs.newest_at.slice(0, 10)})` : ''}` : 'none found',
    last_linkedin_post: posts.last_at ? `${posts.days_since_last} days ago: ${posts.last_text || '(no text)'}` : 'no recent posts found',
    posts_last_30_days: String(posts.last_30d ?? 0),
    engaged_with_my_posts: record?.state?.engaged_with_my_posts || unknown,
  };
  const instructions = `Is now a good moment for me to start a conversation with this person?

${setup.context}

This person already came out as a likely fit for my ideal customer, based on job title and company name only. The fields below were checked on LinkedIn today. Judge on:
1. Trigger: a recent change that makes a conversation about my work relevant now. Examples: new in the current role (6 months or less), the company is hiring for roles that point to growth or manual workload (operations, finance, administration, customer service, sales), or a recent post about growth, hiring, operations or a problem I solve.
2. Fit check: the checked company size and location still match my ideal customer. LinkedIn employee counts are often lower than the real headcount, so treat them as a rough signal, not proof.
3. Reachability: recent posts make a reply more likely.
Unknown is not a no. A strong trigger with an unknown size can still be Now.`;
  return {
    state,
    questions: {
      reach_out_now: { type: 'choice', instructions, criteria: Object.fromEntries(WHY_ANSWERS.map((a) => [a.key, `${a.label}: ${a.description}`])) },
    },
  };
}

export async function judgeWhyNow(setup, record, s, { signal } = {}) {
  const req = whyNowRequest(setup, record, s);
  const r = await decide({ ...req, signal });
  const a = r.answers.reach_out_now || {};
  return { answer: a.choice ?? null, confidence: a.confidence ?? null, p: a.probabilities || {}, model: r.model, cost: r.cost || 0, at: new Date().toISOString(), request: req };
}

// ---------- Claude: the first message ----------
const OPENER_MODEL = () => process.env.OPENER_MODEL || 'anthropic/claude-sonnet-5.5';

function openerPrompt(setup, s, why) {
  const lang = (process.env.OPENER_LANGUAGE || 'auto').toLowerCase();
  const langRule = lang === 'auto'
    ? 'Write in the language this person most likely uses on LinkedIn. Use Dutch for someone based in the Netherlands or Flanders whose headline or posts are in Dutch. Otherwise use English.'
    : `Write in this language: ${lang}.`;
  const system = `You write the first LinkedIn direct message from me to one of my connections.

About me: ${setup.context}

Rules:
- At most 300 characters and at most two sentences after the greeting: one that names the reason, one question.
- Start with "Hi <first name>," (in Dutch: "Hoi <first name>,").
- Mention the one strongest concrete reason to talk now, in plain words: their new role, one specific open job, or their recent post. Pick one. Do not list several. Do not say you looked at their profile.
- Ask exactly one question (one question mark) about their work or their team that they can answer in one line. It should touch the kind of problem I work on, without naming my company, my service or a price.
- No filler such as "in a new role you often see..." or "many companies struggle with...". Get to the question.
- No pitch, no link, no meeting request, no compliments such as "impressive" or "great post", no "I hope you are well", no emoji, no hashtags, no dashes as punctuation.
- Sound like a person typing a quick message: short sentences, plain words.
- ${langRule}
Reply with the message text only.`;
  const facts = {
    first_name: s.first_name,
    headline: s.headline,
    role: s.role,
    company: s.company,
    location: s.location,
    open_jobs: s.jobs,
    last_post: s.posts?.last_at ? { days_ago: s.posts.days_since_last, text: s.posts.last_text } : null,
    signals: signalFacts(s).map((f) => f.text),
    why_now: why?.answer || null,
  };
  return { system, user: `Write the opener for this connection:\n${JSON.stringify(facts, null, 2)}` };
}

const tidy = (t) => String(t || '').trim().replace(/^["'“]+|["'”]+$/g, '').replace(/\s*[—–]\s*/g, ', ').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
const breaksRules = (t) => (t.match(/\?/g) || []).length !== 1 || t.length > 300;

async function chat(messages, signal) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: signal || AbortSignal.timeout(90000),
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'LinkedIn ICP Sorter' },
    body: JSON.stringify({ model: OPENER_MODEL(), max_tokens: 400, temperature: 0.6, usage: { include: true }, messages }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`OpenRouter: ${j?.error?.message || `HTTP ${res.status}`}`);
  return { text: tidy(j.choices?.[0]?.message?.content), model: j.model, cost: j.usage?.cost ?? 0 };
}

// One draft, plus one retry when the draft has more or less than one question or runs over 300 characters.
export async function draftOpener(setup, s, why, { signal } = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set (put it in .env)');
  if (!s || s.error) throw new Error('No signals for this person yet');
  const { system, user } = openerPrompt(setup, s, why);
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  let r = await chat(messages, signal);
  let cost = r.cost;
  if (r.text && breaksRules(r.text)) {
    const again = await chat([...messages, { role: 'assistant', content: r.text }, { role: 'user', content: 'Rewrite it: exactly one question mark, at most two sentences after the greeting, at most 300 characters. Reply with the message only.' }], signal);
    cost += again.cost;
    if (again.text) r = { ...again, text: again.text };
  }
  if (!r.text) throw new Error('Empty opener');
  return { text: r.text, model: r.model || OPENER_MODEL(), cost, at: new Date().toISOString() };
}

// ---------- batch jobs ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Signals + Jev for every target. Jev runs as soon as a person's signals are in, a few calls at a time.
export async function runSignals({ setup, run, includeMaybe = false, limit = 0, onProgress, signal }) {
  let targets = targetsFor(run, { includeMaybe });
  const total0 = targets.length;
  if (limit) targets = targets.slice(-limit);
  const { byId } = loadRecords();
  const reach = loadReach();
  const t0 = performance.now();
  const counts = { now: 0, soon: 0, later: 0 };
  let fetched = 0, judged = 0, errors = 0, cost = 0, status = '';
  const emit = () => onProgress?.({ done: judged, fetched, total: targets.length, counts: { ...counts }, errors, cost, elapsed_ms: Math.round(performance.now() - t0), status });
  const pending = new Set();
  let active = 0;

  const judge = async (id, s) => {
    while (active >= 10) await sleep(50);
    active++;
    try {
      const fresh = reach.why[id] && reach.why[id].signals_at === s.fetched_at && reach.why[id].setup_version === setup.version;
      const w = fresh ? reach.why[id] : { ...(await judgeWhyNow(setup, byId.get(id), s, { signal })), signals_at: s.fetched_at, setup_version: setup.version };
      if (!fresh) cost += w.cost;
      delete w.request;
      reach.why[id] = w;
      if (w.answer in counts) counts[w.answer]++;
    } catch (e) {
      if (signal?.aborted) return;
      errors++;
      reach.why[id] = { answer: null, error: e.message, at: new Date().toISOString() };
    } finally {
      active--;
      judged++;
      if (judged % 10 === 0) saveReach(reach);
      emit();
    }
  };

  const res = await fetchSignals(targets, {
    signal,
    onStatus: (s) => { status = s; emit(); },
    onEach: (id, s) => {
      fetched++;
      if (s.error) { errors++; judged++; reach.why[id] = { answer: null, error: s.error, at: new Date().toISOString() }; emit(); return; }
      const p = judge(id, s);
      pending.add(p);
      p.finally(() => pending.delete(p));
      emit();
    },
  });
  await Promise.all([...pending]);
  if (signal?.aborted) throw new Error('cancelled');
  saveReach(reach);
  const summary = {
    run_id: run.id, n: targets.length, of: total0, provider: res.provider, fetched: res.fetched, cached: res.cached,
    counts, errors, cost_usd: Number(cost.toFixed(6)), runtime_ms: Math.round(performance.now() - t0), at: new Date().toISOString(),
  };
  reach.last_signals_run = summary;
  saveReach(reach);
  emit();
  return summary;
}

// Openers for a list of ids (default: everyone Jev put on Now that has no opener yet).
export async function runOpeners({ setup, run, ids, which = 'now', redo = false, onProgress, signal }) {
  const reach = loadReach();
  const sigs = loadSignals();
  const list = (ids?.length ? ids : targetsFor(run, { includeMaybe: true }).map((t) => t.id))
    .filter((id) => (ids?.length || reach.why[id]?.answer === which) && sigs[id] && !sigs[id].error && (redo || !reach.openers[id]));
  const t0 = performance.now();
  let done = 0, errors = 0, cost = 0;
  const emit = () => onProgress?.({ done, total: list.length, errors, cost, elapsed_ms: Math.round(performance.now() - t0) });
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      if (signal?.aborted) return;
      const id = list[next++];
      try {
        const o = await draftOpener(setup, sigs[id], reach.why[id], { signal });
        cost += o.cost;
        reach.openers[id] = o;
      } catch (e) {
        if (signal?.aborted) return;
        errors++;
        reach.openers[id] = { text: '', error: e.message, at: new Date().toISOString() };
      }
      done++;
      emit();
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  if (signal?.aborted) throw new Error('cancelled');
  saveReach(reach);
  emit();
  return { n: list.length, errors, cost_usd: Number(cost.toFixed(6)), runtime_ms: Math.round(performance.now() - t0) };
}
