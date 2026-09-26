// The saved setup: one question, a fixed set of answers (buckets) with a description each, and the criteria.
// Every run stores a copy of the setup it used, so a completed run always shows the exact definitions.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './store.mjs';

const FILE = path.join(DATA, 'setup.json');

// Example setup. Edit it in the app (tab 1, "Edit setup") to describe your own ICP before a full run.
export const DEFAULT_SETUP = {
  version: 1,
  question_id: 'icp_fit',
  question: 'Does this person fit my ICP?',
  context: 'I help operationally intensive B2B companies automate their operations. My ideal customer is a decision maker (owner, founder, CEO, managing director, COO or head of operations) at a company in or near the Netherlands with more than 50 employees.',
  rule: 'Use only the profile fields given. Company size is rarely visible: do not demand proof of more than 50 employees, but do use clear signs that a business is too small. Engagement with my posts moves a borderline case up one level; when engagement is unknown, ignore it. Someone who sells AI, automation, software, marketing or consulting services is Not relevant, even when they engaged with my posts.',
  criteria: [
    { key: 'job_title', label: 'Job title', description: 'Is this person a decision maker: owner, founder, CEO, managing director, COO or head of operations?' },
    { key: 'region', label: 'In my region', description: 'Does the profile suggest the company is in or near the Netherlands? Signals: Dutch or Belgian company names (B.V., BV, NV), Dutch text, cities in NL, BE or DE.' },
    { key: 'size_50', label: 'More than 50 employees', description: 'Could the company have more than 50 employees? Positive signals: group or holding, multiple locations, a known employer, a management layer. Negative signals: one-person business, freelancer, very small shop. Size is often unknown; unknown is not a no.' },
    { key: 'engaged', label: 'Engaged with my posts', description: 'Did this person react to or comment on my LinkedIn posts recently? Engagement makes a fit warmer. It is a plus, not a requirement.' },
  ],
  buckets: [
    { key: 'warm', label: 'Warm', color: '#D9480F', next: 'Goes to my review list for a personal follow-up',
      description: 'Good fit. A decision maker (owner, founder, CEO, managing director, COO or head of operations) at a company that is likely in or near the Netherlands and shows no sign of being a one-person business. Also Warm: a Maybe warm person who reacted to or commented on my posts.' },
    { key: 'maybe_warm', label: 'Maybe warm', color: '#E8A317', next: 'A person takes a second look',
      description: 'Possible fit, worth a second look. A decision maker whose company location is unclear, or a senior operations, finance or general management lead at a company likely in or near the Netherlands. Also Maybe warm: a Cold person who engaged with my posts.' },
    { key: 'cold', label: 'Cold', color: '#1971C2', next: 'Stays out of the active list for now',
      description: 'Weak fit. A real business role, but the profile points away from my ICP: clearly a small or one-person business, a role without buying power, or a company far from the Netherlands.' },
    { key: 'not_relevant', label: 'Not relevant', color: '#868E96', next: 'Removed from the list',
      description: 'Not a buyer, whatever the engagement. Student, job seeker, intern, junior or individual contributor, recruiter, freelancer, a vendor, agency or consultant selling AI, automation, software or marketing services, or a profile with too little business information.' },
  ],
};

export function loadSetup() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return structuredClone(DEFAULT_SETUP); }
}

export function saveSetup(next) {
  const cur = loadSetup();
  const s = { ...cur, ...next, version: (cur.version || 1) + 1, saved_at: new Date().toISOString() };
  if (!s.question?.trim()) throw new Error('Question is empty');
  if (!Array.isArray(s.buckets) || s.buckets.length < 2) throw new Error('Need at least two answers');
  for (const b of s.buckets) if (!b.key || !b.label?.trim() || !b.description?.trim()) throw new Error(`Answer "${b.label || b.key}" needs a label and a description`);
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
  return s;
}

// The exact instructions Jev receives for the question.
export function instructionsFor(setup) {
  const crit = setup.criteria.map((c, i) => `${i + 1}. ${c.label}: ${c.description}`).join('\n');
  return `${setup.question}\n\n${setup.context}\n\nJudge on these ${setup.criteria.length} criteria:\n${crit}\n\n${setup.rule}`;
}

// The exact request body for one record (minus model), so the app can show what Jev received.
export function requestFor(setup, record) {
  return {
    state: record.state,
    questions: {
      [setup.question_id]: {
        type: 'choice',
        instructions: instructionsFor(setup),
        criteria: Object.fromEntries(setup.buckets.map((b) => [b.key, `${b.label}: ${b.description}`])),
      },
    },
  };
}
