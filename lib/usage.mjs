// The weekly Claude allowance and what spent it. The live percent comes from the same endpoint `/usage` reads;
// the split across tickets and sessions comes from the token usage every Claude Code transcript records, priced
// at API rates and scaled so the week's total matches the live percent. Claude use outside Claude Code (claude.ai,
// the desktop chat) has no transcript here, so its share lands proportionally on the sessions that do.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PROJECTS = path.join(process.env.HOME, '.claude', 'projects');
const WEEK = 7 * 864e5;
const BUCKET = 10 * 60000;
const encode = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

// $ per million tokens, from the claude-api skill (cached 2026-11-03). Cache writes are 1.25x input for the
// 5-minute cache and 2x for the 1-hour one. Only the ratios between models matter: totals are rescaled.
const RATES = [
  [/fable/, { in: 8, out: 40, read: 0.2 }],
  [/opus/, { in: 4, out: 20, read: 0.2 }],
  [/sonnet/, { in: 2, out: 10, read: 0.1 }],
  [/haiku/, { in: 0.1, out: 0.5, read: 0.01 }],
];
function costUsd(model, u) {
  const r = (RATES.find(([re]) => re.test(model || '')) || RATES[1])[1];
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  const w5m = (u.cache_creation_input_tokens || 0) - w1h;
  return ((u.input_tokens || 0) * r.in + (u.output_tokens || 0) * r.out + (u.cache_read_input_tokens || 0) * r.read
    + w5m * r.in * 1.25 + w1h * r.in * 2) / 1e6;
}

// A subagent's description says what it was for; the factory loop names them consistently enough.
function partOf(description) {
  const d = (description || '').toLowerCase();
  if (/critic|design/.test(d)) return 'design';
  if (/review|verif|confirm|audit/.test(d)) return 'review';
  return 'other';
}

// ---------- the live allowance ----------
let allowance = { at: 0, data: null, error: null };
async function oauthToken() {
  const { stdout } = await run('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 10000 });
  return JSON.parse(stdout).claudeAiOauth.accessToken;
}
export async function readAllowance(stateDir) {
  if (Date.now() - allowance.at < 5 * 60000) return allowance;
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${await oauthToken()}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`usage endpoint answered ${res.status}`);
    const j = await res.json();
    const pick = (x) => (x ? { percent: x.utilization, resets_at: x.resets_at } : null);
    const data = { weekly: pick(j.seven_day), five_hour: pick(j.five_hour), at: new Date().toISOString() };
    if (data.weekly) fs.appendFileSync(path.join(stateDir, 'usage-history.jsonl'), JSON.stringify({ at: data.at, ...data.weekly }) + '\n');
    allowance = { at: Date.now(), data, error: null };
  } catch (e) {
    allowance = { at: Date.now(), data: allowance.data, error: String(e.message || e) };
  }
  return allowance;
}
// The weekly percent recorded closest to (and not after) `t`, when one exists within 20 minutes of it.
function percentAt(stateDir, t, resetsAt) {
  let best = null;
  try {
    for (const line of fs.readFileSync(path.join(stateDir, 'usage-history.jsonl'), 'utf8').split('\n')) {
      if (!line) continue;
      const s = JSON.parse(line);
      const at = Date.parse(s.at);
      if (s.resets_at !== resetsAt || at > t) continue;
      if (t - at <= 20 * 60000 && (!best || at > best.at)) best = { at, percent: s.percent };
    }
  } catch { /* no history yet */ }
  return best?.percent ?? null;
}

// ---------- the transcripts, read incrementally ----------
// files: path -> { offset, owner } ; owners: key -> { kind, repo, worktree, label, sid, title, buckets: Map(t -> {main, design, review, other}) }
const files = new Map();
const owners = new Map();
const seen = new Set();
let scanning = null;

function ownerFor(cfg, projDir, sid) {
  const key = `${projDir}/${sid}`;
  if (owners.has(key)) return owners.get(key);
  let o = null;
  for (const repo of Object.values(cfg.repos)) {
    const prefix = encode(repo.worktrees_dir) + '-';
    if (projDir.startsWith(prefix)) o = { kind: 'factory', repo: repo.name, worktree: projDir.slice(prefix.length) };
  }
  if (!o) {
    const label = projDir.replace(encode(process.env.HOME), '~');
    o = { kind: 'you', label };
    // The tick's headless triage and planning runs (`claude -p`) start in a repo's own clone and carry no title.
    for (const repo of Object.values(cfg.repos)) if (projDir === encode(repo.path)) o = { kind: 'you', label, tickRepo: repo.name };
  }
  o = { ...o, key, sid, title: null, buckets: new Map() };
  owners.set(key, o);
  return o;
}
function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
}
function readNew(cfg, file, since) {
  let st;
  try { st = fs.statSync(file); } catch { return; }
  if (st.mtimeMs < since) return;
  let f = files.get(file);
  if (!f) {
    const rel = path.relative(PROJECTS, file).split(path.sep);
    const projDir = rel[0];
    const sid = rel.length === 2 ? path.basename(rel[1], '.jsonl') : rel[1];
    let part = 'main';
    if (rel.length > 2) {
      try { part = partOf(JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).description); } catch { part = 'other'; }
    }
    f = { offset: 0, owner: ownerFor(cfg, projDir, sid), part };
    files.set(file, f);
  }
  if (st.size <= f.offset) return;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(st.size - f.offset);
  fs.readSync(fd, buf, 0, buf.length, f.offset);
  fs.closeSync(fd);
  const end = buf.lastIndexOf(10);
  if (end < 0) return;
  f.offset += end + 1;
  for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
    if (line.includes('"aiTitle"') || line.includes('"customTitle"')) {
      try {
        const e = JSON.parse(line);
        if (e.customTitle) { f.owner.title = e.customTitle; f.owner.custom = true; } else if (e.aiTitle && !f.owner.custom) f.owner.title = e.aiTitle;
      } catch { /* torn line */ }
      continue;
    }
    if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (!m?.usage || !e.timestamp) continue;
    const id = m.id || e.uuid;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = Date.parse(e.timestamp);
    if (t < since) continue;
    const b = Math.floor(t / BUCKET) * BUCKET;
    const row = f.owner.buckets.get(b) || { main: 0, design: 0, review: 0, other: 0 };
    row[f.part] += costUsd(m.model, m.usage);
    f.owner.buckets.set(b, row);
  }
}
async function scan(cfg, since) {
  const list = [];
  walk(PROJECTS, list);
  for (let i = 0; i < list.length; i++) {
    readNew(cfg, list[i], since);
    if (i % 25 === 0) await new Promise((r) => setImmediate(r));
  }
  for (const o of owners.values()) for (const b of o.buckets.keys()) if (b < since - BUCKET) o.buckets.delete(b);
}

// Titles of finished packages the dashboard's 14-day GitHub data no longer holds: one REST call each (the core
// budget, not the GraphQL one the tick shares), remembered in state/issue-titles.json.
async function fillTitles(cfg, stateDir, titles, keys) {
  const file = path.join(stateDir, 'issue-titles.json');
  let known = {};
  try { known = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  let changed = false;
  for (const k of keys.slice(0, 20)) {
    if (titles.has(k) || known[k]) continue;
    const [repo, n] = k.split('#');
    try {
      const { stdout } = await run('gh', ['api', `repos/${cfg.repos[repo].github}/issues/${n}`, '--jq', '{title: .title, url: .html_url}'], { timeout: 20000 });
      known[k] = JSON.parse(stdout);
      changed = true;
    } catch { /* offline or rate-limited: unnamed this time */ }
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(known, null, 2));
  for (const [k, v] of Object.entries(known)) if (!titles.has(k)) titles.set(k, v);
}

// ---------- the report ----------
const PARTS = ['main', 'design', 'review', 'other'];
function sumSince(o, t) {
  const s = { main: 0, design: 0, review: 0, other: 0, total: 0, last: 0 };
  for (const [b, row] of o.buckets) {
    if (b + BUCKET <= t) continue;
    for (const k of PARTS) s[k] += row[k];
    s.last = Math.max(s.last, b);
  }
  s.total = PARTS.reduce((n, k) => n + s[k], 0);
  return s;
}

// titles: Map("<repo>#<n>" -> { title, url }) from the dashboard's GitHub data, for naming finished packages.
export async function usageReport(cfg, stateDir, titles) {
  const a = await readAllowance(stateDir);
  const weekly = a.data?.weekly || null;
  const resetsAt = weekly ? Date.parse(weekly.resets_at) : null;
  const weekStart = resetsAt ? resetsAt - WEEK : Date.now() - WEEK;
  if (!scanning) scanning = scan(cfg, weekStart).finally(() => { scanning = null; });
  await scanning;

  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const windows = { five_hours: now - 5 * 3600e3, today: Math.max(midnight.getTime(), weekStart), week: weekStart };
  const weekCost = [...owners.values()].reduce((n, o) => n + sumSince(o, weekStart).total, 0);
  const perUsd = weekly && weekCost ? weekly.percent / weekCost : null;
  const pct = (usd) => (perUsd == null ? null : Math.round(usd * perUsd * 100) / 100);

  const leads = new Map();
  for (const o of owners.values()) {
    const n = o.kind === 'factory' && /^factory-(\d+)$/.exec(o.worktree)?.[1];
    if (n) leads.set(`${o.repo}#${n}`, (leads.get(`${o.repo}#${n}`) || 0) + sumSince(o, weekStart).total);
  }
  await fillTitles(cfg, stateDir, titles, [...leads].filter(([, usd]) => usd).sort((x, y) => y[1] - x[1]).map(([k]) => k));

  const out = {
    allowance: weekly ? {
      percent: weekly.percent, resets_at: weekly.resets_at, week_start: new Date(weekStart).toISOString(),
      elapsed: Math.min(1, (now - weekStart) / WEEK), five_hour: a.data.five_hour,
    } : null,
    allowance_error: a.error, at: a.data?.at || null, alert_percent: cfg.usage?.ticket_alert_percent ?? 3, windows: {},
  };
  for (const [name, since] of Object.entries(windows)) {
    const tickets = new Map();
    const sessions = [];
    let factory = 0, you = 0;
    const parts = { main: 0, design: 0, review: 0, other: 0 };
    for (const o of owners.values()) {
      const s = sumSince(o, since);
      if (!s.total) continue;
      for (const k of PARTS) parts[k] += s[k];
      const tick = o.tickRepo && !o.title;
      if (o.kind === 'factory' || tick) {
        factory += s.total;
        const repo = tick ? o.tickRepo : o.repo, worktree = tick ? 'tick' : o.worktree;
        const tk = `${repo}/${worktree}`;
        const t = tickets.get(tk) || { repo, worktree, main: 0, design: 0, review: 0, other: 0, total: 0, sessions: 0, last: 0 };
        for (const k of [...PARTS, 'total']) t[k] += s[k];
        t.sessions++; t.last = Math.max(t.last, s.last);
        tickets.set(tk, t);
      } else {
        you += s.total;
        sessions.push({ label: o.label, title: o.title, sid: o.sid, ...s });
      }
    }
    const shape = (x) => ({ ...x, percent: pct(x.total), main: pct(x.main), design: pct(x.design), review: pct(x.review), other: pct(x.other), last: x.last ? new Date(x.last + BUCKET).toISOString() : null });
    const measured = weekly && name !== 'week' ? percentAt(stateDir, since, weekly.resets_at) : null;
    out.windows[name] = {
      since: new Date(since).toISOString(),
      percent: pct(factory + you),
      measured: measured == null ? (name === 'week' && weekly ? weekly.percent : null) : Math.round((weekly.percent - measured) * 10) / 10,
      factory: pct(factory), you: pct(you), parts: Object.fromEntries(PARTS.map((k) => [k, pct(parts[k])])),
      tickets: [...tickets.values()].sort((x, y) => y.total - x.total).map((t) => {
        const n = /^factory-(\d+)$/.exec(t.worktree)?.[1];
        const known = n ? titles.get(`${t.repo}#${n}`) : null;
        const tick = t.worktree === 'tick';
        return shape({ ...t, key: tick ? 'Triage and planning' : n ? `#${n}` : t.worktree.replace(/^factory-/, ''), title: known?.title || (tick ? 'the tick\u2019s headless runs' : n ? null : 'branch target'), url: known?.url || null });
      }),
      sessions: sessions.sort((x, y) => y.total - x.total).map(shape),
    };
  }
  return out;
}
