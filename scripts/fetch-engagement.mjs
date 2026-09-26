// Optional. Who reacted to or commented on your own LinkedIn posts in the last N days (default 90),
// so "engaged with my posts" can make a fit warmer. Read-only.
//
// Needs a Unipile account (https://www.unipile.com) with your LinkedIn connected. Set in .env:
//   UNIPILE_DSN, UNIPILE_API_KEY, UNIPILE_ACCOUNT_ID
// Stores only LinkedIn member ids, public identifiers and counts (no names, no comment text) in data/engagement.json.
//
//   npm run engagement                 last 90 days
//   npm run engagement -- --days 120
// Then rebuild the records so they pick it up: npm run build -- path/to/Connections.csv
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from '../lib/store.mjs';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const DAYS = Number(flag('days', 90));

const { UNIPILE_DSN, UNIPILE_API_KEY, UNIPILE_ACCOUNT_ID } = process.env;
if (!UNIPILE_DSN || !UNIPILE_API_KEY || !UNIPILE_ACCOUNT_ID) {
  console.error('Set UNIPILE_DSN, UNIPILE_API_KEY and UNIPILE_ACCOUNT_ID in .env (see .env.example).');
  process.exit(1);
}
const BASE = `https://${UNIPILE_DSN.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')}/api/v1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (s) => encodeURIComponent(s);

async function get(p, params = {}) {
  const url = new URL(BASE + p);
  for (const [k, v] of Object.entries({ account_id: UNIPILE_ACCOUNT_ID, ...params })) if (v != null) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'X-API-KEY': UNIPILE_API_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(90000) });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(5000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`Unipile ${res.status} on ${p}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

const nextCursor = (data) => data.cursor || data.paging?.cursor || null;

async function* paged(p, maxPages = 30) {
  let cursor = null;
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const data = await get(p, { limit: 100, cursor });
    yield* data.items || [];
    cursor = nextCursor(data);
    if (!cursor || seen.has(cursor)) return;
    seen.add(cursor);
    await sleep(800);
  }
}

function publicId(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); }
}

const now = new Date();
const cutoff = new Date(now.getTime() - DAYS * 864e5).toISOString();
const me = await get('/users/me');
const myId = me.provider_id || me.id;
console.log('own profile ok');

// 1. Own posts inside the window
const posts = [];
let cursor = null;
for (let page = 0; page < 10; page++) {
  const data = await get(`/users/${enc(myId)}/posts`, { limit: 100, cursor });
  const batch = data.items || [];
  posts.push(...batch.filter((p) => !p.is_repost && (p.parsed_datetime || '') >= cutoff));
  cursor = nextCursor(data);
  if (!cursor || batch.every((p) => (p.parsed_datetime || '') < cutoff)) break;
  await sleep(800);
}
console.log(`${posts.length} own posts since ${cutoff.slice(0, 10)}`);

// 2. Reactions and comments per post
const people = new Map();
function bump(pid, url, kind, date, postId) {
  const key = pid || publicId(url);
  if (!key || key === myId) return;
  if (!people.has(key)) people.set(key, { member_id: pid || null, public_identifier: publicId(url), reactions: 0, comments: 0, posts: new Set(), last: '' });
  const p = people.get(key);
  p[kind]++;
  p.posts.add(postId);
  if ((date || '') > p.last) p.last = date || '';
}

for (const [i, post] of posts.entries()) {
  const postId = post.social_id || post.id;
  const date = post.parsed_datetime || '';
  let nR = 0, nC = 0;
  for await (const r of paged(`/posts/${enc(postId)}/reactions`)) {
    const a = r.author || {};
    if ((a.type || 'INDIVIDUAL') === 'INDIVIDUAL') { bump(a.id, a.profile_url, 'reactions', date, postId); nR++; }
  }
  await sleep(800);
  for await (const c of paged(`/posts/${enc(postId)}/comments`)) {
    const a = c.author_details || {};
    if (!a.is_company) { bump(a.id, a.profile_url, 'comments', c.date || date, postId); nC++; }
  }
  console.log(`post ${i + 1}/${posts.length} ${date.slice(0, 10)}: ${nR} reactions, ${nC} comments`);
  await sleep(800);
}

// 3. Reactions and comments come with LinkedIn's internal member id, while Connections.csv only has profile URLs.
// Look up each engaged person's public profile id in your connection list (read-only, no profile visits).
// People who are not connections are never found, so this pages through the whole list (~2-3 min per 25k).
const unresolved = new Map([...people.values()].filter((p) => p.member_id).map((p) => [p.member_id, p]));
if (unresolved.size && !args.includes('--no-resolve')) {
  const total = unresolved.size;
  const seen = new Set();
  let cursor = null, pages = 0;
  while (unresolved.size && pages < 400) {
    const data = await get('/users/relations', { limit: 250, cursor });
    for (const r of data.items || []) {
      const p = unresolved.get(r.member_id);
      if (!p) continue;
      if (r.public_identifier) p.public_identifier = r.public_identifier.toLowerCase();
      unresolved.delete(r.member_id);
    }
    pages++;
    cursor = nextCursor(data);
    if (pages % 10 === 0) console.log(`connection list page ${pages}: ${total - unresolved.size}/${total} engaged people matched`);
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
    await sleep(1500);
  }
  console.log(`${total - unresolved.size} of ${total} engaged people are connections`);
}

const out = {
  fetched_at: now.toISOString(), window_days: DAYS, since: cutoff.slice(0, 10), posts: posts.length,
  people: [...people.values()].map((p) => ({ ...p, posts: p.posts.size })),
};
fs.writeFileSync(path.join(DATA, 'engagement.json'), JSON.stringify(out, null, 1));
console.log(`Saved engagement for ${people.size} people -> data/engagement.json. Now rebuild: npm run build -- path/to/Connections.csv`);
