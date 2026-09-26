// Build the records Jev will judge: one record per LinkedIn connection.
//
//   npm run build -- ~/Downloads/Connections.csv
//   npm run build -- ~/Downloads/Basic_LinkedInDataExport_09-26-2026   (the unzipped export folder)
//   npm run build -- Connections.csv --limit 10000                      (newest 10,000 only)
//
// Input: Connections.csv from LinkedIn's data export (Settings > Data privacy > Get a copy of your data),
// or any CSV with similar columns (name, profile URL, company, position/title, optional headline).
// Optional: data/engagement.json from `npm run engagement`.
//
// Writes:
//   data/records.json   what Jev receives per connection: job title, company, headline (if the CSV has one),
//                       engagement. No names, no URLs.
//   data/people.json    private lookup id -> name + profile URL. Never sent to Jev, hidden in the app by default.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from '../lib/store.mjs';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const limit = Number(flag('limit', 0));
let input = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit');
if (!input) {
  console.error('Usage: npm run build -- path/to/Connections.csv [--limit 10000]');
  process.exit(1);
}
input = input.replace(/^~(?=$|\/)/, process.env.HOME || '~');
if (fs.existsSync(input) && fs.statSync(input).isDirectory()) input = path.join(input, 'Connections.csv');
if (!fs.existsSync(input)) {
  console.error(`File not found: ${input}`);
  process.exit(1);
}

// Minimal RFC 4180 parser: quoted fields, escaped quotes, line breaks inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const clean = (s) => String(s ?? '').replace(/[​﻿]/g, '').replace(/\s+/g, ' ').trim();
const norm = (s) => clean(s).toLowerCase();

const COLUMNS = {
  first: ['first name', 'firstname', 'first_name'],
  last: ['last name', 'lastname', 'last_name'],
  name: ['name', 'full name', 'full_name'],
  url: ['url', 'profile url', 'profile_url', 'linkedin url', 'linkedin profile', 'public_profile_url'],
  company: ['company', 'company name', 'company_name', 'organization', 'current company'],
  title: ['position', 'job title', 'job_title', 'title', 'occupation'],
  headline: ['headline'],
  connected: ['connected on', 'connected_on', 'connected at', 'connection date'],
  member: ['member_id', 'member id', 'provider_id'],
};

// LinkedIn's export starts with a "Notes:" preamble. The header is the first row that names a person column
// and a role column.
const rows = parseCsv(fs.readFileSync(input, 'utf8'));
const isHeader = (r) => {
  const cells = r.map(norm);
  const has = (...keys) => keys.some((k) => cells.some((c) => COLUMNS[k].includes(c)));
  return has('first', 'name', 'url') && has('title', 'company', 'headline');
};
const start = rows.findIndex(isHeader);
if (start < 0) {
  console.error('No header row found. Expected columns like: First Name, Last Name, URL, Company, Position, Connected On');
  process.exit(1);
}
const header = rows[start].map(norm);
const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))]));
const get = (r, k) => (col[k] >= 0 ? clean(r[col[k]]) : '');
const hasHeadline = col.headline >= 0;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function isoDate(s) {
  let m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3})[A-Za-z]*[ -](\d{4})$/);            // LinkedIn: "25 Sep 2026"
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}

function publicId(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return '';
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); }
}

// Optional engagement from `npm run engagement`, matched on the public profile id in the URL (or a member_id column).
const engFile = path.join(DATA, 'engagement.json');
const engagement = fs.existsSync(engFile) ? JSON.parse(fs.readFileSync(engFile, 'utf8')) : null;
const days = engagement?.window_days ?? 90;
const engBy = new Map();
for (const p of engagement?.people || []) for (const k of [p.member_id, p.public_identifier]) if (k) engBy.set(String(k).toLowerCase(), p);

function engagementText(e) {
  if (!engagement) return 'unknown (not tracked)';
  if (!e) return `No reactions or comments on my posts in the last ${days} days`;
  const parts = [];
  if (e.reactions) parts.push(`${e.reactions} reaction${e.reactions !== 1 ? 's' : ''}`);
  if (e.comments) parts.push(`${e.comments} comment${e.comments !== 1 ? 's' : ''}`);
  return `Yes: ${parts.join(' and ')} on my posts in the last ${days} days`;
}

// Oldest first, so ids stay stable when you rebuild with a newer export and "newest N" is the tail.
// LinkedIn lists newest first, so within one day a later row is an older connection.
let conns = rows.slice(start + 1)
  .map((r, i) => ({ r, i, date: isoDate(get(r, 'connected')) }))
  .filter(({ r }) => ['first', 'last', 'name', 'url', 'company', 'title', 'headline'].some((k) => get(r, k)))
  .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.i - a.i));
if (limit) conns = conns.slice(-limit);

const records = [], people = {}, stats = { with_title: 0, engaged: 0 };
conns.forEach(({ r, date }, n) => {
  const id = `c${String(n + 1).padStart(5, '0')}`;
  const url = get(r, 'url');
  const e = engBy.get(publicId(url)) || (get(r, 'member') && engBy.get(get(r, 'member').toLowerCase()));
  const title = get(r, 'title'), company = get(r, 'company');
  stats.with_title += Boolean(title || company);
  stats.engaged += Boolean(e);
  records.push({
    id,
    connected_on: date,
    engaged: Boolean(e),
    state: {
      job_title: title || 'unknown',
      company: company || 'unknown',
      ...(hasHeadline ? { headline: get(r, 'headline') || 'unknown' } : {}),
      engaged_with_my_posts: engagementText(e),
    },
  });
  people[id] = { name: get(r, 'name') || clean(`${get(r, 'first')} ${get(r, 'last')}`), url };
});

const meta = {
  built_at: new Date().toISOString(),
  source: path.basename(input),
  count: records.length,
  with_company_or_title: stats.with_title,
  has_headline: hasHeadline,
  engagement_tracked: Boolean(engagement),
  engaged_last_days: stats.engaged,
  engagement_window_days: days,
  engagement_since: engagement?.since ?? null,
  engagement_posts: engagement?.posts ?? null,
};
fs.writeFileSync(path.join(DATA, 'records.json'), JSON.stringify({ meta, records }));
fs.writeFileSync(path.join(DATA, 'people.json'), JSON.stringify(people));
console.log(JSON.stringify(meta, null, 1));
