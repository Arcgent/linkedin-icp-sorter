// Buying signals for the people you want to reach out to: current role and start date, real company size and
// location, recent LinkedIn posts and open jobs at their company. Two providers:
//   Unipile (your own LinkedIn account, https://www.unipile.com)   UNIPILE_DSN, UNIPILE_API_KEY, UNIPILE_ACCOUNT_ID
//   Apify   (no LinkedIn login, pay per result, https://apify.com)  APIFY_TOKEN
// Results are cached per connection in data/signals.json, so a second run only fetches people it has not seen.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './store.mjs';

const FILE = path.join(DATA, 'signals.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 864e5;

export const loadSignals = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
export function saveSignals(all) { fs.writeFileSync(FILE, JSON.stringify(all, null, 1)); }

// Try-out mode: when the loaded connections are the sample file, made-up signals from examples/ stand in for
// Unipile or Apify, so the whole of step 4 works without an account.
function sampleLoaded() {
  try { return /sample/i.test(JSON.parse(fs.readFileSync(path.join(DATA, 'records.json'), 'utf8')).meta?.source || ''); } catch { return false; }
}

function sampleSignals(people) {
  const file = path.join(DATA, '..', 'examples', 'signals.sample.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
  const monthsAgo = (m) => { const d = new Date(); d.setMonth(d.getMonth() - m); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const out = new Map();
  for (const p of people) {
    const x = raw[publicId(p.url)];
    if (!x) { out.set(p.id, { error: 'No sample signals for this connection' }); continue; }
    out.set(p.id, normalize({
      provider: 'sample', firstName: x.first_name, headline: x.headline, location: x.location,
      role: { title: x.title, company: x.company, started: monthsAgo(x.started_months_ago) },
      company: { name: x.company, employees: x.employees, size_range: x.size_range, hq: x.hq, industry: x.industry },
      posts: (x.posts || []).map((q) => ({ at: ago(q.days_ago), text: q.text })),
      jobs: { total: (x.jobs || []).length, items: (x.jobs || []).map((j) => ({ title: j.title, at: ago(j.days_ago) })) },
    }));
  }
  return out;
}

export function providerConfig() {
  const unipile = Boolean(process.env.UNIPILE_DSN && process.env.UNIPILE_API_KEY && process.env.UNIPILE_ACCOUNT_ID);
  const apify = Boolean(process.env.APIFY_TOKEN);
  const want = (process.env.SIGNALS_PROVIDER || '').toLowerCase();
  if (want === 'unipile' && unipile) return { provider: 'unipile', unipile, apify };
  if (want === 'apify' && apify) return { provider: 'apify', unipile, apify };
  if (want === 'sample' || (!unipile && !apify && sampleLoaded())) return { provider: 'sample', unipile, apify };
  return { provider: unipile ? 'unipile' : apify ? 'apify' : null, unipile, apify };
}

export function publicId(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return '';
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); }
}

// ---------- normalizing ----------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// "1/1/2023" (Unipile) or { month: "Jan", year: 2024 } (Apify) -> "2023-01"
function yearMonth(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    const m = v.match(/^(\d{1,2})\/\d{1,2}\/(\d{4})$/);
    if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
    const y = v.match(/^(\d{4})(?:-(\d{2}))?/);
    return y ? `${y[1]}-${y[2] || '01'}` : null;
  }
  if (v.year) return `${v.year}-${String((MONTHS[String(v.month || '').slice(0, 3).toLowerCase()] ?? 0) + 1).padStart(2, '0')}`;
  return null;
}

export function monthsSince(ym, now = new Date()) {
  if (!ym) return null;
  const [y, m] = ym.split('-').map(Number);
  return Math.max(0, (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m));
}

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// One shape for both providers. Everything the "why now" question and the opener need, nothing more.
function normalize({ provider, firstName, headline, location, country, role, company, posts, jobs }) {
  const now = Date.now();
  const own = (posts || []).filter((p) => !p.repost && p.at).sort((a, b) => (a.at < b.at ? 1 : -1));
  const recentJobs = (jobs?.items || []).sort((a, b) => ((a.at || '') < (b.at || '') ? 1 : -1));
  return {
    provider,
    fetched_at: new Date().toISOString(),
    first_name: firstName || null,
    headline: headline ? clip(headline, 220) : null,
    location: location || null,
    country: country || null,
    role: role ? { title: role.title || null, company: role.company || null, started: role.started || null, months_in_role: monthsSince(role.started) } : null,
    company: company ? {
      name: company.name || null,
      employees: Number.isFinite(company.employees) ? company.employees : null,
      size_range: company.size_range || null,
      hq: company.hq || null,
      industry: company.industry || null,
    } : null,
    posts: {
      last_at: own[0]?.at || null,
      days_since_last: own[0]?.at ? Math.floor((now - Date.parse(own[0].at)) / DAY) : null,
      last_30d: own.filter((p) => now - Date.parse(p.at) <= 30 * DAY).length,
      last_text: own[0] ? clip(own[0].text, 280) : null,
    },
    jobs: jobs ? {
      open: jobs.total ?? recentJobs.length,
      titles: recentJobs.slice(0, 3).map((j) => clip(j.title, 60)),
      newest_at: recentJobs[0]?.at || null,
    } : null,
  };
}

// ---------- Unipile ----------
function unipileBase() {
  return `https://${process.env.UNIPILE_DSN.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')}/api/v1`;
}

async function unipile(method, p, params = {}, body) {
  const url = new URL(unipileBase() + p);
  for (const [k, v] of Object.entries({ account_id: process.env.UNIPILE_ACCOUNT_ID, ...params })) if (v != null) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { 'X-API-KEY': process.env.UNIPILE_API_KEY, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(5000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`Unipile ${res.status} on ${p.split('/').slice(0, 3).join('/')}: ${(await res.text()).slice(0, 160)}`);
    return res.json();
  }
}

// Four reads per person: profile (with experience), company, posts, open jobs at the company.
// notify=false asks LinkedIn not to show a profile view notification.
async function unipileOne(url, pause) {
  const id = publicId(url);
  if (!id) throw new Error('No LinkedIn profile URL');
  const p = await unipile('GET', `/users/${encodeURIComponent(id)}`, { linkedin_sections: 'experience', notify: 'false' });
  const jobs = p.work_experience || [];
  const cur = jobs.find((e) => !e.end) || jobs[0];
  let company = null, openJobs = null, posts = [];
  if (cur?.company_id) {
    await sleep(pause);
    const c = await unipile('GET', `/linkedin/company/${encodeURIComponent(cur.company_id)}`);
    const hq = (c.locations || []).find((l) => l.is_headquarter) || (c.locations || [])[0];
    const range = c.employee_count_range;
    company = {
      name: c.name || cur.company,
      employees: typeof c.employee_count === 'number' ? Math.round(c.employee_count) : null,
      size_range: range?.from != null ? (range.to != null ? `${range.from}-${range.to}` : `${range.from}+`) : null,
      hq: hq ? [hq.city || hq.area, hq.country].filter(Boolean).join(', ') : null,
      industry: Array.isArray(c.industry) ? c.industry.join(', ') : c.industry || null,
    };
    await sleep(pause);
    const s = await unipile('POST', '/linkedin/search', { limit: 5 }, { api: 'classic', category: 'jobs', company: [String(cur.company_id)] });
    openJobs = {
      total: s.paging?.total_count ?? (s.items || []).length,
      items: (s.items || []).filter((j) => !j.company?.id || String(j.company.id) === String(cur.company_id)).map((j) => ({ title: j.title, at: j.posted_at })),
    };
  }
  if (p.provider_id) {
    await sleep(pause);
    const r = await unipile('GET', `/users/${encodeURIComponent(p.provider_id)}/posts`, { limit: 5 });
    posts = (r.items || []).map((x) => ({ at: x.parsed_datetime, text: x.text, repost: Boolean(x.is_repost) }));
  }
  return normalize({
    provider: 'unipile',
    firstName: p.first_name,
    headline: p.headline,
    location: p.location,
    country: null,
    role: cur ? { title: cur.position, company: cur.company, started: yearMonth(cur.start) } : null,
    company: company || (cur ? { name: cur.company } : null),
    posts,
    jobs: openJobs,
  });
}

// ---------- Apify ----------
async function apify(actor, input, { signal, onStatus } = {}) {
  const token = process.env.APIFY_TOKEN;
  const call = async (method, p, body) => {
    const res = await fetch(`https://api.apify.com/v2${p}${p.includes('?') ? '&' : '?'}token=${token}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Apify ${res.status} on ${actor}: ${j?.error?.message || 'request failed'}`);
    return j;
  };
  const run = (await call('POST', `/acts/${actor}/runs`, input)).data;
  for (;;) {
    if (signal?.aborted) { await call('POST', `/actor-runs/${run.id}/abort`).catch(() => {}); throw new Error('cancelled'); }
    await sleep(5000);
    const st = (await call('GET', `/actor-runs/${run.id}`)).data;
    onStatus?.(`${actor.split('~')[1]}: ${st.status.toLowerCase()}`);
    if (st.status === 'SUCCEEDED') break;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(st.status)) throw new Error(`Apify ${actor} ${st.status.toLowerCase()}: ${st.statusMessage || ''}`);
  }
  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?clean=1&offset=${offset}&limit=1000&token=${token}`);
    const page = await res.json();
    items.push(...page);
    if (page.length < 1000) return items;
  }
}

const companyIdFromUrl = (u) => String(u || '').match(/linkedin\.com\/company\/(\d+)/)?.[1] || null;
const companyKey = (u) => String(u || '').toLowerCase().replace(/\/+$/, '').replace(/\?.*$/, '');

// Batch lookups: one actor run for all profiles, one for their companies, one for posts, one for jobs.
async function apifyMany(people, { signal, onStatus }) {
  const urls = people.map((p) => p.url).filter(Boolean);
  const profiles = await apify('harvestapi~linkedin-profile-scraper', { urls, profileScraperMode: 'Profile details no email ($4 per 1k)' }, { signal, onStatus });
  const byId = new Map(profiles.map((p) => [String(p.publicIdentifier || publicId(p.linkedinUrl)).toLowerCase(), p]));
  const current = (p) => (p?.experience || []).find((e) => /present/i.test(e.endDate?.text || '')) || (p?.experience || [])[0];

  const companyUrls = [...new Set(people.map((x) => current(byId.get(publicId(x.url)))?.companyLinkedinUrl).filter((u) => /linkedin\.com\/company\//.test(u || '')).map(companyKey))];
  const companies = companyUrls.length ? await apify('harvestapi~linkedin-company', { companies: companyUrls }, { signal, onStatus }) : [];
  const companyBy = new Map();
  for (const c of companies) for (const k of [c.linkedinUrl, c.id && `https://www.linkedin.com/company/${c.id}`, c.universalName && `https://www.linkedin.com/company/${c.universalName}`]) if (k) companyBy.set(companyKey(k), c);

  const posts = await apify('harvestapi~linkedin-profile-posts', { targetUrls: urls, maxPosts: 5 }, { signal, onStatus });
  const postsBy = new Map();
  for (const x of posts) {
    const k = String(x.author?.publicIdentifier || '').toLowerCase();
    if (!k) continue;
    if (!postsBy.has(k)) postsBy.set(k, []);
    postsBy.get(k).push({ at: x.postedAt?.date, text: x.content, repost: x.type === 'repost' });
  }

  // Jobs: one LinkedIn jobs search per company id (f_C filter), at most 5 results each.
  const ids = [...new Set(companies.map((c) => String(c.id || '')).filter((s) => /^\d+$/.test(s)))];
  const jobs = ids.length ? await apify('curious_coder~linkedin-jobs-scraper', { urls: ids.map((id) => `https://www.linkedin.com/jobs/search/?f_C=${id}`), limitPerSource: 5, scrapeCompany: false }, { signal, onStatus }) : [];
  const jobsBy = new Map();
  for (const j of jobs) {
    const key = companyKey(j.companyLinkedinUrl);
    const c = companyBy.get(key);
    const k = String(c?.id || companyIdFromUrl(j.companyLinkedinUrl) || key);
    if (!jobsBy.has(k)) jobsBy.set(k, []);
    jobsBy.get(k).push({ title: j.title, at: j.postedAt });
  }

  const out = new Map();
  for (const person of people) {
    const id = publicId(person.url);
    const p = byId.get(id);
    if (!p) { out.set(person.id, { error: 'Profile not found by Apify' }); continue; }
    const cur = current(p);
    const c = companyBy.get(companyKey(cur?.companyLinkedinUrl));
    const hq = (c?.locations || []).find((l) => l.headquarter) || (c?.locations || [])[0];
    const jobList = c ? jobsBy.get(String(c.id)) || [] : null;
    out.set(person.id, normalize({
      provider: 'apify',
      firstName: p.firstName,
      headline: p.headline,
      location: p.location?.linkedinText || p.location?.parsed?.text,
      country: p.location?.parsed?.countryCode || p.location?.countryCode,
      role: cur ? { title: cur.position, company: cur.companyName, started: yearMonth(cur.startDate) } : null,
      company: c ? {
        name: c.name,
        employees: typeof c.employeeCount === 'number' ? c.employeeCount : null,
        size_range: c.employeeCountRange?.start != null ? (c.employeeCountRange.end != null ? `${c.employeeCountRange.start}-${c.employeeCountRange.end}` : `${c.employeeCountRange.start}+`) : null,
        hq: hq ? [hq.city || hq.parsed?.city, hq.country || hq.parsed?.countryCode].filter(Boolean).join(', ') : null,
        industry: Array.isArray(c.industries) ? c.industries.map((i) => i.name || i).join(', ') : null,
      } : cur ? { name: cur.companyName } : null,
      posts: postsBy.get(id) || [],
      jobs: jobList ? { total: jobList.length, items: jobList } : null,
    }));
  }
  return out;
}

// ---------- run ----------
// people: [{ id, url }]. Fetches what is not cached yet (or older than maxAgeDays) and calls onEach as results land.
export async function fetchSignals(people, { signal, onEach, onStatus, maxAgeDays = 14, pauseMs = Number(process.env.SIGNALS_PAUSE_MS || 1500) } = {}) {
  const { provider } = providerConfig();
  if (!provider) throw new Error('No signal provider. Set UNIPILE_* or APIFY_TOKEN in .env (see .env.example).');
  const cache = loadSignals();
  const fresh = (s) => s && !s.error && Date.now() - Date.parse(s.fetched_at || 0) < maxAgeDays * DAY;
  const todo = people.filter((p) => !fresh(cache[p.id]));
  for (const p of people) if (fresh(cache[p.id])) onEach?.(p.id, cache[p.id], true);

  if (provider === 'unipile') {
    for (const p of todo) {
      if (signal?.aborted) throw new Error('cancelled');
      let s;
      try { s = await unipileOne(p.url, pauseMs); } catch (e) { s = { provider, fetched_at: new Date().toISOString(), error: e.message }; }
      cache[p.id] = s;
      saveSignals(cache);
      onEach?.(p.id, s, false);
      await sleep(pauseMs);
    }
  } else if (todo.length) {
    const got = provider === 'sample' ? sampleSignals(todo) : await apifyMany(todo, { signal, onStatus });
    for (const p of todo) {
      const s = got.get(p.id) || { error: 'No result' };
      cache[p.id] = { provider, fetched_at: new Date().toISOString(), ...s };
      onEach?.(p.id, cache[p.id], false);
    }
    saveSignals(cache);
  }
  return { provider, fetched: todo.length, cached: people.length - todo.length };
}

// Short human labels for the app, the CSV and the Jev state. Nothing here is a judgement; Jev does that.
export function signalFacts(s) {
  if (!s || s.error) return [];
  const f = [];
  const m = s.role?.months_in_role;
  if (m != null && m <= 6) f.push({ key: 'new_role', text: m === 0 ? 'New in role · this month' : `New in role · ${m} mo`, hot: true });
  if (s.jobs?.open) f.push({ key: 'hiring', text: `Hiring${s.jobs.titles[0] ? `: ${s.jobs.titles[0]}` : ''}${s.jobs.open > 1 ? ` +${s.jobs.open - 1}` : ''}`, hot: true });
  if (s.posts?.days_since_last != null && s.posts.days_since_last <= 30) f.push({ key: 'posted', text: s.posts.days_since_last <= 1 ? 'Posted today' : `Posted ${s.posts.days_since_last} days ago` });
  if (s.company?.employees != null) f.push({ key: 'size', text: `${s.company.employees.toLocaleString('en-US')} on LinkedIn${s.company.size_range ? ` (${s.company.size_range})` : ''}` });
  if (s.company?.hq) f.push({ key: 'hq', text: s.company.hq });
  return f;
}
