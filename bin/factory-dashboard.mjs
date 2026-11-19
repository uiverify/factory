#!/usr/bin/env node
// factory-dashboard: work streams (targets) across every repo in factory.json, and what is happening to each issue.
// No deps. http://localhost:7788   node bin/factory-dashboard.mjs [--port=7788]

import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  STATE_MARK, QUESTION_MARK, TRIAGE_MARK, LABELS, loadConfig, fetchRepoIssues, inTarget, isBatchParent, findMarked, parseMarked,
  hasLabel, hasFactoryLabel, blockedByOpen, listSessions, sessionFor, sessionBusy, inWorktreesOf, readCache, tailFile, priorityRank,
  leadOfBranch, prRef, parseListedPr, FAILED_CHECK, PASSED_CHECK, humanCommentsAfter,
} from '../lib/common.mjs';
import { usageReport } from '../lib/usage.mjs';
import { liveAgent, refreshHistory, typicalByPhase, historyAge, PHASES } from '../lib/live.mjs';

const run = promisify(execFile);
let cfg = loadConfig();
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').slice(7)) || 7788;
let cache = { at: 0, data: null, error: null, refreshing: false };

function row(repo, i) {
  return { key: i.key, number: i.number, repo: repo.name, title: i.title, url: i.url, open: i.state === 'OPEN', priority: priorityRank(i), created_at: i.createdAt, closed_at: i.closedAt || null };
}

// ---------- GitHub: every factory PR of a repo comes from two searches, not one gh call per PR ----------
const ACTOR = '... on User { login } ... on Team { name } ... on Bot { login }';
const PR_FIELDS = `number title body url state repository { nameWithOwner } isDraft createdAt mergedAt headRefName baseRefName reviewDecision mergeStateStatus
  reviewRequests(first: 10) { nodes { requestedReviewer { ${ACTOR} } } }
  reviews(last: 30) { nodes { author { login } state submittedAt } }
  closingIssuesReferences(first: 10) { nodes { number } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { ... on CheckRun { name conclusion status } ... on StatusContext { context state } } } } } } }`;

// First 100 results, no pagination; add it when a repo has 100+ open or 14-day-merged factory PRs.
async function searchPrs(repo, q) {
  const query = `query($q: String!) { search(query: $q, type: ISSUE, first: 100) { nodes { ... on PullRequest { ${PR_FIELDS} } } } }`;
  const { stdout } = await run('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `q=${q}`], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  // GitHub search tokenizes head: loosely, so the prefix is checked again here.
  return JSON.parse(stdout).data.search.nodes.filter((p) => p.headRefName?.startsWith(repo.branch_prefix));
}
// A package's state can list a PR that the searches miss, opened from a branch outside the factory prefix (a hold PR):
// one query per repo fetches those by number.
async function listedPrs(refs) {
  const byRepo = new Map();
  for (const r of refs) byRepo.set(r.repo, [...(byRepo.get(r.repo) || []), r.number]);
  const found = await Promise.all([...byRepo].map(async ([github, numbers]) => {
    const [owner, name] = github.split('/');
    const fields = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { ${PR_FIELDS} }`).join('\n');
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
    try {
      const { stdout } = await run('gh', ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
      return Object.values(JSON.parse(stdout).data.repository || {}).filter(Boolean);
    } catch {
      return [];
    }
  }));
  return found.flat().filter((p) => p.state === 'OPEN');
}
const actorName = (a) => a?.login || a?.name || null;
function prDetails(repo, pr) {
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
  const checks = Object.fromEntries(contexts.filter((c) => c.name || c.context).map((c) => [c.name || c.context, c.conclusion || c.state || c.status]));
  const names = Object.keys(checks);
  const p = {
    number: pr.number, ref: prRef(repo, { number: pr.number, repo: pr.repository?.nameWithOwner }), url: pr.url, title: pr.title, head: pr.headRefName, base: pr.baseRefName, draft: pr.isDraft, created_at: pr.createdAt, repo: repo.name,
    checks: { total: names.length, failing: names.filter((n) => FAILED_CHECK.includes(checks[n])), pending: names.filter((n) => !FAILED_CHECK.includes(checks[n]) && !PASSED_CHECK.includes(checks[n])).length },
    review: pr.reviewDecision || 'none', merge_state: pr.mergeStateStatus,
    reviewers_requested: (pr.reviewRequests?.nodes || []).map((n) => actorName(n.requestedReviewer)).filter(Boolean),
    approved_by: [...new Set((pr.reviews?.nodes || []).filter((r) => r.state === 'APPROVED').map((r) => r.author?.login).filter(Boolean))],
    closes: (pr.closingIssuesReferences?.nodes || []).map((n) => n.number),
    lead: leadOfBranch(repo, pr.headRefName),
  };
  p.bucket = prBucket(p);
  return p;
}
// The owner merges every factory PR: green and mergeable means it waits on them.
function prBucket(p) {
  if (p.checks.failing.length) return 'ci_failing';
  if (p.review === 'CHANGES_REQUESTED' || ['DIRTY', 'BEHIND'].includes(p.merge_state)) return 'changes';
  if (p.checks.pending) return 'checks_running';
  if (!p.draft && ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(p.merge_state)) return 'waiting_you';
  return 'open';
}
function packageBucket(prs) {
  if (prs.some((p) => p.bucket === 'ci_failing')) return 'ci_failing';
  return prs[0].bucket;
}
const byAge = (field) => (a, b) => String(a[field] || '9').localeCompare(String(b[field] || '9'));
const PKG_BUCKETS = ['working', 'ci_failing', 'changes', 'waiting_you', 'checks_running', 'open'];

async function collectRepo(repo, targets, sessions, out, knownWorktrees) {
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const [openRaw, mergedRaw] = await Promise.all([
    searchPrs(repo, `repo:${repo.github} is:pr is:open author:@me head:${repo.branch_prefix}`),
    searchPrs(repo, `repo:${repo.github} is:pr is:merged author:@me head:${repo.branch_prefix} merged:>=${since.slice(0, 10)}`),
  ]);
  const open = fetchRepoIssues(repo);
  const closed = fetchRepoIssues(repo, { closedSince: since });
  const byNumber = new Map([...closed, ...open].map((i) => [i.number, i]));
  // A worker can open its PR in another repo (a CLI-repo fix for an app-repo issue); the issues name those repos.
  const otherRepos = [...new Set(open.flatMap((i) => i.prs).filter((p) => p.state === 'OPEN' && p.repo !== repo.github).map((p) => p.repo))];
  const otherRaw = (await Promise.all(otherRepos.map((g) => searchPrs(repo, `repo:${g} is:pr is:open author:@me head:${repo.branch_prefix}`)))).flat();
  const searched = [...openRaw, ...otherRaw];
  const leadStates = open.map((i) => parseMarked(findMarked(i, STATE_MARK))).filter((st) => st?.lead && Array.isArray(st.prs));
  const listedOf = (st) => new Set((st?.prs || []).map((e) => parseListedPr(repo, e)).filter(Boolean).map((r) => prRef(repo, r)));
  const missing = [...new Set(leadStates.flatMap((st) => [...listedOf(st)]))]
    .filter((ref) => !searched.some((pr) => prRef(repo, { number: pr.number, repo: pr.repository?.nameWithOwner }) === ref))
    .map((ref) => parseListedPr(repo, ref));
  const openPrs = [...searched, ...(missing.length ? await listedPrs(missing) : [])].map((pr) => prDetails(repo, pr));
  for (const i of closed) {
    const st = parseMarked(findMarked(i, STATE_MARK));
    out.history.push({ at: i.closedAt, kind: 'issue', repo: repo.name, number: i.number, title: i.title, url: i.url, by_factory: !!st?.target, dropped: i.stateReason === 'NOT_PLANNED' });
  }
  for (const pr of mergedRaw) out.history.push({ at: pr.mergedAt, kind: 'pr', repo: repo.name, number: pr.number, title: pr.title, url: pr.url, by_factory: true, dropped: false });
  for (const target of targets) {
    const stream = {
      name: target.name, repo: repo.name, github: repo.github, ship: repo.ship, base: repo.base, batch: target.batch || null, labels: target.labels || [], scope_rule: target.scope_rule, paused: !!target.paused,
      max_in_flight: target.max_in_flight, in_flight: 0, max_awaiting_review: target.max_awaiting_review ?? null,
      working: [], ci_failing: [], changes: [], waiting_you: [], checks_running: [], open: [],
      needs_you: [], queued: [], blocked: [], decide: [], human: [], later: [], untriaged: [], shipped: [], done_14d: [],
    };
    const leads = new Map();
    for (const i of [...open, ...closed]) {
      const st = parseMarked(findMarked(i, STATE_MARK));
      if (st?.target === target.name && i.state === 'CLOSED' && i.closedAt >= since) stream.done_14d.push(row(repo, i));
      if (i.state !== 'OPEN' || isBatchParent(i)) continue;
      const mine = st?.target === target.name;
      if (!mine && !inTarget(target, i)) continue;
      const triage = parseMarked(findMarked(i, TRIAGE_MARK));
      const q = findMarked(i, QUESTION_MARK);
      const r = { ...row(repo, i), blockers: blockedByOpen(i), triage: triage ? { verdict: triage.verdict, reason: triage.reason } : null, package: st?.package || null, lead: st?.lead || null };
      if (st?.worktree) knownWorktrees.add(st.worktree);
      if (hasLabel(i, LABELS.needs_info.name)) {
        r.question = q ? q.body.replace(QUESTION_MARK, '').trim().slice(0, 400) : '(see the issue)';
        r.parked_at = st?.parked_at || null;
        stream.needs_you.push(r);
        if (!target.paused) out.needs_you.push({ ...r, stream: target.name });
        continue;
      }
      if (st && !st.cleaned && (hasLabel(i, LABELS.working.name) || hasLabel(i, LABELS.in_review.name))) {
        const lead = st.lead || i.number;
        if (!leads.has(lead)) leads.set(lead, { lead, tickets: [], st: parseMarked(findMarked(byNumber.get(lead) || i, STATE_MARK)) || st, review: false });
        leads.get(lead).tickets.push(r);
        if (hasLabel(i, LABELS.in_review.name)) leads.get(lead).review = true;
        continue;
      }
      if (hasLabel(i, LABELS.ready.name)) { (r.blockers.length ? stream.blocked : stream.queued).push(r); continue; }
      if (hasLabel(i, LABELS.decide.name)) stream.decide.push(r);
      else if (hasLabel(i, LABELS.human.name)) stream.human.push(r);
      else if (hasLabel(i, LABELS.later.name)) stream.later.push(r);
      else if (!hasFactoryLabel(i)) stream.untriaged.push(r);
    }
    for (const pkg of leads.values()) {
      const s = sessionFor(sessions, pkg.st?.worktree);
      const session = s ? { id: s.id, busy: sessionBusy(s), state: s.state || s.status, started: s.startedAt ? new Date(s.startedAt).toISOString() : null } : null;
      const nums = pkg.tickets.map((t) => t.number);
      const listed = listedOf(pkg.st);
      const owns = (p) => p.lead === pkg.lead || p.closes.some((n) => nums.includes(n)) || listed.has(p.ref);
      const prsOpen = openPrs.filter(owns);
      const entry = {
        lead: pkg.lead, tickets: pkg.tickets, session, worktree: pkg.st?.worktree ? path.basename(pkg.st.worktree) : null, worktree_path: pkg.st?.worktree || null,
        started_at: pkg.st?.started_at || null, restarts: pkg.st?.restarts || 0, last_babysit: pkg.st?.last_babysit || null,
        prs_open: prsOpen, prs_merged: mergedRaw.filter((p) => leadOfBranch(repo, p.headRefName) === pkg.lead).map((p) => ({ number: p.number, url: p.url })),
      };
      entry.since = prsOpen.length ? prsOpen.map((p) => p.created_at).sort()[0] : entry.started_at;
      if (!pkg.review) stream.in_flight++;
      if (prsOpen.length) stream[packageBucket(prsOpen)].push(entry);
      else stream.working.push(entry);
    }
    for (const k of PKG_BUCKETS) stream[k].sort(byAge('since'));
    for (const k of ['blocked', 'decide', 'human', 'later', 'untriaged']) stream[k].sort(byAge('created_at'));
    stream.queued.sort((a, b) => a.priority - b.priority || byAge('created_at')(a, b));
    stream.needs_you.sort(byAge('parked_at'));
    stream.done_14d.sort(byAge('closed_at')).reverse();
    stream.awaiting_review = PKG_BUCKETS.reduce((n, k) => n + stream[k].reduce((m, e) => m + e.prs_open.length, 0), 0);
    out.streams.push(stream);
  }
  await collectModelRuns(repo, byNumber, out);
  for (const pr of mergedRaw.sort(byAge('mergedAt')).reverse()) {
    const lead = leadOfBranch(repo, pr.headRefName);
    const st = parseMarked(findMarked(byNumber.get(lead) || { comments: [] }, STATE_MARK));
    const m = { number: pr.number, url: pr.url, title: pr.title, merged_at: pr.mergedAt, repo: repo.name, stream: st?.target || null, ticket: { key: `#${lead}`, url: byNumber.get(lead)?.url || null } };
    out.shipped.push(m);
    out.streams.find((s) => s.name === m.stream)?.shipped.push(m);
  }
  for (const s of out.streams.filter((x) => x.repo === repo.name)) {
    for (const k of PKG_BUCKETS) {
      for (const e of s[k]) {
        const tickets = e.tickets.map((t) => ({ key: t.key, url: t.url, title: t.title }));
        const activity = e.session ? (e.session.busy ? 'working' : 'idle') : 'none';
        out.agents.push({ lead: e.lead, stream: s.name, repo: s.repo, paused: s.paused, worktree_path: e.worktree_path, tickets, activity, session: e.session, prs: e.prs_open.map((p) => ({ number: p.number, url: p.url, bucket: p.bucket })), started_at: e.started_at, last_babysit: e.last_babysit, restarts: e.restarts });
        for (const p of e.prs_open) out.prs.push({ ...p, stream: s.name, ticket: tickets.find((t) => p.closes.includes(Number(t.key.split('#')[1]))) || tickets[0], agent: activity });
      }
    }
  }
}

// One row per finished package (every issue closed in the last 14 days), so Sonnet and Opus workers can be compared:
// the worker's own review numbers, the owner's comments on the issues after the claim, and later commits on main that
// name one of its issues (a follow-up fix or a revert; the shipping commit itself is excluded by time).
async function collectModelRuns(repo, byNumber, out) {
  for (const lead of byNumber.values()) {
    const st = parseMarked(findMarked(lead, STATE_MARK));
    if (!st || st.lead !== lead.number) continue;
    const members = (st.package || [lead.number]).map((n) => byNumber.get(n)).filter(Boolean);
    if (!members.length || members.some((m) => m.state !== 'CLOSED' || m.stateReason === 'NOT_PLANNED')) continue;
    const shippedAt = members.map((m) => m.closedAt).sort().pop();
    let followups = 0;
    try {
      const since = new Date(new Date(shippedAt).getTime() + 10 * 60000).toISOString();
      const pattern = members.map((m) => `#${m.number}([^0-9]|$)`).join('|');
      const { stdout } = await run('git', ['-C', repo.path, 'log', `${repo.remote}/${repo.base}`, `--since=${since}`, '-E', `--grep=${pattern}`, '--format=%h'], { timeout: 30000 });
      followups = stdout.trim() ? stdout.trim().split('\n').length : 0;
    } catch {}
    out.model_runs.push({
      repo: repo.name, lead: lead.key, url: lead.url, title: lead.title, issues: members.length, model: st.model || 'unrecorded',
      rounds: st.review?.rounds ?? null, findings: st.review?.findings ?? null, opus_consults: st.review?.opus_consults ?? null,
      your_comments: members.reduce((n, m) => n + humanCommentsAfter(m, st.started_at).length, 0),
      restarts: st.restarts || 0, followups, started_at: st.started_at, shipped_at: shippedAt,
      hours: Math.round((new Date(shippedAt) - new Date(st.started_at)) / 36e5 * 10) / 10,
    });
    if (repo.ship === 'push') {
      const m = { number: lead.number, url: lead.url, title: lead.title, merged_at: shippedAt, repo: repo.name, stream: st.target || null, ticket: { key: `${members.length} issue${members.length > 1 ? 's' : ''}`, url: lead.url } };
      out.shipped.push(m);
      out.streams.find((x) => x.name === m.stream)?.shipped.push(m);
    }
  }
}
function summarizeModels(rows) {
  const avg = (xs) => { const v = xs.filter((x) => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
  const by = {};
  for (const r of rows) (by[r.model] = by[r.model] || []).push(r);
  return Object.entries(by).map(([model, rs]) => ({
    model, packages: rs.length, rounds: avg(rs.map((r) => r.rounds)), findings: avg(rs.map((r) => r.findings)),
    your_comments: avg(rs.map((r) => r.your_comments)), followups: avg(rs.map((r) => r.followups)), restarts: avg(rs.map((r) => r.restarts)), hours: avg(rs.map((r) => r.hours)),
  }));
}

async function collect() {
  cfg = loadConfig();
  const sessionsRaw = listSessions();
  const sessions = sessionsRaw || [];
  const out = {
    updated_at: new Date().toISOString(), streams: [], needs_you: [], shipped: [], sessions: [], orphan_sessions: [], prs: [], agents: [], model_runs: [], history: [],
    log: tailFile(path.join(cfg.tick.state_dir, 'tick.log'), 30), last_tick: readCache(cfg, 'last-tick.json', null),
    warning: sessionsRaw === null ? 'claude CLI not reachable from the dashboard process; session states are unknown' : null,
  };
  const knownWorktrees = new Set();
  for (const repo of Object.values(cfg.repos)) {
    const targets = cfg.targets.filter((t) => t.repo === repo.name);
    if (targets.length) await collectRepo(repo, targets, sessions, out, knownWorktrees);
  }
  out.shipped.sort(byAge('merged_at')).reverse();
  out.model_runs.sort(byAge('shipped_at')).reverse();
  out.history.sort(byAge('at')).reverse();
  out.models = summarizeModels(out.model_runs);
  out.needs_you.sort(byAge('parked_at'));
  out.sessions = sessions.filter((s) => inWorktreesOf(cfg, s.cwd)).map((s) => ({ id: s.id, name: s.name, busy: sessionBusy(s), state: s.state || s.status, worktree: path.basename(s.cwd), started: s.startedAt ? new Date(s.startedAt).toISOString() : null, known: knownWorktrees.has(s.cwd) }));
  out.orphan_sessions = out.sessions.filter((s) => !s.known);
  out.metrics = {
    streams_active: out.streams.filter((s) => !s.paused).length, streams_paused: out.streams.filter((s) => s.paused).length,
    slots: cfg.workers.max_concurrent, workers_busy: out.sessions.filter((s) => s.busy).length,
    pr_open: out.prs.length, ci_failing: out.prs.filter((p) => p.bucket === 'ci_failing').length,
    needs_you: out.needs_you.length + out.prs.filter((p) => p.bucket === 'waiting_you').length, merged_14d: out.shipped.length,
  };
  return out;
}
async function refresh() {
  if (cache.refreshing) return;
  cache.refreshing = true;
  const t0 = Date.now();
  try { cache = { ...cache, at: Date.now(), data: { ...(await collect()), collect_s: Math.round((Date.now() - t0) / 100) / 10 }, error: null }; }
  catch (e) { cache = { ...cache, error: String(e.message || e) }; }
  finally { cache.refreshing = false; }
}

// The page: "Now" (what needs to happen next, per PR), "History" (issues closed and PRs merged over time) and
// "Targets" (distribution per target). The client code
// avoids backticks and ${ so it can live in this String.raw template.
const HTML = String.raw`<!doctype html><html><head><meta charset="utf-8"><title>Factory</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0e1014;--fg:#e8e8ea;--mute:#8b909c;--faint:#5d626d;--line:#22262e;--amber:#e0a43a;--red:#ef6b63;--green:#4cc274;--blue:#7aa7ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",Helvetica,sans-serif}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1200px;margin:0 auto;padding:18px 24px 64px}
header{display:flex;align-items:baseline;gap:22px;flex-wrap:wrap;margin-bottom:26px;padding-bottom:14px;border-bottom:1px solid var(--line)}
header h1{font-size:18px;margin:0}
nav a{color:var(--mute);margin-right:16px;padding-bottom:3px}nav a.on{color:var(--fg);border-bottom:2px solid var(--fg)}nav a:hover{text-decoration:none;color:var(--fg)}
.meta{color:var(--mute);font-size:13px;margin-left:auto}.meta b{color:var(--fg);font-weight:500}
.warn{color:var(--red);font-size:13px;margin:-14px 0 18px}
section{margin:0 0 30px}
section>h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:0 0 4px;font-weight:600}
section>h2 .n{margin-left:6px;color:var(--fg)}
section.amber>h2{color:var(--amber)}section.red>h2{color:var(--red)}section.green>h2{color:var(--green)}
.row{display:grid;grid-template-columns:minmax(0,1fr) 170px 100px 270px 96px;gap:18px;padding:11px 0;border-top:1px solid var(--line);align-items:baseline}
.row:hover{background:#13161c}
.t{font-weight:500;color:var(--fg)}.t .num{color:var(--blue);margin-right:6px}.t:hover{text-decoration:none;color:var(--blue)}
.why{color:var(--mute);font-size:13px;margin-top:3px;line-height:1.4}
.c{color:var(--mute);font-size:13px}.age{color:var(--mute);font-size:13px;text-align:right;white-space:nowrap}
.next{font-size:14px}
.tag{font-size:11px;font-weight:600;letter-spacing:.03em;padding:1px 6px;border-radius:4px;margin-right:8px;color:var(--amber);border:1px solid var(--amber);vertical-align:1px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--faint);margin-right:7px;vertical-align:1px}.dot.working{background:var(--green)}.dot.none{background:var(--red)}
.empty{color:var(--mute);padding:11px 0;border-top:1px solid var(--line)}
table{width:100%;border-collapse:collapse}
th{font-size:12px;font-weight:600;color:var(--mute);text-align:left;padding:6px 14px 6px 0;letter-spacing:.03em}
td{padding:10px 14px 10px 0;border-top:1px solid var(--line);vertical-align:baseline}
td.n{text-align:right;font-variant-numeric:tabular-nums;color:var(--fg)}td.n.zero{color:var(--faint)}
th.n{text-align:right}
td.n.amber{color:var(--amber)}td.n.red{color:var(--red)}td.n.green{color:var(--green)}
details{border-top:1px solid var(--line);padding:10px 0}details>summary{cursor:pointer;color:var(--fg)}details>summary .c{margin-left:8px}
.sub{margin:10px 0 0 16px}.sub h3{font-size:12px;color:var(--mute);margin:14px 0 4px;text-transform:uppercase;letter-spacing:.05em}
.li{padding:5px 0;font-size:14px}.li .c{margin-left:8px}
.scope{color:var(--mute);font-size:13px;max-width:900px}
pre{white-space:pre-wrap;font-size:12px;color:var(--mute);margin:8px 0 0}
.paused{color:var(--faint)}.warnc,.warnc b{color:var(--red)!important}
.filters{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 14px}.seg{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.seg button{background:none;border:0;color:var(--mute);font:inherit;font-size:13px;padding:4px 11px;cursor:pointer}.seg button+button{border-left:1px solid var(--line)}
.seg button.on{background:#1c2029;color:var(--fg)}.seg button:hover{color:var(--fg)}
.stat{font-size:14px;color:var(--mute);margin:0 0 10px}.stat b{color:var(--fg);font-size:20px;font-weight:600;margin-right:4px;font-variant-numeric:tabular-nums}.stat span{margin-right:22px}
.legend{font-size:13px;color:var(--mute);margin:0 0 6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 6px 0 0;vertical-align:-1px}.legend span{margin-right:18px}
.chart{position:relative}.chart svg{display:block;width:100%;height:auto}.chart text{fill:var(--mute);font-size:11px;font-variant-numeric:tabular-nums}
.tip{position:absolute;pointer-events:none;background:#181b22;border:1px solid #2d323c;border-radius:6px;padding:8px 10px;font-size:13px;min-width:180px;max-width:340px;display:none;z-index:2;box-shadow:0 4px 18px rgba(0,0,0,.4)}
.tip .h{color:var(--mute);margin-bottom:4px}.tip .v{font-variant-numeric:tabular-nums}.tip .it{color:var(--mute);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.day{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:18px 0 2px;font-weight:600}
.ev{display:grid;grid-template-columns:78px 112px minmax(0,1fr) 110px 70px;gap:14px;padding:7px 0;border-top:1px solid var(--line);align-items:baseline;font-size:14px}
.live{border-top:1px solid var(--line);padding:14px 0 16px}
.live .hd{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}.live .hd .t{font-size:16px}.live .hd .c{margin-left:auto}
.steps{display:flex;gap:4px;margin:12px 0 10px;flex-wrap:wrap}
.step{flex:1;min-width:92px;border-radius:6px;padding:6px 9px;background:#151820;border:1px solid var(--line);font-size:12px;color:var(--faint)}
.step b{display:block;font-size:13px;font-weight:600;color:var(--faint)}
.step.done{color:var(--mute)}.step.done b{color:var(--mute)}
.step.cur{border-color:var(--green);background:#122019;color:var(--fg)}.step.cur b{color:var(--green)}
.step.cur.over{border-color:var(--amber);background:#211b10}.step.cur.over b{color:var(--amber)}
.kv{display:flex;gap:22px;flex-wrap:wrap;font-size:13px;color:var(--mute);margin:4px 0}.kv b{color:var(--fg);font-weight:500;font-variant-numeric:tabular-nums}
.bar{display:inline-block;width:110px;height:6px;border-radius:3px;background:#22262e;vertical-align:1px;margin-left:6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--blue)}.bar i.hi{background:var(--amber)}
.eta{font-size:14px;margin:8px 0 2px}.eta .c{margin-left:6px}
.now{font-size:13px;margin:8px 0 0;color:var(--mute)}.now b{color:var(--fg);font-weight:500}.now .pulse{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);margin-right:6px;animation:p 1.4s infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:.25}}
.msgs{margin-top:8px}.msg{font-size:13px;padding:6px 10px;border-left:2px solid var(--line);margin:4px 0;white-space:pre-wrap;color:var(--mute)}.msg:first-child{border-left-color:var(--blue);color:var(--fg)}.msg .c{display:block;font-size:11px;margin-bottom:2px}
.ev .age{text-align:left}.ev.dropped{opacity:.55}.kind i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:7px;vertical-align:0}
</style></head><body><div class="wrap">
<header><h1>Factory</h1><nav><a href="#" id="nav-prs">Now</a><a href="#history" id="nav-history">History</a><a href="#projects" id="nav-projects">Targets</a><a href="#usage" id="nav-usage">Usage</a></nav><span class="meta" id="meta">loading…</span></header>
<div id="warn" class="warn"></div>
<div id="page"></div>
<section style="margin-top:40px"><details><summary class="c">Diagnostics · tick log and raw sessions</summary><div id="diag"></div></details></section>
</div>
<script>
var D=null;
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function ago(t){if(!t)return '';var m=(Date.now()-new Date(t).getTime())/60000;if(m<1)return 'now';if(m<60)return Math.round(m)+'m';if(m<2880)return Math.round(m/60)+'h';return Math.round(m/1440)+'d';}
function link(u,t,cls){return u?'<a href="'+esc(u)+'" target="_blank" rel="noopener"'+(cls?' class="'+cls+'"':'')+'>'+t+'</a>':t;}
function cleanTitle(t){return esc(String(t||''));}
function proj(x){return esc(x.stream);}
function next(p){
  var b=p.bucket;
  if(b==='waiting_you')return {text:'Green · merge it or comment',age:'opened '+ago(p.created_at)};
  if(b==='ci_failing')return {text:'Failing: '+esc(p.checks.failing.join(', ')),why:'agent '+(p.agent==='working'?'is fixing it':p.agent==='idle'?'idle, wakes next tick':'has no session'),age:'opened '+ago(p.created_at)};
  if(b==='changes')return {text:p.review==='CHANGES_REQUESTED'?'Changes requested':'Needs a rebase ('+esc(p.merge_state)+')',why:'agent '+(p.agent==='working'?'is on it':'wakes next tick'),age:'opened '+ago(p.created_at)};
  if(b==='checks_running')return {text:'Checks running ('+p.checks.pending+')',age:'opened '+ago(p.created_at)};
  return {text:p.draft?'Draft':'Open ('+esc(p.merge_state)+')',age:'opened '+ago(p.created_at)};
}
function prRow(p){
  var n=next(p);
  return '<div class="row"><div>'+link(p.url,'<span class="num">'+esc(p.ref)+'</span>'+cleanTitle(p.title),'t')+(n.why?'<div class="why">'+esc(n.why)+'</div>':'')+'</div>'
    +'<div class="c">'+proj(p)+'</div><div class="c">'+(p.ticket?link(p.ticket.url,esc(p.ticket.key)):'')+'</div>'
    +'<div class="next">'+n.text+'</div><div class="age">'+esc(n.age||'')+'</div></div>';
}
function questionRow(t){
  return '<div class="row"><div><span class="tag">QUESTION</span>'+link(t.url,cleanTitle(t.title),'t')+'<div class="why">'+esc(t.question)+'</div></div>'
    +'<div class="c">'+esc(t.stream)+'</div><div class="c">'+link(t.url,esc(t.key))+'</div>'
    +'<div class="next">Reply with a comment on the issue</div><div class="age">waiting '+esc(ago(t.parked_at))+'</div></div>';
}
function decideRow(t){
  return '<div class="row"><div><span class="tag">DECIDE</span>'+link(t.url,cleanTitle(t.title),'t')+'<div class="why">'+esc(t.triage&&t.triage.reason)+'</div></div>'
    +'<div class="c">'+esc(t.stream)+'</div><div class="c">'+link(t.url,esc(t.key))+'</div>'
    +'<div class="next">Comment your pick, then label it factory: ready</div><div class="age">created '+esc(ago(t.created_at))+'</div></div>';
}
function section(title,tone,items,render,emptyNote){
  if(!items.length&&!emptyNote)return '';
  return '<section class="'+tone+'"><h2>'+title+'<span class="n">'+items.length+'</span></h2>'+(items.length?items.map(render).join(''):'<div class="empty">'+emptyNote+'</div>')+'</section>';
}
function byAge(f){return function(a,b){return String(a[f]||'9').localeCompare(String(b[f]||'9'));};}
function prsPage(){
  var P=D.prs||[];
  function of(b){return P.filter(function(p){return p.bucket===b;});}
  var h='';
  var decide=D.streams.filter(function(s){return !s.paused;}).flatMap(function(s){return s.decide.map(function(t){return Object.assign({},t,{stream:s.name});});});
  var needs=of('waiting_you').map(prRow).concat((D.needs_you||[]).map(questionRow)).concat(decide.map(decideRow));
  h+='<section class="amber"><h2>Needs your call<span class="n">'+needs.length+'</span></h2>'+(needs.join('')||'<div class="empty">Nothing needs your call.</div>')+'</section>';
  h+='<div id="live">'+liveHtml()+'</div>';
  h+=section('CI failing','red',of('ci_failing'),prRow);
  h+=section('Changes requested or needs a rebase','',of('changes'),prRow);
  h+=section('Checks running','',of('checks_running').concat(of('open')),prRow);
  h+=agentsTable();
  return h;
}
var L=null;
var STEP_NAME={triage:'Triage',design:'Design',build:'Build',review:'Review',e2e:'E2E check',checks:'Final checks',ship:'Ship'};
function since(t){var a=ago(t);return a==='now'?'just now':a+' ago';}
function dur(m){m=Math.round(m);if(m<60)return m+'m';var h=Math.floor(m/60),r=m%60;return h+'h'+(r?' '+r+'m':'');}
function tok(n){return n>=1e9?(Math.round(n/1e8)/10)+'B':n>=1e6?Math.round(n/1e6)+'M':Math.round(n/1e3)+'k';}
function clock(min){var d=new Date(Date.now()+min*60000);return pad2(d.getHours())+':'+pad2(d.getMinutes());}
function liveCard(a){
  if(a.error)return '<div class="live c">#'+esc(a.lead)+': '+esc(a.error)+'</div>';
  var typ=(L.typical||{})[a.repo]||{};
  var ph=L.phases,cur=ph.indexOf(a.phase),t=a.tickets[0]||{};
  var title=(D.agents||[]).find(function(x){return x.lead===a.lead&&x.repo===a.repo;});
  var tk=(title&&title.tickets[0])||{};
  var over=a.estimate&&a.estimate.over_typical_min>0;
  var steps=ph.map(function(p,i){
    var at=a.reached[p];var nextAt=null;for(var j=i+1;j<ph.length;j++)if(a.reached[ph[j]]){nextAt=a.reached[ph[j]];break;}
    var spent=at?((nextAt?new Date(nextAt):new Date())-new Date(at))/60000:null;
    var cls=i<cur?(at?'done':''):i===cur?'cur'+(over?' over':''):'';
    var sub=i===cur?dur(a.minutes_in_phase)+(typ[p]?' · typical '+dur(typ[p].median_min):''):at?dur(spent):(typ[p]&&i>cur?'~'+dur(typ[p].median_min):'');
    if(p==='design'&&a.design_rounds)sub+=' · '+a.design_rounds+' rounds';
    if(p==='review'&&a.review_rounds)sub+=' · round '+a.review_rounds;
    return '<div class="step '+cls+'"><b>'+STEP_NAME[p]+'</b>'+(sub||'&nbsp;')+'</div>';
  }).join('');
  var pct=Math.min(100,Math.round(a.context_now/a.context_limit*100));
  var e=a.estimate,eta='';
  if(e){eta='<div class="eta">'+(e.minutes_left>0?'Likely done in about <b>'+dur(e.minutes_left)+'</b> (around '+clock(e.minutes_left)+')':'Past the typical length for this step')
    +(over?' · already '+dur(e.over_typical_min)+' longer than a typical '+STEP_NAME[a.phase].toLowerCase():'')
    +'<span class="c">from '+e.basis+' finished '+esc(a.repo)+' pieces, typical piece '+dur(e.typical_piece_min)+'; big pieces run longer</span></div>';}
  var bg=(a.background||[]).map(function(b){return '<div class="now"><span class="pulse"></span>Background agent <b>'+esc(b.description)+'</b> · running '+ago(b.started)+' · last write '+ago(b.last_write)+(b.context_now?' · context '+tok(b.context_now):'')+'</div>';}).join('');
  var lt=a.last_tool?'<div class="now">'+(a.last_tool.done?'Last step':'<span class="pulse"></span>Running')+': <b>'+esc(a.last_tool.name)+'</b> '+esc(a.last_tool.label)+' · '+since(a.last_tool.at)+'</div>':'';
  var msgs=(a.messages||[]).map(function(m){return '<div class="msg"><span class="c">'+since(m.at)+'</span>'+esc(m.text)+'</div>';}).join('');
  return '<div class="live"><div class="hd"><span><span class="dot '+esc(a.activity||'')+'"></span></span>'+link(tk.url,'<span class="num">'+esc(tk.key||('#'+a.lead))+'</span>'+cleanTitle(tk.title),'t')+'<span class="c">'+esc(a.stream)+'</span></div>'
    +'<div class="steps">'+steps+'</div>'
    +'<div class="kv"><span>Piece <b>'+dur(a.minutes_total)+'</b></span><span>Session <b>'+a.sessions+'</b>'+(a.handoffs?' ('+plural(a.handoffs,'handoff')+')':'')+'</span>'
    +'<span>Context <b>'+tok(a.context_now)+'</b> of '+tok(a.context_limit)+'<span class="bar"><i class="'+(pct>80?'hi':'')+'" style="width:'+pct+'%"></i></span></span>'
    +'<span>Tokens read <b>'+tok(a.read_tokens)+'</b></span><span>Written <b>'+tok(a.out_tokens)+'</b></span><span>Last activity <b>'+ago(a.last_activity)+'</b></span></div>'
    +eta+bg+lt+(msgs?'<details class="msgs" open data-k="m'+a.lead+'"><summary class="c">Latest messages</summary>'+msgs+'</details>':'')+'</div>';
}
function liveHtml(){
  if(!L)return '<section><h2>Workers</h2><div class="empty">Loading live worker state…</div></section>';
  var recent=L.agents.filter(function(a){return a.error||(a.last_activity&&Date.now()-new Date(a.last_activity)<3*3600000);})
    .sort(function(a,b){return String(b.last_activity).localeCompare(String(a.last_activity));});
  return '<section class="green"><h2>Workers<span class="n">'+recent.length+' active in the last 3h</span><span class="c" style="margin-left:10px;text-transform:none;letter-spacing:0">live, every 5s</span></h2>'+(recent.map(liveCard).join('')||'<div class="empty">No worker has done anything in the last 3 hours.</div>')+'</section>';
}
var closedMsgs={};
function renderLive(){
  var el=document.getElementById('live');if(!el)return;
  el.querySelectorAll('details[data-k]').forEach(function(d){closedMsgs[d.getAttribute('data-k')]=!d.open;});
  el.innerHTML=liveHtml();
  el.querySelectorAll('details[data-k]').forEach(function(d){if(closedMsgs[d.getAttribute('data-k')])d.open=false;});
}
async function loadLive(){if(location.hash&&location.hash!=='#')return;try{L=await (await fetch('/api/live')).json();}catch(e){return;}renderLive();}
function agentsTable(){
  var A=(D.agents||[]).slice().sort(function(a,b){return (a.activity==='working'?0:1)-(b.activity==='working'?0:1)||String(a.stream).localeCompare(String(b.stream));});
  var orphans=D.orphan_sessions||[];
  var label={working:'Working',idle:'Idle',none:'No session'};
  var rows=A.map(function(a){
    var prs=a.prs.length?a.prs.map(function(p){return link(p.url,'#'+p.number);}).join(' '):'<span class="c">no PR</span>';
    return '<tr><td><span class="dot '+a.activity+'"></span>'+esc(label[a.activity])+'</td><td>'+esc(a.stream)+'</td>'
      +'<td>'+a.tickets.map(function(t){return link(t.url,esc(t.key))+' <span class="c">'+cleanTitle(t.title)+'</span>';}).join('<br>')+'</td>'
      +'<td>'+prs+'</td><td class="c">'+(a.last_babysit?'babysat '+ago(a.last_babysit)+' ago':'started '+ago(a.started_at)+' ago')+(a.restarts?' · '+a.restarts+' restarts':'')+'</td></tr>';
  }).concat(orphans.map(function(s){return '<tr><td><span class="dot '+(s.busy?'working':'')+'"></span>'+(s.busy?'Working':'Idle')+'</td><td class="c">unknown</td><td class="c">'+esc(s.worktree)+' · no issue claims it</td><td></td><td class="c">started '+ago(s.started)+' ago</td></tr>';}));
  var busy=A.filter(function(a){return a.activity==='working';}).length;
  return '<section><h2>Agents<span class="n">'+busy+' working · '+A.length+' total</span></h2>'+(rows.length?'<table><tr><th>Activity</th><th>Target</th><th>Issues</th><th>PRs</th><th>Last</th></tr>'+rows.join('')+'</table>':'<div class="empty">No agents.</div>')+'</section>';
}
function projectsPage(){
  var P=D.prs||[],A=D.agents||[];
  function cnt(s,b){return P.filter(function(p){return p.stream===s.name&&p.bucket===b;}).length;}
  function td(n,tone){return '<td class="n '+(n?tone||'':'zero')+'">'+n+'</td>';}
  var head='<tr><th>Target</th><th class="n">Untriaged</th><th class="n">Queued</th><th class="n">Building</th><th class="n">Needs you</th><th class="n">CI failing</th><th class="n">Other open PRs</th><th class="n">Agents working</th><th class="n">Closed 14d</th></tr>';
  var rows=D.streams.map(function(s){
    var sel=(s.batch?'sub-issues of #'+s.batch:'')+(s.batch&&s.labels.length?' · ':'')+(s.labels.length?'labels '+s.labels.join(', '):'')||'every open issue';
    return '<tr class="'+(s.paused?'paused':'')+'"><td>'+esc(s.name)+'<div class="c">'+esc(s.github)+' · '+esc(s.ship==='pr'?'PRs':'push to '+s.base)+' · '+esc(sel)+(s.paused?' · paused':'')+'</div></td>'
      +td(s.untriaged.length)+td(s.queued.length)+td(s.working.length)+td(cnt(s,'waiting_you')+s.needs_you.length+s.decide.length,'amber')+td(cnt(s,'ci_failing'),'red')
      +td(cnt(s,'changes')+cnt(s,'checks_running')+cnt(s,'open'))+td(A.filter(function(a){return a.stream===s.name&&a.activity==='working';}).length,'green')+td(s.done_14d.length)+'</tr>';
  }).join('');
  var h='<section><h2>Targets</h2><table>'+head+rows+'</table></section>';
  h+='<section><h2>Details</h2>'+D.streams.map(streamDetails).join('')+'</section>';
  h+=modelsSection();
  h+='<section><h2>Shipped in 14 days<span class="n">'+D.shipped.length+' merged PRs or pushes</span></h2>'+D.shipped.map(function(m){
    return '<div class="row" style="grid-template-columns:minmax(0,1fr) 170px 100px 170px 96px"><div>'+link(m.url,'<span class="num">#'+m.number+'</span>'+cleanTitle(m.title),'t')+'</div><div class="c">'+esc(m.stream||'')+'</div><div class="c">'+(m.ticket.url?link(m.ticket.url,esc(m.ticket.key)):esc(m.ticket.key||''))+'</div><div class="c">'+esc(m.repo)+'</div><div class="age">'+ago(m.merged_at)+' ago</div></div>';
  }).join('')+'</section>';
  return h;
}
function modelsSection(){
  var M=D.models||[],R=D.model_runs||[];
  function v(x){return x==null?'<span class="c">-</span>':esc(x);}
  var sum=M.map(function(m){return '<tr><td>'+esc(m.model)+'</td><td class="n">'+m.packages+'</td><td class="n">'+v(m.rounds)+'</td><td class="n">'+v(m.findings)+'</td><td class="n">'+v(m.your_comments)+'</td><td class="n">'+v(m.followups)+'</td><td class="n">'+v(m.restarts)+'</td><td class="n">'+v(m.hours)+'</td></tr>';}).join('');
  var rows=R.map(function(r){return '<tr><td>'+link(r.url,esc(r.lead))+' <span class="c">'+cleanTitle(r.title)+'</span></td><td>'+esc(r.model)+'</td><td class="n">'+v(r.rounds)+'</td><td class="n">'+v(r.findings)+'</td><td class="n">'+v(r.your_comments)+'</td><td class="n">'+v(r.followups)+'</td><td class="n">'+v(r.restarts)+'</td><td class="n">'+v(r.hours)+'</td></tr>';}).join('');
  var head='<th class="n">Review rounds</th><th class="n">Findings fixed</th><th class="n">Your comments</th><th class="n">Later fixes</th><th class="n">Restarts</th><th class="n">Hours</th>';
  return '<section><h2>Worker models · finished in 14 days</h2>'+(M.length?'<table><tr><th>Model</th><th class="n">Packages</th>'+head+'</tr>'+sum+'</table><details><summary class="c">Each package</summary><table><tr><th>Package</th><th>Model</th>'+head+'</tr>'+rows+'</table></details>':'<div class="empty">No finished factory packages yet.</div>')+'</section>';
}
function tlist(title,items,extra){
  if(!items.length)return '';
  return '<h3>'+title+' · '+items.length+'</h3>'+items.map(function(t){return '<div class="li">'+link(t.url,esc(t.key))+' '+cleanTitle(t.title)+(extra?'<span class="c">'+extra(t)+'</span>':'')+'</div>';}).join('');
}
function streamDetails(s){
  return '<details><summary>'+esc(s.name)+'<span class="c">'+(s.paused?'paused · ':'')+s.in_flight+' of '+s.max_in_flight+' slots used'+(s.ship==='pr'?' · '+s.awaiting_review+' of '+(s.max_awaiting_review==null?'∞':s.max_awaiting_review)+' PRs waiting on you':'')+'</span></summary><div class="sub">'
    +'<div class="scope">'+esc(s.scope_rule)+'</div>'
    +tlist('Queued',s.queued)
    +tlist('Blocked',s.blocked,function(t){return ' · by '+t.blockers.map(function(b){return '#'+b;}).join(', ');})
    +tlist('Decide',s.decide,function(t){return t.triage?' · '+esc(t.triage.reason):'';})
    +tlist('Only you can do it',s.human,function(t){return t.triage?' · '+esc(t.triage.reason):'';})
    +tlist('Untriaged',s.untriaged)
    +tlist('Later · out of scope',s.later)
    +tlist('Closed in 14 days',s.done_14d,function(t){return ' · '+ago(t.closed_at)+' ago';})
    +'</div></details>';
}
function diag(){
  var t=D.last_tick;
  return '<pre>'+(t?'last tick '+ago(t.updated_at)+' ago, took '+t.took_s+'s · dispatched '+t.dispatched.length+' · woke '+t.woke.length+' · resumed '+t.resumed.length+' · parked '+t.parked.length+'\n\n':'')
    +esc((D.log||[]).join('\n'))+'\n\nsessions:\n'+esc((D.sessions||[]).map(function(s){return s.worktree+'  '+(s.busy?'working':s.state)+'  claude attach '+s.id;}).join('\n'))+'</pre>';
}
var HC={issue:'#3987e5',pr:'#d95926'};
var HR={'24h':{label:'24 hours',n:24,step:3600000},'7d':{label:'7 days',n:28,step:6*3600000},'14d':{label:'14 days',n:14,step:86400000}};
function hpref(k,d){try{return localStorage.getItem('h-'+k)||d;}catch(e){return d;}}
function hset(k,v){try{localStorage.setItem('h-'+k,v);}catch(e){}render();}
function plural(n,w){return n+' '+w+(n===1?'':'s');}
function pad2(n){return (n<10?'0':'')+n;}
function dayName(d){var t=new Date();t.setHours(0,0,0,0);var x=new Date(d);x.setHours(0,0,0,0);var diff=Math.round((t-x)/86400000);
  if(diff===0)return 'Today';if(diff===1)return 'Yesterday';return x.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'});}
function hBuckets(range,events){
  var r=HR[range],end=new Date();
  if(r.step===3600000)end.setMinutes(60,0,0);else if(r.step===86400000){end.setHours(24,0,0,0);}else{end.setHours(Math.floor(end.getHours()/6)*6+6,0,0,0);}
  var start=end.getTime()-r.n*r.step,B=[];
  for(var i=0;i<r.n;i++)B.push({from:start+i*r.step,to:start+(i+1)*r.step,issue:[],pr:[]});
  events.forEach(function(e){if(e.dropped)return;var t=new Date(e.at).getTime();if(t<start||t>=end.getTime())return;B[Math.floor((t-start)/r.step)][e.kind].push(e);});
  return {B:B,start:start,step:r.step};
}
function barTop(x,y,w,h,r){r=Math.min(r,w/2,h);return 'M'+x+','+(y+h)+'V'+(y+r)+'Q'+x+','+y+' '+(x+r)+','+y+'H'+(x+w-r)+'Q'+(x+w)+','+y+' '+(x+w)+','+(y+r)+'V'+(y+h)+'Z';}
function xLabel(b,step,i,n){var d=new Date(b.from);
  if(step===3600000)return i%3===0?pad2(d.getHours())+':00':'';
  if(step===86400000)return d.toLocaleDateString(undefined,{day:'numeric',month:'short'});
  return d.getHours()===0?d.toLocaleDateString(undefined,{weekday:'short',day:'numeric'}):'';}
function chartSvg(H){
  var W=1150,Ht=230,L=34,R=8,T=10,Bm=26,pw=W-L-R,ph=Ht-T-Bm,n=H.B.length,slot=pw/n,bw=Math.max(4,Math.min(36,slot*0.62));
  var max=Math.max(1,Math.max.apply(null,H.B.map(function(b){return b.issue.length+b.pr.length;})));
  var stepY=max<=5?1:max<=10?2:max<=25?5:max<=50?10:Math.ceil(max/50)*10,top=Math.ceil(max/stepY)*stepY,y=function(v){return T+ph-v/top*ph;};
  var g='';
  for(var v=0;v<=top;v+=stepY)g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="'+(v===0?'#3a3f4a':'#1d2128')+'" stroke-width="1"/><text x="'+(L-8)+'" y="'+(y(v)+4)+'" text-anchor="end">'+v+'</text>';
  var bars='',hits='';
  H.B.forEach(function(b,i){
    var cx=L+slot*i+slot/2,x=cx-bw/2,a=b.issue.length,p=b.pr.length;
    if(a){var ya=y(a),ha=T+ph-ya;bars+=p?'<rect x="'+x+'" y="'+ya+'" width="'+bw+'" height="'+ha+'" fill="'+HC.issue+'"/>':'<path d="'+barTop(x,ya,bw,ha,4)+'" fill="'+HC.issue+'"/>';}
    if(p){var yt=y(a+p),hp=y(a)-yt-(a?2:0);if(hp>0)bars+='<path d="'+barTop(x,yt,bw,hp,4)+'" fill="'+HC.pr+'"/>';}
    var lb=xLabel(b,H.step,i,n);if(lb)bars+='<text x="'+cx+'" y="'+(Ht-8)+'" text-anchor="middle">'+esc(lb)+'</text>';
    hits+='<rect class="hit" data-i="'+i+'" x="'+(L+slot*i)+'" y="'+T+'" width="'+slot+'" height="'+ph+'" fill="transparent"/>';
  });
  return '<svg viewBox="0 0 '+W+' '+Ht+'" role="img" aria-label="Issues closed and PRs merged over time">'+g+bars+hits+'</svg>';
}
function historyPage(){
  var range=hpref('range','24h');if(!HR[range])range='24h';
  var repos=[];(D.history||[]).forEach(function(e){if(repos.indexOf(e.repo)<0)repos.push(e.repo);});
  var repo=hpref('repo','all');if(repo!=='all'&&repos.indexOf(repo)<0)repo='all';
  var ev=(D.history||[]).filter(function(e){return repo==='all'||e.repo===repo;});
  var prRepos=D.streams.filter(function(x){return x.ship==='pr'&&(repo==='all'||x.repo===repo);});
  var H=hBuckets(range,ev);window.HB=H;
  var inRange=ev.filter(function(e){return new Date(e.at).getTime()>=H.start;});
  var done=inRange.filter(function(e){return !e.dropped;});
  var nI=done.filter(function(e){return e.kind==='issue';}).length,nP=done.filter(function(e){return e.kind==='pr';}).length,nF=done.filter(function(e){return e.kind==='issue'&&e.by_factory;}).length;
  function seg(k,opts,cur){return '<div class="seg">'+opts.map(function(o){return '<button data-k="'+k+'" data-v="'+esc(o[0])+'" class="'+(o[0]===cur?'on':'')+'">'+esc(o[1])+'</button>';}).join('')+'</div>';}
  var h='<div class="filters">'+seg('range',[['24h','24 hours'],['7d','7 days'],['14d','14 days']],range)+(repos.length>1?seg('repo',[['all','All repos']].concat(repos.map(function(r){return [r,r];})),repo):'')+'</div>';
  h+='<section><div class="stat"><span><b>'+nI+'</b>issues closed</span><span><b>'+nF+'</b>of them by the factory</span>'+(prRepos.length?'<span><b>'+nP+'</b>PRs merged</span>':'<span>no PRs: '+esc(repo==='all'?'every repo here':repo)+' pushes straight to its base branch</span>')+'<span>in the last '+esc(HR[range].label)+'</span></div>'
    +'<div class="legend"><span><i style="background:'+HC.issue+'"></i>Issues closed</span><span><i style="background:'+HC.pr+'"></i>PRs merged</span></div>'
    +'<div class="chart" id="hchart">'+chartSvg(H)+'<div class="tip" id="htip"></div></div></section>';
  var rows='',last='';
  inRange.forEach(function(e){
    var dn=dayName(e.at);if(dn!==last){rows+='<div class="day">'+esc(dn)+'</div>';last=dn;}
    var t=new Date(e.at),kind=e.dropped?'Not planned':e.kind==='pr'?'PR merged':'Issue closed';
    rows+='<div class="ev'+(e.dropped?' dropped':'')+'"><div class="age" title="'+esc(t.toLocaleString())+'">'+esc(ago(e.at))+' ago</div><div class="c kind"><i style="background:'+(e.dropped?'var(--faint)':HC[e.kind])+'"></i>'+kind+'</div>'
      +'<div>'+link(e.url,'<span class="num">#'+e.number+'</span>'+cleanTitle(e.title),'t')+'</div><div class="c">'+esc(e.repo)+'</div><div class="c">'+(e.by_factory?'factory':'')+'</div></div>';
  });
  h+='<section><h2>Log<span class="n">'+inRange.length+'</span></h2>'+(rows||'<div class="empty">Nothing closed or merged in the last '+esc(HR[range].label)+'.</div>')+'</section>';
  return h;
}
function wireHistory(){
  document.querySelectorAll('.seg button').forEach(function(b){b.onclick=function(){hset(b.getAttribute('data-k'),b.getAttribute('data-v'));};});
  var box=document.getElementById('hchart'),tip=document.getElementById('htip');if(!box)return;
  box.querySelectorAll('.hit').forEach(function(r){
    r.addEventListener('mousemove',function(ev){
      var b=window.HB.B[Number(r.getAttribute('data-i'))],f=new Date(b.from),to=new Date(b.to);
      var when=window.HB.step===86400000?dayName(f):dayName(f)+' '+pad2(f.getHours())+':00–'+pad2(to.getHours())+':00';
      var items=b.issue.concat(b.pr);
      tip.innerHTML='<div class="h">'+esc(when)+'</div><div class="v"><span style="color:'+HC.issue+'">■</span> '+plural(b.issue.length,'issue')+' closed</div><div class="v"><span style="color:'+HC.pr+'">■</span> '+plural(b.pr.length,'PR')+' merged</div>'
        +items.slice(0,6).map(function(e){return '<div class="it">#'+e.number+' '+cleanTitle(e.title)+'</div>';}).join('')+(items.length>6?'<div class="it">and '+(items.length-6)+' more</div>':'');
      tip.style.display='block';
      var bx=box.getBoundingClientRect(),x=ev.clientX-bx.left+14,yy=ev.clientY-bx.top+14;
      if(x+tip.offsetWidth>bx.width)x=ev.clientX-bx.left-tip.offsetWidth-14;
      tip.style.left=x+'px';tip.style.top=yy+'px';
    });
    r.addEventListener('mouseleave',function(){tip.style.display='none';});
  });
}
var U=null,UW='today';
function pc(x){return x==null?'<span class="c">-</span>':(x<0.05&&x>0?'&lt;0.1':(Math.round(x*10)/10))+'%';}
function usagePage(){
  if(!U)return '<div class="empty">Reading the transcripts…</div>';
  var a=U.allowance,W=U.windows[UW],h='';
  if(!a)return '<div class="empty">The live allowance is unavailable: '+esc(U.allowance_error||'unknown')+'</div>';
  var five=U.windows.five_hours,rate=(five.measured!=null?five.measured:five.percent)/5;
  var left=rate>0?(100-a.percent)/rate:null;
  var reset=new Date(a.resets_at);
  h+='<section><div class="stat"><span><b>'+pc(a.percent)+'</b> of the week used</span><span>resets '+esc(reset.toLocaleString([], {weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}))+'</span>'
    +'<span>an even pace would be <b style="font-size:15px">'+pc(Math.round(a.elapsed*1000)/10)+'</b> by now</span>'
    +(left!=null?'<span class="'+(left<(1-a.elapsed)*168?'warnc':'')+'">at the last 5 hours’ rate ('+pc(Math.round(rate*10)/10)+' an hour) the rest lasts <b style="font-size:15px">'+(left<48?Math.round(left)+'h':Math.round(left/24)+'d')+'</b></span>':'')+'</div>'
    +(U.allowance_error?'<div class="warn">'+esc(U.allowance_error)+' (showing the last reading)</div>':'')+'</section>';
  var segs=[['five_hours','Last 5 hours'],['today','Today'],['week','This week']];
  h+='<div class="filters"><div class="seg" id="useg">'+segs.map(function(x){return '<button data-w="'+x[0]+'" class="'+(UW===x[0]?'on':'')+'">'+x[1]+'</button>';}).join('')+'</div></div>';
  var P=W.parts;
  h+='<section><div class="stat"><span><b>'+pc(W.percent)+'</b> spent'+(W.measured!=null&&UW!=='week'?' (measured '+pc(W.measured)+')':'')+'</span><span><b>'+pc(W.factory)+'</b> factory</span><span><b>'+pc(W.you)+'</b> your sessions</span></div>'
    +'<div class="stat"><span><b>'+pc(P.main)+'</b> main agents</span><span><b>'+pc(P.design)+'</b> design critics</span><span><b>'+pc(P.review)+'</b> code reviewers</span><span><b>'+pc(P.other)+'</b> other subagents</span></div></section>';
  var al=U.alert_percent;
  function tone(x){return x==null?'':x>=al?'red':x>=al/2?'amber':'';}
  var T=W.tickets.map(function(t){
    return '<tr><td>'+(t.url?link(t.url,esc(t.key)):esc(t.key))+' <span class="c">'+cleanTitle(t.title||'')+' · '+esc(t.repo)+'</span></td><td class="n '+tone(t.percent)+'">'+pc(t.percent)+'</td><td class="n">'+pc(t.main)+'</td><td class="n">'+pc(t.design)+'</td><td class="n">'+pc(t.review)+'</td><td class="n">'+pc(t.other)+'</td><td class="n">'+t.sessions+'</td><td class="c">'+ago(t.last)+' ago</td></tr>';
  }).join('');
  h+='<section><h2>Factory tickets<span class="n">'+W.tickets.length+'</span></h2>'+(T?'<table><tr><th>Ticket</th><th class="n">% of week</th><th class="n">Main agent</th><th class="n">Design critics</th><th class="n">Reviewers</th><th class="n">Other subagents</th><th class="n">Sessions</th><th>Last active</th></tr>'+T+'</table>':'<div class="empty">No factory work in this window.</div>')+'</section>';
  var big=W.sessions.filter(function(x){return x.percent>=0.05;}),small=W.sessions.length-big.length;
  var S=big.map(function(x){
    return '<tr><td>'+esc(x.label)+'</td><td>'+cleanTitle(x.title||'(untitled)')+' <span class="c">'+esc(x.sid.slice(0,8))+'</span></td><td class="n '+tone(x.percent)+'">'+pc(x.percent)+'</td><td class="n">'+pc(x.main)+'</td><td class="n">'+pc(Math.round(((x.design||0)+(x.review||0)+(x.other||0))*100)/100)+'</td><td class="c">'+ago(x.last)+' ago</td></tr>';
  }).join('');
  h+='<section><h2>Your sessions<span class="n">'+W.sessions.length+'</span></h2>'+(S?'<table><tr><th>Workspace</th><th>Session</th><th class="n">% of week</th><th class="n">Main</th><th class="n">Subagents</th><th>Last active</th></tr>'+S+'</table>'+(small?'<div class="c" style="padding:8px 0">and '+small+' more sessions under 0.1% each</div>':''):'<div class="empty">No sessions of yours in this window.</div>')+'</section>';
  h+='<p class="c">The weekly percent is live from Anthropic. Each row is an estimate: its tokens priced at API rates, scaled so the week adds up to the live percent. Tickets at '+al+'% of the week or more show red.</p>';
  return h;
}
function wireUsage(){
  var g=document.getElementById('useg');if(!g)return;
  g.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){UW=b.getAttribute('data-w');render();});});
}
async function loadUsage(){try{U=await (await fetch('/api/usage')).json();}catch(e){return;}if(location.hash==='#usage')render();}
function render(){
  if(!D&&location.hash!=='#usage')return;
  D=D||{};
  var page=location.hash==='#projects'?'projects':location.hash==='#history'?'history':location.hash==='#usage'?'usage':'prs';
  document.getElementById('nav-prs').className=page==='prs'?'on':'';
  document.getElementById('nav-history').className=page==='history'?'on':'';
  document.getElementById('nav-projects').className=page==='projects'?'on':'';
  document.getElementById('nav-usage').className=page==='usage'?'on':'';
  var busy=(D.agents||[]).filter(function(a){return a.activity==='working';}).length;
  var t=D.last_tick;
  if(!D.metrics&&page!=='usage'){document.getElementById('meta').textContent='loading GitHub data…';return;}
  if(D.metrics)document.getElementById('meta').innerHTML='<b>'+(D.prs||[]).length+'</b> open PRs · <b>'+busy+'</b> of '+D.metrics.slots+' agents working · '+link('#projects','<b>'+D.shipped.length+'</b> shipped in 14 days')+' · last tick '+(t?ago(t.updated_at)+' ago':'never')+' · data '+ago(D.updated_at);
  var w=[D.error,D.warning,t&&(Date.now()-new Date(t.updated_at))>20*60000?'The tick has not run for '+ago(t.updated_at)+'.':null].filter(Boolean);
  document.getElementById('warn').textContent=w.join(' · ');
  document.getElementById('page').innerHTML=page==='usage'?usagePage():page==='projects'?projectsPage():page==='history'?historyPage():prsPage();
  if(page==='history')wireHistory();
  if(page==='usage')wireUsage();
  if(D.metrics)document.getElementById('diag').innerHTML=diag();
}
async function load(){try{D=await (await fetch('/api/state')).json();}catch(e){document.getElementById('meta').textContent='cannot reach the dashboard server';return;}render();}
window.addEventListener('hashchange',render);
load();loadUsage();loadLive();setInterval(load,60000);setInterval(loadUsage,120000);setInterval(loadLive,5000);
</script></body></html>`;

// Issue titles the GitHub refresh already holds, so the usage page can name packages that have finished.
function issueTitles() {
  const m = new Map();
  const d = cache.data;
  if (!d) return m;
  const add = (x) => { if (x?.number && x.repo && x.title) m.set(`${x.repo}#${x.number}`, { title: x.title, url: x.url }); };
  for (const h of d.history || []) if (h.kind === 'issue') add(h);
  for (const st of d.streams || []) for (const v of Object.values(st)) if (Array.isArray(v)) for (const x of v) { add(x); for (const t of x?.tickets || []) add(t); }
  return m;
}

http.createServer(async (req, res) => {
  try {
    // Only this machine's own pages: a foreign Host header is a DNS-rebinding page reading issue titles and transcripts.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) {
      res.writeHead(403);
      return res.end();
    }
    if (req.url.startsWith('/api/usage')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(await usageReport(cfg, cfg.tick.state_dir, issueTitles())));
    }
    if (req.url.startsWith('/api/live')) {
      if (!cache.data) await refresh();
      const agents = (cache.data?.agents || []).filter((a) => a.worktree_path).map((a) => {
        try { return { ...liveAgent(a), activity: a.activity, paused: a.paused }; } catch (e) { return { lead: a.lead, repo: a.repo, error: String(e.message || e) }; }
      });
      const repos = [...new Set(agents.map((a) => a.repo))];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ at: new Date().toISOString(), phases: PHASES, agents, typical: Object.fromEntries(repos.map((r) => [r, typicalByPhase(r)])), history_at: historyAge() ? new Date(historyAge()).toISOString() : null }));
    }
    if (req.url.startsWith('/api/state')) {
      if (!cache.data) await refresh();
      else if (Date.now() - cache.at > 55000) refresh();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...(cache.data || {}), error: cache.error, stale_s: cache.at ? Math.round((Date.now() - cache.at) / 1000) : null }));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(String(e.stack || e.message));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`factory dashboard on http://localhost:${PORT}`);
  refresh();
  // Step lengths of finished pieces, for the estimates: ~15 s the first time, then only new transcripts get parsed.
  setTimeout(() => { try { refreshHistory(cfg); } catch (e) { console.error('history', e); } }, 3000);
  setInterval(() => { try { refreshHistory(cfg); } catch (e) { console.error('history', e); } }, 30 * 60000);
  // One refresh costs about 28 GraphQL points; every 30 s around the clock spent two thirds of the 5,000-an-hour
  // budget the tick and the workers share. An open page still refreshes every minute through /api/state.
  setInterval(refresh, 15 * 60000);
});
