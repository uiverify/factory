#!/usr/bin/env node
// factory-tick: one reconcile pass over Linear + GitHub + local Claude sessions.
// No LLM in the control loop. The only Claude invocations are explicit: a worker
// (`/factory-auto`), a babysit pass, a triage call, a package-planning call.
//
//   node bin/factory-tick.mjs [--dry-run] [--verbose] [--only=<target>]
//
// State of record is Linear: ticket status + one `<!-- factory-state -->` comment per
// ticket. Local files under state/ are caches (signal hashes, lock, log).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  ROOT, STATE_MARK, TRIAGE_MARK, QUESTION_MARK, VERDICT_MARK, loadConfig, sh, listSessions, sessionFor, sessionBusy,
  readCache, writeCache, minutesAgo, keyPattern, ownerMention, isTrustedBot,
} from '../lib/common.mjs';
import * as Linear from '../lib/linear.mjs';
import { fetchTargetIssues, findMarked, parseMarked, hasLabel, priorityRank, openBlockers } from '../lib/linear.mjs';
import { openFactoryPrs, prsForTicket, prSignals, topOfStack, leadOfBranch, ownsPr } from '../lib/github.mjs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const cfg = loadConfig();
const STATE_DIR = cfg.tick.state_dir;

function log(...a) {
  const line = `[${new Date().toISOString()}]${DRY ? ' [dry]' : ''} ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(STATE_DIR, 'tick.log'), line + '\n');
}
function vlog(...a) {
  if (VERBOSE) log('  ', ...a);
}
function act(desc, fn) {
  log(desc);
  if (DRY) return null;
  return fn();
}
function cachePath(name) {
  return path.join(STATE_DIR, name);
}

// ---------- lock ----------
function acquireLock() {
  const lock = cachePath('tick.lock');
  if (fs.existsSync(lock)) {
    const { pid, at } = JSON.parse(fs.readFileSync(lock, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive && minutesAgo(at) < cfg.tick.lock_stale_minutes) {
      log(`another tick (pid ${pid}) is running; exiting`);
      process.exit(0);
    }
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  process.on('exit', () => {
    try {
      fs.unlinkSync(lock);
    } catch {}
  });
}

// ---------- Linear writes ----------
async function bootstrapLinear() {
  const L = await Linear.bootstrapLinear(cfg);
  for (const name of L.missingLabels) vlog(`label "${name}" not found; that triage verdict is comment-only`);
  return L;
}
function renderState(state) {
  return [STATE_MARK, '**Factory state** (machine-owned; humans: do not edit)', '', '```json', JSON.stringify(state, null, 2), '```'].join('\n');
}
async function writeState(issue, state) {
  const existing = findMarked(issue, STATE_MARK);
  state.updated_at = new Date().toISOString();
  const body = renderState(state);
  if (existing) {
    await act(`update state comment on ${issue.identifier}`, () => Linear.updateComment(existing.id, body));
    existing.body = body;
  } else {
    const id = await act(`create state comment on ${issue.identifier}`, () => Linear.createComment(issue.id, body));
    issue.comments = issue.comments || { nodes: [] };
    issue.comments.nodes.push({ id: id || 'dry', body, createdAt: new Date().toISOString(), user: null });
  }
}
async function updateIssue(issue, input, why) {
  await act(`update ${issue.identifier} (${why}): ${JSON.stringify(input)}`, () => Linear.updateIssue(issue.id, input));
}
async function addComment(issue, body, why) {
  await act(`comment on ${issue.identifier} (${why})`, () => Linear.createComment(issue.id, body));
}

// ---------- Claude invocations ----------
function workerEnv() {
  return { ...process.env, ...(cfg.workers.env || {}), FACTORY_PRINCIPLES: cfg.principles_file, FACTORY_ROOT: ROOT };
}
function claudeBg({ cwd, prompt, resume, model, extraArgs = [] }) {
  // A wake resumes the conversation as a copy that carries the worker flags (a resume with flags always copies, and a
  // copy without them waits on permission prompts), then removes the old session: one session per worktree, history kept.
  if (resume) {
    try { sh('claude', ['stop', resume.slice(0, 8)], { timeout: 30000 }); } catch {}
    // stop returns before the session is down; two live sessions in one worktree would edit the same files.
    for (let i = 0; i < 15 && ['working', 'running', 'blocked'].includes((listSessions() || []).find((x) => x.sessionId === resume)?.state); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  const args = ['--bg', ...(resume ? ['--resume', resume] : ['--name', path.basename(cwd)]), ...(model ? ['--model', model] : []),
    ...(cfg.workers.effort && !resume ? ['--effort', cfg.workers.effort] : []), ...(cfg.workers.claude_args || []), ...extraArgs, prompt];
  vlog('$ claude', args.slice(0, -1).join(' '), '<prompt>');
  const r = spawnSync('claude', args, { cwd, env: workerEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  if (r.status !== 0) {
    // A removed session cannot be woken: start a fresh one in the same worktree rather than failing the whole tick.
    if (resume) return claudeBg({ cwd, prompt, model: model || cfg.workers.model, extraArgs });
    throw new Error(`claude --bg failed: ${r.stderr || r.stdout}`);
  }
  const out = (r.stdout || '').trim();
  const started = out.match(/backgrounded · ([0-9a-f]{8})/)?.[1];
  if (resume && started && started !== resume.slice(0, 8)) {
    try { sh('claude', ['rm', resume.slice(0, 8)], { timeout: 30000 }); } catch (e) { log('claude rm of the old session failed:', String(e.message).split('\n')[0]); }
  }
  return out;
}
function claudeJson({ cwd, prompt, model, schema, timeoutMs = 15 * 60 * 1000 }) {
  const args = ['-p', '--output-format', 'json', '--model', model || 'sonnet', ...(cfg.workers.claude_args || [])];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  args.push(prompt);
  const r = spawnSync('claude', args, { cwd, env: workerEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`claude -p failed: ${(r.stderr || r.stdout || '').slice(0, 2000)}`);
  const envelope = JSON.parse(r.stdout);
  if (envelope.structured_output) return envelope.structured_output;
  const text = typeof envelope.result === 'string' ? envelope.result : JSON.stringify(envelope.result);
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text);
}

function claudeJsonAsync({ cwd, prompt, model, schema, timeoutMs = 15 * 60 * 1000 }) {
  const args = ['-p', '--output-format', 'json', '--model', model || 'sonnet', ...(cfg.workers.claude_args || [])];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  args.push(prompt);
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env: workerEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('claude -p timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude -p failed: ${(err || out).slice(0, 2000)}`));
      try {
        const envelope = JSON.parse(out);
        if (envelope.structured_output) return resolve(envelope.structured_output);
        const text = typeof envelope.result === 'string' ? envelope.result : JSON.stringify(envelope.result);
        const m = text.match(/\{[\s\S]*\}/);
        resolve(JSON.parse(m ? m[0] : text));
      } catch (e) { reject(e); }
    });
  });
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) { const i = next++; if (i >= items.length) return; results[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- worktrees ----------
function ensureWorktree(key, base = cfg.repo.base) {
  const wt = path.join(cfg.repo.worktrees_dir, key);
  const branch = `${cfg.repo.branch_prefix}${key.toLowerCase()}`;
  if (fs.existsSync(wt)) return { wt, branch, created: false };
  fs.mkdirSync(cfg.repo.worktrees_dir, { recursive: true });
  act(`git fetch ${cfg.repo.remote}`, () => sh('git', ['fetch', '--prune', cfg.repo.remote], { cwd: cfg.repo.path }));
  act(`git worktree add ${wt} (${branch} from ${cfg.repo.remote}/${base})`, () => {
    try {
      sh('git', ['worktree', 'add', '-b', branch, wt, `${cfg.repo.remote}/${base}`], { cwd: cfg.repo.path });
    } catch {
      sh('git', ['worktree', 'add', wt, branch], { cwd: cfg.repo.path });
    }
  });
  // Every session here runs unattended, including a copy that `--resume` starts without the original's flags.
  act(`bypass permissions in ${wt}`, () => {
    fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }, null, 2) + '\n');
  });
  if (cfg.repo.setup) act(`setup worktree: ${cfg.repo.setup}`, () => sh('sh', ['-c', cfg.repo.setup], { cwd: wt, stdio: ['ignore', 'ignore', 'pipe'], timeout: 600000 }));
  return { wt, branch, created: true };
}
function removeWorktree(wt) {
  if (!fs.existsSync(wt)) return;
  act(`git worktree remove ${wt}`, () => {
    try {
      sh('git', ['worktree', 'remove', '--force', wt], { cwd: cfg.repo.path });
    } catch (e) {
      log('worktree remove failed:', String(e.message).split('\n')[0]);
    }
  });
}

// A hold that only a trusted review bot approved waits on the owner's call, not on a reviewer: tell them once per PR.
// With no trusted bots configured every approval is a human's, so this never fires.
async function pingHolds(issue, st, views) {
  if (!cfg.merge.trusted_bot_reviewers.length) return;
  const waiting = views.filter(({ number, view }) => {
    const verdict = (view.comments || []).find((c) => c.body.startsWith(VERDICT_MARK));
    const humanApproved = (view.reviews || []).some((r) => r.state === 'APPROVED' && !isTrustedBot(cfg, r.author?.login));
    return view.reviewDecision === 'APPROVED' && verdict && /merge verdict:\W*hold/i.test(verdict.body) && !humanApproved && !(st.pinged_holds || []).includes(number);
  });
  if (!waiting.length) return;
  const lines = waiting.map(({ number, view }) => {
    const verdict = view.comments.find((c) => c.body.startsWith(VERDICT_MARK)).body.replace(VERDICT_MARK, '').trim();
    return `${slackLink(view.url, `#${number} ${view.title}`)}\n${verdict.split('\n')[0].replace(/^\*\*merge verdict:[^*]*\*\*\s*/i, '')}`;
  });
  await notify(`Factory hold needs your call (${issue.identifier}): a review bot approved, the factory held it.\n\n${lines.join('\n\n')}\n\nMerge it if you agree (a stack merges bottom first), or comment on the PR what to change.`, waiting[0].view.url);
  st.pinged_holds = [...(st.pinged_holds || []), ...waiting.map((w) => w.number)];
  await writeState(issue, st);
}

// Subagent worktrees (agent-*) are left behind when they hold commits. Their branches keep the commits,
// so a clean one older than 3 days only costs disk. A detached HEAD may hold the only copy: keep it.
function sweepAgentWorktrees() {
  let dirs = [];
  try { dirs = fs.readdirSync(cfg.repo.worktrees_dir).filter((d) => d.startsWith('agent-')); } catch { return; }
  for (const d of dirs) {
    const wt = path.join(cfg.repo.worktrees_dir, d);
    if (minutesAgo(fs.statSync(wt).mtime) < 3 * 24 * 60) continue;
    try {
      if (sh('git', ['status', '--porcelain'], { cwd: wt }).trim()) continue;
      if (sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt }).trim() === 'HEAD') continue;
    } catch { continue; }
    removeWorktree(wt);
  }
}

// ---------- notify ----------
// Slack mrkdwn link; the relay posts text verbatim, so a bare "#123" would not be clickable.
function slackLink(url, label) {
  return `<${url}|${label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '/')}>`;
}
// macOS banner; clicking it opens the URL. Runs in the launchd GUI session, so it reaches the owner's screen.
function desktopNotify(text, url) {
  if (DRY) return;
  const [title, ...rest] = text.replace(/<([^|>]+)\|([^>]+)>/g, '$2').split('\n').filter(Boolean);
  const args = ['-title', 'Factory', '-subtitle', title.slice(0, 120), '-message', (rest[0] || title).slice(0, 200), '-sound', 'default'];
  if (url) args.push('-open', url);
  try { sh('terminal-notifier', args, { timeout: 10000 }); } catch (e) { vlog('desktop notify failed (terminal-notifier installed?):', String(e.message).split('\n')[0]); }
}
async function notify(text, url) {
  desktopNotify(text, url);
  if (!cfg.notify?.relay_webhook) return log('notify (no relay configured):', text);
  await act(`notify: ${text.split('\n')[0]}`, async () => {
    const res = await fetch(cfg.notify.relay_webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(30000) });
    if (!res.ok) log('relay returned', res.status);
  });
}

// ---------- the pass ----------
async function main() {
  acquireLock();
  const started = Date.now();
  const L = await bootstrapLinear();
  const sessions = listSessions();
  if (sessions === null) {
    log('claude CLI is not reachable from this process (PATH?); refusing to dispatch, resume, wake or triage this tick');
    return;
  }
  const signalCache = readCache(cfg, 'signals.json', {});
  const summary = { targets: {}, busy: 0, dispatched: [], woke: [], parked: [], resumed: [], triaged: [], done: [] };
  const busySessions = sessions.filter((s) => sessionBusy(s) && s.cwd && s.cwd.startsWith(cfg.repo.worktrees_dir));
  summary.busy = busySessions.length;

  // Every open factory PR, once per tick: the review cap, stacking bases, and integration-moved tickets read it.
  const factoryPrs = openFactoryPrs(cfg);

  sweepAgentWorktrees();

  const S = cfg.linear.states;
  const activeStateNames = [S.backlog, S.ready, S.in_progress, S.in_review];
  const closedStateNames = [S.done, S.canceled];

  for (const target of cfg.targets) {
    if (ONLY && target.name !== ONLY) continue;
    if (target.runtime && target.runtime !== 'local') continue;
    if (target.paused) {
      log(`target ${target.name}: paused`);
      continue;
    }
    const issues = await fetchTargetIssues(target, activeStateNames);
    const closed = (await fetchTargetIssues(target, closedStateNames)).filter((i) => findMarked(i, STATE_MARK) && minutesAgo(i.updatedAt) < 7 * 24 * 60);
    const byState = (role) => issues.filter((i) => i.state.name === S[role]);
    const targetPrs = factoryPrs.filter((p) => issues.some((i) => i.identifier === leadOfBranch(cfg, p.headRefName)));
    const babysitArgs = target.reviewers?.length ? ` reviewers: ${target.reviewers.join(' ')}` : '';
    const babysitCall = (pr) => `${cfg.babysit.command} ${pr}${babysitArgs}`;
    const t = (summary.targets[target.name] = { backlog: byState('backlog').length, ready: byState('ready').length, in_progress: byState('in_progress').length, in_review: byState('in_review').length });
    log(`target ${target.name}: ${JSON.stringify(t)}`);

    // 1. Closed tickets: clean up worktrees once every PR of the package is closed.
    for (const issue of closed) {
      const st = parseMarked(findMarked(issue, STATE_MARK));
      if (!st?.worktree || st.cleaned || st.lead !== issue.identifier) continue;
      const openPrs = (st.package || [issue.identifier]).flatMap((k) => prsForTicket(cfg, k)).filter((p) => p.state === 'OPEN');
      if (openPrs.length) continue;
      const doneSession = sessionFor(sessions, st.worktree);
      if (sessionBusy(doneSession)) continue;
      if (doneSession?.id) act(`claude rm ${doneSession.id} (finished worker for ${issue.identifier})`, () => { try { sh('claude', ['rm', doneSession.id]); } catch {} });
      removeWorktree(st.worktree);
      st.cleaned = true;
      await writeState(issue, st);
      summary.done.push(issue.identifier);
    }

    // 2. Parked tickets (Needs Info): resume on a human reply, or notify once.
    for (const issue of issues.filter((i) => hasLabel(i, cfg.linear.needs_human_label))) {
      const st = parseMarked(findMarked(issue, STATE_MARK));
      if (!st?.parked_at) continue;
      const reply = (issue.comments?.nodes || [])
        .filter((c) => new Date(c.createdAt) > new Date(st.parked_at) && !c.body.trimStart().startsWith('<!--'))
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
      if (reply) {
        const s = sessionFor(sessions, st.worktree);
        const prompt = `${cfg.owner.name} answered on ${issue.identifier}:\n\n"""\n${reply.body}\n"""\n\nContinue the work from that answer. Record it under Decisions taken. Do not ask again. Factory mode: no AskUserQuestion; escalate only per the principles file at ${cfg.principles_file}.`;
        act(`resume ${issue.identifier} with the human answer`, () =>
          claudeBg({ cwd: st.worktree, prompt, resume: s?.sessionId || st.session || undefined, model: s ? undefined : cfg.workers.model }),
        );
        await updateIssue(issue, { removedLabelIds: [L.needsHuman.id], stateId: L.stateByRole.in_progress.id }, 'answered');
        st.parked_at = null;
        st.notified = null;
        st.lease_until = new Date(Date.now() + cfg.workers.lease_minutes * 60000).toISOString();
        await writeState(issue, st);
        summary.resumed.push(issue.identifier);
      } else if (!st.notified) {
        const q = findMarked(issue, QUESTION_MARK);
        const excerpt = q ? q.body.replace(QUESTION_MARK, '').trim().slice(0, 600) : '(see ticket)';
        await notify(`Factory needs you: ${slackLink(issue.url, `${issue.identifier} ${issue.title}`)}\n\n${excerpt}\n\nReply as a comment on the ticket.`, issue.url);
        st.notified = new Date().toISOString();
        await writeState(issue, st);
        summary.parked.push(issue.identifier);
      }
    }

    // 2b. Linear's GitHub integration sets a ticket In Progress when a factory PR only mentions it. Nobody works on it
    //     then, and it blocks the tickets behind it, so put it back where it was.
    for (const issue of byState('in_progress').filter((i) => !findMarked(i, STATE_MARK))) {
      const key = keyPattern(issue.identifier);
      const mention = new RegExp(`\\b${key}\\b`, 'i');
      const fixes = new RegExp(`^\\s*(?:fixes|closes|resolves)\\b[^\\n]*\\b${key}\\b`, 'im');
      const mentioners = factoryPrs.filter((p) => mention.test(p.body || '') && !mention.test(p.title) && !fixes.test(p.body || ''));
      if (!mentioners.length) continue;
      const move = (await Linear.issueHistory(issue.id)).find((e) => e.toState);
      if (move?.toState.name !== S.in_progress || !move.fromState) continue;
      const pr = mentioners.find((p) => Math.abs(new Date(move.createdAt) - new Date(p.createdAt)) < 2 * 60000);
      if (!pr) continue;
      await updateIssue(issue, { stateId: move.fromState.id }, `the GitHub integration set it In Progress when #${pr.number} mentioned it`);
      await addComment(issue, `The factory moved this back to ${move.fromState.name}. Linear's GitHub integration set it In Progress when factory PR #${pr.number} mentioned it, but nobody is working on it.`, 'integration move undone');
    }

    // 3. In Progress: dead session with no PR -> resume; too many restarts -> park.
    for (const issue of byState('in_progress').filter((i) => !hasLabel(i, cfg.linear.needs_human_label))) {
      const st = parseMarked(findMarked(issue, STATE_MARK));
      if (!st?.worktree || st.lead !== issue.identifier) continue;
      const s = sessionFor(sessions, st.worktree);
      if (sessionBusy(s)) continue;
      const prs = (st.package || [issue.identifier]).flatMap((k) => prsForTicket(cfg, k));
      if (prs.some((p) => p.state === 'OPEN' || p.mergedAt)) {
        for (const k of st.package || [issue.identifier]) {
          const member = issues.find((i) => i.identifier === k);
          if (member && member.state.name === S.in_progress) await updateIssue(member, { stateId: L.stateByRole.in_review.id }, 'PR exists');
        }
        st.prs = prs.map((p) => p.number);
        await writeState(issue, st);
        continue;
      }
      if (st.lease_until && new Date(st.lease_until) > new Date()) continue;
      if ((st.restarts || 0) >= cfg.workers.max_restarts) {
        await addComment(issue, `${QUESTION_MARK}\n${ownerMention(cfg)}: the factory worker for ${issue.identifier} stopped ${st.restarts} times without opening a PR. Last session: ${st.session || 'unknown'}. Tell me how to proceed (retry, split, or cancel).`, 'restart budget spent');
        await updateIssue(issue, { addedLabelIds: [L.needsHuman.id] }, 'restart budget spent');
        st.parked_at = new Date().toISOString();
        await writeState(issue, st);
        summary.parked.push(issue.identifier);
        continue;
      }
      const prompt = `Continue /factory-auto for ${(st.package || [issue.identifier]).join(' ')}. The previous session ended without a PR. Read the factory state comment on the ticket, finish the work, open the PR(s), then run \`${cfg.babysit.command} <top PR>${babysitArgs}\` once. Factory mode: no AskUserQuestion; escalate only per ${cfg.principles_file}.`;
      act(`resume dead worker for ${issue.identifier} (restart ${(st.restarts || 0) + 1})`, () =>
        claudeBg({ cwd: st.worktree, prompt, resume: s?.sessionId || st.session || undefined, model: s ? undefined : cfg.workers.model }),
      );
      st.restarts = (st.restarts || 0) + 1;
      st.lease_until = new Date(Date.now() + cfg.workers.lease_minutes * 60000).toISOString();
      await writeState(issue, st);
      summary.resumed.push(issue.identifier);
    }

    // 4. In Review: wake one babysit tick when the PR signals changed (or heartbeat is due).
    if (cfg.babysit?.enabled) {
      // One babysit per package while any of its tickets is In Review. The lead's ticket can already be Done when
      // its own PR merged first, so the lead is looked up among closed tickets too.
      const reviewLeads = new Map();
      for (const i of byState('in_review').filter((x) => !hasLabel(x, cfg.linear.needs_human_label))) {
        const lead = parseMarked(findMarked(i, STATE_MARK))?.lead;
        if (lead && !reviewLeads.has(lead)) reviewLeads.set(lead, [...issues, ...closed].find((x) => x.identifier === lead) || i);
      }
      for (const issue of reviewLeads.values()) {
        const st = parseMarked(findMarked(issue, STATE_MARK));
        if (!st?.worktree) continue;
        const s = sessionFor(sessions, st.worktree);
        const prs = (st.package || [issue.identifier]).flatMap((k) => prsForTicket(cfg, k));
        const open = prs.filter((p) => p.state === 'OPEN');
        if (!open.length) continue;
        let changed = false;
        const parts = [];
        const fresh = {};
        const views = [];
        for (const p of open) {
          const { hash: h, view } = prSignals(cfg, p.number);
          fresh[p.number] = h;
          parts.push(`#${p.number}:${h}`);
          views.push({ number: p.number, view });
          if (signalCache[p.number] !== h) changed = true;
        }
        await pingHolds(issue, st, views);
        if (sessionBusy(s)) continue;
        const lastWake = st.last_babysit ? minutesAgo(st.last_babysit) : Infinity;
        // A PR that is red or conflicting gets retried even when nothing changed: the agent may have given up on a
        // failure that main has since fixed. Every quiet retry doubles the wait (1h, 2h, 4h), capped at the heartbeat.
        const maxWait = (cfg.babysit.heartbeat_hours || 6) * 60;
        const broken = views.some(({ view }) => ['DIRTY', 'BEHIND'].includes(view.mergeStateStatus)
          || (view.statusCheckRollup || []).some((c) => ['FAILURE', 'ERROR', 'TIMED_OUT'].includes(c.conclusion || c.state)));
        const heartbeatDue = lastWake > (broken ? Math.min(60 * 2 ** (st.quiet_wakes || 0), maxWait) : maxWait);
        if (!changed && !heartbeatDue) continue;
        const top = topOfStack(prs);
        act(`babysit ${issue.identifier} -> PR #${top.number} (${changed ? 'signals changed' : broken ? `retry ${(st.quiet_wakes || 0) + 1} of a red or conflicting PR` : 'heartbeat'}; ${parts.join(' ')})`, () =>
          claudeBg({ cwd: st.worktree, prompt: `${babysitCall(top.number)}\n\nWhat the tick sees now: ${views.map(({ number, view }) => `#${number} merge=${view.mergeStateStatus} review=${view.reviewDecision || 'none'} base=${view.baseRefName} failing=${(view.statusCheckRollup || []).filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT'].includes(c.conclusion || c.state)).map((c) => c.name || c.context).join(',') || 'none'}`).join('; ')}. Conflicts or a base change come first: rebase, then judge CI again, since a failure can come from main.`, resume: s?.sessionId || st.session || undefined, model: s ? undefined : cfg.workers.model }),
        );
        if (!DRY) Object.assign(signalCache, fresh);
        st.last_babysit = new Date().toISOString();
        st.quiet_wakes = changed ? 0 : (st.quiet_wakes || 0) + 1;
        st.prs = prs.map((p) => p.number);
        await writeState(issue, st);
        summary.woke.push(issue.identifier);
      }
    }

    // 5. Triage: Backlog tickets without a verdict.
    if (cfg.triage?.enabled) {
      const untriaged = byState('backlog').filter((i) => !findMarked(i, TRIAGE_MARK) && !hasLabel(i, cfg.linear.needs_human_label)).slice(0, cfg.triage.max_per_tick || 20);
      const verdicts = await mapLimit(untriaged, cfg.triage.parallel || 4, async (issue) => {
        const schema = {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['ready', 'split', 'decide', 'later'] },
            priority: { type: 'integer', minimum: 1, maximum: 4 },
            reason: { type: 'string' },
            verify_added: { type: 'boolean' },
          },
          required: ['verdict', 'priority', 'reason'],
          additionalProperties: false,
        };
        const prompt = `/factory-triage ${issue.identifier}\n\nScope rule for this target: ${target.scope_rule}\nPrinciples file: ${cfg.principles_file}`;
        try {
          return DRY ? { verdict: 'ready', priority: 3, reason: 'dry run' } : await claudeJsonAsync({ cwd: cfg.repo.path, prompt, model: cfg.triage.model, schema });
        } catch (e) {
          log(`triage failed for ${issue.identifier}: ${String(e.message).slice(0, 300)}`);
          return null;
        }
      });
      for (const [idx, issue] of untriaged.entries()) {
        const verdict = verdicts[idx];
        if (!verdict) continue;
        log(`triage ${issue.identifier}: ${verdict.verdict} p${verdict.priority} (${verdict.reason.slice(0, 120)})`);
        await addComment(issue, `${TRIAGE_MARK}\n**Factory triage:** \`${verdict.verdict}\`, priority ${verdict.priority}. ${verdict.reason}\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``, 'triage');
        const input = { priority: verdict.priority };
        if (verdict.verdict === 'ready') input.stateId = L.stateByRole.ready.id;
        else if (L.triageLabels[verdict.verdict]?.id) input.addedLabelIds = [L.triageLabels[verdict.verdict].id];
        await updateIssue(issue, input, `triage ${verdict.verdict}`);
        summary.triaged.push(`${issue.identifier}:${verdict.verdict}`);
      }
    }

    // 6. Dispatch: ready tickets -> packages -> workers, under the caps.
    // In Review packages do not hold a slot: the review cap below limits how much waits on humans.
    const inFlight = byState('in_progress').filter((i) => findMarked(i, STATE_MARK)).length;
    const awaitingReview = targetPrs.filter((p) => p.reviewDecision !== 'APPROVED').length;
    const reviewCapHit = awaitingReview >= (target.max_awaiting_review ?? Infinity);
    if (reviewCapHit) log(`target ${target.name}: ${awaitingReview} PRs await review (cap ${target.max_awaiting_review}); starting nothing new`);
    let free = reviewCapHit ? 0 : Math.min(cfg.workers.max_concurrent - summary.busy - summary.dispatched.length, (target.max_in_flight || 99) - inFlight);
    // A ticket can start when every open blocker is a factory package in review: it stacks on that package's top PR.
    const baseOf = new Map();
    const stackBase = (issue) => {
      const open = openBlockers(issue);
      if (!open.length) return { base: null };
      if (target.build_on_unmerged === false) return null;
      const tops = new Map();
      for (const r of open) {
        const blocker = issues.find((i) => i.identifier === r.issue.identifier);
        const st = blocker && parseMarked(findMarked(blocker, STATE_MARK));
        if (!st?.lead || blocker.state.name !== S.in_review) return null;
        const top = topOfStack(targetPrs.filter((p) => ownsPr(cfg, st.lead, st.package, p)));
        if (!top) return null;
        tops.set(top.headRefName, top);
      }
      return tops.size === 1 ? { base: [...tops.keys()][0], parent: [...tops.values()][0] } : null;
    };
    const ready = byState('ready')
      .filter((i) => {
        if (hasLabel(i, cfg.linear.needs_human_label) || findMarked(i, STATE_MARK)) return false;
        const b = stackBase(i);
        if (b) baseOf.set(i.identifier, b);
        return !!b;
      })
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || new Date(a.createdAt) - new Date(b.createdAt));
    if (free > 0 && ready.length) {
      let packages = ready.map((i) => [i]);
      if (cfg.planner?.enabled && ready.length >= 2) {
        const schema = {
          type: 'object',
          properties: {
            packages: {
              type: 'array',
              items: {
                type: 'object',
                properties: { tickets: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
                required: ['tickets', 'reason'],
                additionalProperties: false,
              },
            },
          },
          required: ['packages'],
          additionalProperties: false,
        };
        const listing = ready.map((i) => `- ${i.identifier} [p${i.priority}] ${i.title}\n  ${(i.description || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
        const prompt = `/factory-plan\n\nGroup these ready tickets into work packages (max ${cfg.planner.max_package} per package, ordered for a PR stack). Tickets:\n${listing}`;
        try {
          const plan = DRY ? { packages: ready.map((i) => ({ tickets: [i.identifier], reason: 'dry run' })) } : claudeJson({ cwd: cfg.repo.path, prompt, model: cfg.planner.model, schema });
          const byKey = Object.fromEntries(ready.map((i) => [i.identifier, i]));
          const seen = new Set();
          packages = [];
          for (const p of plan.packages || []) {
            const members = p.tickets.map((k) => byKey[k]).filter((i) => i && !seen.has(i.identifier)).slice(0, cfg.planner.max_package);
            if (!members.length) continue;
            members.forEach((i) => seen.add(i.identifier));
            packages.push(members);
            vlog(`package ${members.map((m) => m.identifier).join('+')}: ${p.reason}`);
          }
          for (const i of ready) if (!seen.has(i.identifier)) packages.push([i]);
        } catch (e) {
          log(`planner failed, dispatching singles: ${String(e.message).slice(0, 300)}`);
        }
      }
      // One package is one stack on one base: members on a different base go out as singles.
      packages = packages.flatMap((pkg) => {
        const base = baseOf.get(pkg[0].identifier).base;
        const same = pkg.filter((i) => baseOf.get(i.identifier).base === base);
        return [same, ...pkg.filter((i) => !same.includes(i)).map((i) => [i])];
      });
      for (const pkg of packages) {
        if (free <= 0) break;
        const lead = pkg[0];
        const keys = pkg.map((i) => i.identifier);
        const { base, parent } = baseOf.get(lead.identifier);
        const { wt, branch } = ensureWorktree(lead.identifier, base || cfg.repo.base);
        const stackNote = base
          ? `\n\nStack on \`${base}\` (open PR #${parent.number}, not merged yet; it can still change in review). Your branch starts from it; make your bottom PR's base \`${base}\`, not main. Leave that PR's files to its own package. When it merges, rebase onto main and retarget your bottom PR to main.`
          : '';
        const prompt = `/factory-auto ${keys.join(' ')}\n\nFactory mode. Principles: ${cfg.principles_file}. Work package in stack order: ${keys.join(' -> ')}. Keep the factory state comment on each ticket current (prs, parked_at). Never use AskUserQuestion; escalate per the principles file and end the session. When the PR(s) are open, run \`${cfg.babysit.command} <top PR>${babysitArgs}\` once and end the session; the factory tick re-invokes babysit when signals change.${stackNote}`;
        let out = '';
        try {
          out = act(`dispatch worker for ${keys.join('+')} in ${wt}`, () => claudeBg({ cwd: wt, prompt, model: cfg.workers.model })) || '';
        } catch (e) {
          log(`dispatch failed for ${keys.join('+')}: ${String(e.message).slice(0, 300)}`);
          continue;
        }
        const sessionId = (out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [null])[0]
          || sessionFor(listSessions() || [], wt)?.sessionId || null;
        const state = {
          package: keys, lead: lead.identifier, worktree: wt, branch, session: sessionId, session_hint: out.split('\n')[1] || out.slice(0, 120),
          started_at: new Date().toISOString(), lease_until: new Date(Date.now() + cfg.workers.lease_minutes * 60000).toISOString(),
          restarts: 0, prs: [], parked_at: null, notified: null, target: target.name, stacked_on: base || null,
        };
        for (const issue of pkg) {
          await updateIssue(issue, { stateId: L.stateByRole.in_progress.id, assigneeId: L.viewer.id }, 'claimed by factory');
          await writeState(issue, { ...state, lead: lead.identifier });
        }
        summary.dispatched.push(keys.join('+'));
        free -= 1;
      }
    }
  }

  if (!DRY) writeCache(cfg, 'signals.json', signalCache);
  const status = {
    updated_at: new Date().toISOString(), took_s: Math.round((Date.now() - started) / 1000), busy: summary.busy,
    targets: summary.targets, dispatched: summary.dispatched, woke: summary.woke, resumed: summary.resumed, parked: summary.parked, triaged: summary.triaged, cleaned: summary.done,
  };
  writeCache(cfg, 'last-tick.json', status);
  fs.writeFileSync(cachePath('status.md'), [
    `# Factory status`, ``, `Updated ${status.updated_at} · tick took ${status.took_s}s · busy workers ${summary.busy}`, ``,
    `| target | backlog | ready | in progress | in review |`, `|---|---|---|---|---|`,
    ...Object.entries(summary.targets).map(([n, t]) => `| ${n} | ${t.backlog} | ${t.ready} | ${t.in_progress} | ${t.in_review} |`), ``,
    `- dispatched: ${summary.dispatched.join(', ') || '-'}`, `- babysit woke: ${summary.woke.join(', ') || '-'}`, `- resumed: ${summary.resumed.join(', ') || '-'}`,
    `- parked (needs ${cfg.owner.name}): ${summary.parked.join(', ') || '-'}`, `- triaged: ${summary.triaged.join(', ') || '-'}`, `- cleaned up: ${summary.done.join(', ') || '-'}`,
  ].join('\n') + '\n');
  log(`tick done in ${status.took_s}s: dispatched=${summary.dispatched.length} woke=${summary.woke.length} resumed=${summary.resumed.length} parked=${summary.parked.length} triaged=${summary.triaged.length}`);
}

main().catch((e) => {
  log('tick failed:', e.stack || e.message);
  process.exit(1);
});
