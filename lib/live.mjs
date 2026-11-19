// What each worker is doing right now, read from its transcripts on disk (no GitHub calls, so the dashboard can poll it
// every few seconds): the step of the /factory loop it is on, its context and token use, the background agents it is
// waiting on, its latest messages, and an estimate of when the piece ends from how long past pieces spent per step.
import fs from 'node:fs';
import path from 'node:path';
import { HANDOFF_CONTEXT_TOKENS } from './common.mjs';

export const PHASES = ['triage', 'design', 'build', 'review', 'e2e', 'checks', 'ship'];
const AGENT_ACTIVE_MS = 120000;

const SKILL_PHASE = {
  design: 'design', 'review-loop': 'review', 'review-multi-model': 'review', 'e2e-verify': 'e2e',
  'local-ci': 'checks', 'babysit-pr': 'ship', 'split-pr': 'ship',
};

// The step a main-thread tool call is evidence of, or null when it says nothing about the step.
export function stripHeredocs(cmd) {
  const out = [];
  let end = null;
  for (const line of cmd.split('\n')) {
    if (end !== null) { if (line.trim() === end) end = null; continue; }
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/);
    if (m) end = m[2];
  }
  return out.join('\n');
}

export function phaseOf(name, input = {}) {
  if (name === 'Skill') return SKILL_PHASE[input.skill] || null;
  if (name === 'Agent') {
    const d = String(input.description || '');
    if (/design|critic|architect/i.test(d)) return 'design';
    if (/review/i.test(d)) return 'review';
    if (/e2e|end-to-end|playwright/i.test(d)) return 'e2e';
    if (/implement|build|slice|fix|write/i.test(d)) return 'build';
    return null;
  }
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
    const f = String(input.file_path || input.notebook_path || '');
    return f && !/\/\.context\/|\/\.git\//.test(f) ? 'build' : null;
  }
  if (name !== 'Bash') return null;
  const raw = String(input.command || '');
  // A heredoc body is text the worker writes (a handoff, a brief, a commit message) and names steps it isn't on. Only
  // the script around it is evidence, plus a Python edit whose target is a source file.
  if (/python3? - <</.test(raw) && /open\(p, ?'w'\)/.test(raw) && [...raw.matchAll(/\bp ?= ?['"]([^'"]+)['"]/g)].some((m) => !m[1].includes('.context/'))) return 'build';
  const c = stripHeredocs(raw);
  if (/\bgit push\b|gh pr create/.test(c)) return 'ship';
  if (/local-ci/.test(c)) return 'checks';
  if (/e2e-evidence|e2e-verify/.test(c)) return 'e2e';
  if (/\/design\/run-/.test(c)) return 'design';
  if (/review-multi-model\/run-|review-loop|codex exec/.test(c)) return 'review';
  if (/open\(p, ?'w'\)|sed -i|perl -pi|\bgit commit\b/.test(c)) return 'build';
  return null;
}

function toolLabel(name, input = {}) {
  if (name === 'Bash') return input.description || String(input.command || '').split('\n')[0].slice(0, 120);
  if (name === 'Agent') return input.description || 'subagent';
  if (name === 'Skill') return `/${input.skill}`;
  if (input.file_path) return `${name} ${path.basename(String(input.file_path))}`;
  return name;
}

const fileCache = new Map();

// One transcript, parsed once per (size, mtime). Main-thread facts only, except the token totals, which a subagent's
// own file contributes through its own parse.
function parseTranscript(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = fileCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.result;
  const r = {
    file, start: null, end: null, readTokens: 0, outTokens: 0, contextNow: 0, contextMax: 0,
    signals: [], texts: [], lastTool: null, reviewRuns: new Set(), reviewRound: 0, designRounds: 0, endedWithHandoff: false,
  };
  const open = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.timestamp) { r.start ??= d.timestamp; r.end = d.timestamp; }
    const main = !d.isSidechain || file.includes(`${path.sep}subagents${path.sep}`);
    if (d.type === 'assistant' && d.message?.usage) {
      const u = d.message.usage;
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      r.readTokens += ctx;
      r.outTokens += u.output_tokens || 0;
      if (main) { r.contextNow = ctx; r.contextMax = Math.max(r.contextMax, ctx); }
    }
    if (!main) continue;
    if (d.type === 'assistant') {
      for (const c of d.message?.content || []) {
        if (c.type === 'text' && c.text?.trim()) {
          r.texts.push({ at: d.timestamp, text: c.text.trim().slice(0, 1200) });
          r.endedWithHandoff = c.text.trim().split('\n').pop().trim() === 'FACTORY: handoff';
        }
        if (c.type !== 'tool_use') continue;
        const phase = phaseOf(c.name, c.input);
        if (phase) r.signals.push({ at: d.timestamp, phase });
        const cmd = c.name === 'Bash' ? String(c.input?.command || '') : '';
        for (const m of cmd.matchAll(/review-multi-model\/(run-[\w-]+)/g)) r.reviewRuns.add(m[1]);
        for (const m of cmd.matchAll(/design-r(\d+)\.md/g)) r.designRounds = Math.max(r.designRounds, Number(m[1]));
        const round = phase === 'review' && c.name === 'Agent' && String(c.input?.description || '').match(/round (\d+)/i);
        if (round) r.reviewRound = Math.max(r.reviewRound, Number(round[1]));
        r.lastTool = { at: d.timestamp, name: c.name, label: toolLabel(c.name, c.input), done: false };
        open.set(c.id, r.lastTool);
      }
    }
    if (d.type === 'user' && Array.isArray(d.message?.content)) {
      for (const c of d.message.content) if (c.type === 'tool_result' && open.has(c.tool_use_id)) open.get(c.tool_use_id).done = true;
    }
  }
  r.texts = r.texts.slice(-6);
  fileCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result: r });
  return r;
}

export function projectDir(worktree) {
  return path.join(process.env.HOME, '.claude', 'projects', worktree.replace(/[^a-zA-Z0-9]/g, '-'));
}

// The main-session transcripts of one piece: every session in its worktree that ran after the piece was claimed (and,
// for a finished piece, before it ended). Branch-mode targets reuse one worktree, so the window is what separates pieces.
function pieceSessions(worktree, from, to) {
  const dir = projectDir(worktree);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const lo = new Date(from).getTime() - 60000;
  const hi = to ? new Date(to).getTime() : Infinity;
  return names.map((f) => parseTranscript(path.join(dir, f)))
    .filter((r) => r?.start && new Date(r.end).getTime() >= lo && new Date(r.start).getTime() <= hi)
    .sort((a, b) => a.start.localeCompare(b.start));
}

function subagentsOf(session) {
  const dir = session.file.replace(/\.jsonl$/, '');
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'subagents')).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  return names.map((f) => {
    const file = path.join(dir, 'subagents', f);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch {}
    const r = parseTranscript(file);
    const mtime = fs.statSync(file).mtimeMs;
    return { description: meta.description || f, model: meta.model || null, active: Date.now() - mtime < AGENT_ACTIVE_MS, last_write: new Date(mtime).toISOString(), started: r?.start, readTokens: r?.readTokens || 0, outTokens: r?.outTokens || 0, contextNow: r?.contextNow || 0 };
  });
}

// When the piece first reached each step. Steps only move forward: a fix after a review finding is still the review.
export function timelineOf(sessions, startedAt, endedAt = null) {
  const reached = { triage: startedAt };
  let at = 0;
  for (const s of sessions) {
    for (const sig of s.signals) {
      if (sig.at < startedAt || (endedAt && sig.at > endedAt)) continue;
      const i = PHASES.indexOf(sig.phase);
      if (i > at) { at = i; reached[sig.phase] = sig.at; }
    }
  }
  return { phase: PHASES[at], reached };
}

function pieceFacts(worktree, startedAt, endedAt) {
  const sessions = pieceSessions(worktree, startedAt, endedAt);
  const { phase, reached } = timelineOf(sessions, new Date(startedAt).toISOString(), endedAt ? new Date(endedAt).toISOString() : null);
  return { sessions, phase, reached };
}

// ---------- estimates from finished pieces ----------
let history = { at: 0, pieces: [] };

// Finished pieces from the tick log: claimed (dispatch) to the tick removing its finished worker.
function finishedPieces(cfg, sinceDays = 21) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(cfg.tick.state_dir, 'tick.log'), 'utf8').split('\n'); } catch { return []; }
  const since = Date.now() - sinceDays * 864e5;
  const open = new Map();
  const done = [];
  for (const l of lines) {
    if (l.includes('[dry]')) continue;
    const m = l.match(/^\[(.+?)\] (.*)$/);
    if (!m || new Date(m[1]).getTime() < since) continue;
    let r;
    if ((r = m[2].match(/^dispatch worker for ([\w-]+#\d+)(?:\+\S+)* in (\S+)/))) open.set(r[1], { key: r[1], worktree: r[2], start: m[1] });
    else if ((r = m[2].match(/finished worker for ([\w-]+#\d+)/)) && open.has(r[1])) { done.push({ ...open.get(r[1]), end: m[1] }); open.delete(r[1]); }
  }
  return done;
}

export function refreshHistory(cfg) {
  const pieces = [];
  for (const p of finishedPieces(cfg)) {
    const { sessions, reached } = pieceFacts(p.worktree, p.start, p.end);
    if (!sessions.length) continue;
    const times = PHASES.filter((ph) => reached[ph]).map((ph) => ({ ph, t: new Date(reached[ph]).getTime() }));
    const spent = {};
    times.forEach((x, i) => { spent[x.ph] = ((times[i + 1]?.t ?? new Date(p.end).getTime()) - x.t) / 60000; });
    pieces.push({ key: p.key, repo: p.key.split('#')[0], minutes: (new Date(p.end) - new Date(p.start)) / 60000, spent });
  }
  history = { at: Date.now(), pieces };
  for (const k of fileCache.keys()) if (!fs.existsSync(k)) fileCache.delete(k);
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

// Typical minutes left: what remains of the current step (its typical length minus the time already in it, never below
// zero) plus each later step's typical length, weighted by how often past pieces went through it at all.
export function estimate(phase, minutesInPhase, pieces = history.pieces) {
  if (pieces.length < 5) return null;
  const i = PHASES.indexOf(phase);
  let left = 0;
  const cur = median(pieces.map((p) => p.spent[phase]).filter((x) => x != null));
  const over = cur != null && minutesInPhase > cur ? minutesInPhase - cur : 0;
  if (cur != null) left += Math.max(cur - minutesInPhase, 0);
  for (const ph of PHASES.slice(i + 1)) {
    const xs = pieces.map((p) => p.spent[ph]).filter((x) => x != null);
    if (xs.length) left += (xs.length / pieces.length) * median(xs);
  }
  return { minutes_left: Math.round(left), over_typical_min: Math.round(over), basis: pieces.length, typical_piece_min: Math.round(median(pieces.map((p) => p.minutes))) };
}

export function typicalByPhase(repo) {
  const pieces = history.pieces.filter((p) => !repo || p.repo === repo);
  return Object.fromEntries(PHASES.map((ph) => {
    const xs = pieces.map((p) => p.spent[ph]).filter((x) => x != null);
    return [ph, xs.length ? { median_min: Math.round(median(xs)), share: Math.round((xs.length / pieces.length) * 100) } : null];
  }));
}

// ---------- the live view ----------
export function liveAgent(agent, now = Date.now()) {
  if (!agent.worktree_path || !agent.started_at) return { lead: agent.lead, repo: agent.repo, error: 'no worktree or claim time' };
  const { sessions, phase, reached } = pieceFacts(agent.worktree_path, agent.started_at, null);
  const cur = sessions.at(-1) || null;
  const agents = cur ? subagentsOf(cur) : [];
  const allAgents = sessions.flatMap((s) => (s === cur ? agents : subagentsOf(s)));
  const minutesInPhase = (now - new Date(reached[phase]).getTime()) / 60000;
  const reviewRuns = new Set(sessions.flatMap((s) => [...s.reviewRuns]));
  return {
    lead: agent.lead, repo: agent.repo, stream: agent.stream, tickets: agent.tickets, started_at: agent.started_at,
    phase, reached, minutes_in_phase: Math.round(minutesInPhase), minutes_total: Math.round((now - new Date(agent.started_at).getTime()) / 60000),
    review_rounds: Math.max(0, ...sessions.map((s) => s.reviewRound)) || reviewRuns.size, design_rounds: Math.max(0, ...sessions.map((s) => s.designRounds)),
    sessions: sessions.length, handoffs: sessions.filter((s) => s.endedWithHandoff).length,
    context_now: cur?.contextNow || 0, context_limit: HANDOFF_CONTEXT_TOKENS,
    read_tokens: sessions.reduce((n, s) => n + s.readTokens, 0) + allAgents.reduce((n, a) => n + a.readTokens, 0),
    out_tokens: sessions.reduce((n, s) => n + s.outTokens, 0) + allAgents.reduce((n, a) => n + a.outTokens, 0),
    last_activity: [cur?.end, ...agents.map((a) => a.last_write)].filter(Boolean).sort().at(-1) || null,
    last_tool: cur?.lastTool || null,
    background: agents.filter((a) => a.active).map((a) => ({ description: a.description, last_write: a.last_write, started: a.started, context_now: a.contextNow })),
    messages: cur ? cur.texts.slice(-4).reverse() : [],
    estimate: estimate(phase, minutesInPhase, history.pieces.filter((p) => p.repo === agent.repo)),
  };
}

export function historyAge() { return history.at; }
