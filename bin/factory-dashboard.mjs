#!/usr/bin/env node
// factory-dashboard: work streams (targets) and what is actually happening to each ticket.
// No deps. http://localhost:7788   node bin/factory-dashboard.mjs [--port=7788]

import http from 'node:http';
import path from 'node:path';
import {
  STATE_MARK, QUESTION_MARK, TRIAGE_MARK, VERDICT_MARK, loadConfig, listSessions, sessionFor, sessionBusy, readCache, tailFile,
  minutesAgo, keyPattern, isTrustedBot,
} from '../lib/common.mjs';
import { fetchTargetIssues, findMarked, parseMarked, hasLabel, priorityRank, openBlockers } from '../lib/linear.mjs';
import { repoSlug, leadOfBranch, ownsPr, searchFactoryPrs, myOpenPrs } from '../lib/github.mjs';

let cfg = loadConfig();
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').slice(7)) || cfg.dashboard?.port || 7788;
let cache = { at: 0, data: null, error: null, refreshing: false };

function blockers(issue) {
  return openBlockers(issue).map((r) => ({ key: r.issue.identifier, state: r.issue.state?.name || r.issue.state?.type }));
}
function row(i) {
  return { key: i.identifier, title: i.title, url: i.url, status: i.state.name, priority: i.priority, created_at: i.createdAt, completed_at: i.completedAt || null };
}

const searchPrs = (q) => searchFactoryPrs(cfg, q);
const leadOf = (branch) => leadOfBranch(cfg, branch);
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED'];
const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];
const actorName = (a) => a?.login || a?.name || null;
// A trusted review bot's approval satisfies GitHub's floor, but a hold still needs a human.
const isBot = (login) => isTrustedBot(cfg, login);

function mergeVerdict(comments) {
  const c = comments.find((x) => x.body.startsWith(VERDICT_MARK));
  if (!c) return null;
  const text = c.body.replace(VERDICT_MARK, '').trim();
  const kind = text.match(/merge verdict:\W*(auto|hold)/i)?.[1].toLowerCase() || null;
  return { kind, reason: text.split('\n')[0].replace(/^\*\*merge verdict:[^*]*\*\*\s*/i, '').slice(0, 300), at: c.createdAt };
}
function prDetails(pr) {
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
  const checks = Object.fromEntries(contexts.filter((c) => c.name || c.context).map((c) => [c.name || c.context, c.conclusion || c.state || c.status]));
  const names = Object.keys(checks);
  const comments = pr.comments?.nodes || [];
  const requested = (pr.reviewRequests?.nodes || []).map((n) => actorName(n.requestedReviewer)).filter(Boolean);
  const verdict = mergeVerdict(comments);
  const requestedAt = (pr.timelineItems?.nodes || []).filter((e) => requested.includes(actorName(e.requestedReviewer))).map((e) => e.createdAt).sort().pop();
  const p = {
    number: pr.number, url: pr.url, title: pr.title, head: pr.headRefName, base: pr.baseRefName, draft: pr.isDraft, created_at: pr.createdAt,
    checks: { total: names.length, failing: names.filter((n) => FAILED.includes(checks[n])), pending: names.filter((n) => !FAILED.includes(checks[n]) && !PASSED.includes(checks[n])).length },
    review: pr.reviewDecision || 'none', merge_state: pr.mergeStateStatus, auto_merge: !!pr.autoMergeRequest,
    reviewers_requested: requested, approved_by: [...new Set((pr.reviews?.nodes || []).filter((r) => r.state === 'APPROVED').map((r) => r.author?.login).filter(Boolean))],
    verdict, waiting_since: requestedAt || verdict?.at || pr.createdAt,
  };
  p.bucket = prBucket(p);
  return p;
}
function prBucket(p) {
  if (p.checks.failing.length) return 'ci_failing';
  // A hold verdict means a human has to approve; a review bot's approval alone does not clear it.
  const humanApproved = p.approved_by.some((l) => !isBot(l));
  if (p.review === 'APPROVED' && (p.verdict?.kind !== 'hold' || humanApproved)) return 'approved_soon';
  // Only a review bot approved and the factory held it: that is the owner's call, not a reviewer's.
  if (p.review === 'APPROVED' && p.verdict?.kind === 'hold') return 'waiting_you';
  if (p.verdict?.kind === 'hold' || (['REVIEW_REQUIRED', 'CHANGES_REQUESTED'].includes(p.review) && p.reviewers_requested.length)) return 'waiting_human';
  if (p.checks.pending) return 'checks_running';
  return 'open';
}
// Bottom of the stack first; the bottom PR is the next to merge.
function stackOrder(prs) {
  const heads = new Set(prs.map((p) => p.head));
  const out = [];
  for (let cur = prs.find((p) => !heads.has(p.base)); cur && !out.includes(cur); cur = prs.find((p) => p.base === cur.head)) out.push(cur);
  return [...out, ...prs.filter((p) => !out.includes(p))];
}
function packageBucket(prs) {
  if (prs.some((p) => p.bucket === 'ci_failing')) return 'ci_failing';
  return prs[0].bucket;
}
const mentions = (text, key) => new RegExp(`\\b${keyPattern(key)}\\b`, 'i').test(text || '');
const byAge = (field) => (a, b) => String(a[field] || '9').localeCompare(String(b[field] || '9'));

async function collect() {
  cfg = loadConfig();
  const S = cfg.linear.states;
  const slug = repoSlug(cfg);
  const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const [openRaw, mergedRaw, mineOpen, targets] = await Promise.all([
    searchPrs(`repo:${slug} is:pr is:open author:@me head:${cfg.repo.branch_prefix}`),
    searchPrs(`repo:${slug} is:pr is:merged author:@me head:${cfg.repo.branch_prefix} merged:>=${since}`),
    myOpenPrs(cfg),
    Promise.all(cfg.targets.map(async (t) => [
      t,
      await fetchTargetIssues(t, [S.backlog, S.ready, S.in_progress, S.in_review]),
      (await fetchTargetIssues(t, [S.done, S.canceled])).filter((i) => minutesAgo(i.updatedAt) < 14 * 24 * 60),
    ])),
  ]);
  const sessionsRaw = listSessions();
  const sessions = sessionsRaw || [];
  const openPrs = openRaw.map((pr) => ({ ...prDetails(pr), lead: leadOf(pr.headRefName), body: pr.body }));
  const out = {
    updated_at: new Date().toISOString(), streams: [], needs_you: [], waiting_you: [], waiting_human: [], shipped: [], sessions: [], orphan_sessions: [],
    log: tailFile(path.join(cfg.tick.state_dir, 'tick.log'), 30), last_tick: readCache(cfg, 'last-tick.json', null),
    warning: sessionsRaw === null ? 'claude CLI not reachable from the dashboard process; session states are unknown' : null,
  };
  const knownWorktrees = new Set();
  const ticketStream = new Map();
  for (const [target, active, closed] of targets) {
    const stream = {
      name: target.name, project: target.project, milestone: target.milestone, scope_rule: target.scope_rule, paused: !!target.paused,
      max_in_flight: target.max_in_flight, in_flight: 0, max_awaiting_review: target.max_awaiting_review ?? null, reviewers: target.reviewers || [], links: target.links || null,
      working: [], ci_failing: [], waiting_you: [], waiting_human: [], approved_soon: [], checks_running: [], open: [],
      needs_you: [], queued: [], blocked: [], manual: [], later: [], decide: [], untriaged: [], shipped: [],
      done_14d: closed.filter((i) => i.state.name === S.done).map(row).sort(byAge('completed_at')).reverse(),
      canceled_14d: closed.filter((i) => i.state.name === S.canceled).length,
    };
    for (const i of [...active, ...closed]) ticketStream.set(i.identifier, { stream, ticket: row(i) });
    const leads = new Map();
    for (const i of active) {
      const st = parseMarked(findMarked(i, STATE_MARK));
      const triage = parseMarked(findMarked(i, TRIAGE_MARK));
      const q = findMarked(i, QUESTION_MARK);
      const r = { ...row(i), blockers: blockers(i), triage: triage ? { verdict: triage.verdict, reason: triage.reason } : null, package: st?.package || null, lead: st?.lead || null };
      if (st?.worktree) knownWorktrees.add(st.worktree);
      // Same rule as the tick's in-flight count: In Review packages do not hold a slot.
      if (st && i.state.name === S.in_progress) stream.in_flight++;
      const parked = hasLabel(i, cfg.linear.needs_human_label) || !!st?.parked_at;
      if (parked && (st || q)) {
        r.question = q ? q.body.replace(QUESTION_MARK, '').trim().slice(0, 400) : '(see ticket)';
        r.parked_at = st?.parked_at || null;
        stream.needs_you.push(r);
        out.needs_you.push({ ...r, stream: target.name });
        continue;
      }
      if (i.state.name === S.in_review || (i.state.name === S.in_progress && st)) {
        const lead = st?.lead || i.identifier;
        if (!leads.has(lead)) leads.set(lead, { lead, tickets: [], st, state: i.state.name });
        leads.get(lead).tickets.push(r);
        if (i.state.name === S.in_review) leads.get(lead).state = S.in_review;
        continue;
      }
      if (i.state.name === S.in_progress) {
        r.mentioned_by = openPrs.concat(mergedRaw).filter((p) => mentions(`${p.title}\n${p.body}`, r.key)).map((p) => p.number);
        r.own_prs = mineOpen.filter((p) => mentions(p.title, r.key)).map((p) => ({ number: p.number, url: p.url, created_at: p.createdAt }));
        stream.manual.push(r);
        continue;
      }
      // Same rule as the tick: a ticket blocked only by packages in review stacks on their PRs.
      const stacks = r.blockers.length && target.build_on_unmerged !== false && r.blockers.every((b) => active.find((x) => x.identifier === b.key)?.state.name === S.in_review);
      if (stacks) r.stacks_on = r.blockers.map((b) => b.key);
      if (i.state.name === S.ready) { (r.blockers.length && !stacks ? stream.blocked : stream.queued).push(r); continue; }
      if (triage?.verdict === 'later') stream.later.push(r);
      else if (triage?.verdict === 'decide') stream.decide.push(r);
      else stream.untriaged.push({ ...r, split: triage?.verdict === 'split' });
    }
    for (const pkg of leads.values()) {
      const s = sessionFor(sessions, pkg.st?.worktree);
      const session = s ? { id: s.id, busy: sessionBusy(s), state: s.state || s.status, started: s.startedAt ? new Date(s.startedAt).toISOString() : null } : null;
      const keys = pkg.tickets.map((t) => t.key);
      const open = stackOrder(openPrs.filter((p) => ownsPr(cfg, pkg.lead, keys, p)));
      const entry = {
        lead: pkg.lead, tickets: pkg.tickets, session, worktree: pkg.st?.worktree ? path.basename(pkg.st.worktree) : null,
        started_at: pkg.st?.started_at || null, restarts: pkg.st?.restarts || 0, last_babysit: pkg.st?.last_babysit || null,
        prs_open: open, prs_merged: mergedRaw.filter((p) => ownsPr(cfg, pkg.lead, keys, p)).map((p) => ({ number: p.number, url: p.url })),
      };
      entry.since = open.length ? open.map((p) => p.bucket === 'waiting_human' ? p.waiting_since : p.created_at).sort()[0] : entry.started_at;
      if (open.length) stream[packageBucket(open)].push(entry);
      else if (pkg.state === S.in_review) stream.open.push(entry);
      else stream.working.push(entry);
      for (const p of open.filter((x) => ['waiting_human', 'waiting_you'].includes(x.bucket))) out[p.bucket].push({ ...p, stream: target.name, tickets: pkg.tickets.map((t) => t.key) });
    }
    for (const k of ['working', 'ci_failing', 'waiting_you', 'waiting_human', 'approved_soon', 'checks_running', 'open']) stream[k].sort(byAge('since'));
    for (const k of ['blocked', 'manual', 'later', 'decide', 'untriaged']) stream[k].sort(byAge('created_at'));
    stream.queued.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || byAge('created_at')(a, b));
    stream.needs_you.sort(byAge('parked_at'));
    stream.awaiting_review = ['ci_failing', 'waiting_human', 'checks_running', 'open'].reduce((n, k) => n + stream[k].reduce((m, e) => m + e.prs_open.filter((p) => p.review !== 'APPROVED').length, 0), 0);
    out.streams.push(stream);
  }
  for (const pr of mergedRaw.sort(byAge('mergedAt')).reverse()) {
    const lead = leadOf(pr.headRefName);
    const owner = [...ticketStream.keys()].find((k) => mentions(pr.title, k)) || lead;
    const hit = ticketStream.get(owner) || ticketStream.get(lead);
    const m = {
      number: pr.number, url: pr.url, title: pr.title, merged_at: pr.mergedAt, base: pr.baseRefName, stream: hit?.stream.name || null,
      approved_by: [...new Set((pr.reviews?.nodes || []).filter((r) => r.state === 'APPROVED').map((r) => r.author?.login))],
      ticket: hit ? { key: hit.ticket.key, url: hit.ticket.url, status: hit.ticket.status, done_at: hit.ticket.completed_at } : { key: lead },
    };
    out.shipped.push(m);
    hit?.stream.shipped.push(m);
  }
  out.waiting_human.sort(byAge('waiting_since'));
  out.waiting_you.sort(byAge('waiting_since'));
  out.needs_you.sort(byAge('parked_at'));
  out.sessions = sessions.filter((s) => s.cwd && s.cwd.startsWith(cfg.repo.worktrees_dir)).map((s) => ({ id: s.id, name: s.name, busy: sessionBusy(s), state: s.state || s.status, worktree: path.basename(s.cwd), started: s.startedAt ? new Date(s.startedAt).toISOString() : null, known: knownWorktrees.has(s.cwd) }));
  out.orphan_sessions = out.sessions.filter((s) => !s.known);
  // Flat views for the page: every open PR once, under its own bucket (not its package's), and one row per agent.
  const PKG_BUCKETS = ['working', 'ci_failing', 'waiting_you', 'waiting_human', 'approved_soon', 'checks_running', 'open'];
  const allOpen = openPrs;
  out.prs = [];
  out.agents = [];
  for (const s of out.streams) {
    for (const k of PKG_BUCKETS) {
      for (const e of s[k]) {
        const tickets = e.tickets.map((t) => ({ key: t.key, url: t.url, title: t.title }));
        const activity = e.session ? (e.session.busy ? 'working' : 'idle') : 'none';
        out.agents.push({
          lead: e.lead, stream: s.name, project: s.project, milestone: s.milestone, tickets, activity, session: e.session,
          prs: e.prs_open.map((p) => ({ number: p.number, url: p.url, bucket: p.bucket })), started_at: e.started_at, last_babysit: e.last_babysit, restarts: e.restarts,
        });
        for (const p of e.prs_open) {
          const parent = p.base === cfg.repo.base ? null : allOpen.find((x) => x.head === p.base);
          const ticket = tickets.find((t) => mentions(p.title, t.key)) || tickets[0];
          const { body, ...rest } = p;
          out.prs.push({ ...rest, stream: s.name, project: s.project, milestone: s.milestone, ticket, agent: activity, parent: parent ? { number: parent.number, url: parent.url } : null });
        }
      }
    }
  }
  const prs = allOpen;
  out.metrics = {
    streams_active: out.streams.filter((s) => !s.paused).length, streams_paused: out.streams.filter((s) => s.paused).length,
    slots: cfg.workers.max_concurrent, workers_busy: out.sessions.filter((s) => s.busy).length,
    pr_open: prs.length, waiting_human: prs.filter((p) => p.bucket === 'waiting_human').length, approved_soon: prs.filter((p) => p.bucket === 'approved_soon').length,
    ci_failing: prs.filter((p) => p.bucket === 'ci_failing').length, needs_you: out.needs_you.length + out.waiting_you.length, merged_14d: out.shipped.length,
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

// The page: "PRs" (what needs to happen next, per PR) and "Projects" (distribution per target). The client code
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
.paused{color:var(--faint)}
</style></head><body><div class="wrap">
<header><h1>Factory</h1><nav><a href="#" id="nav-prs">PRs</a><a href="#projects" id="nav-projects">Projects</a></nav><span class="meta" id="meta">loading…</span></header>
<div id="warn" class="warn"></div>
<div id="page"></div>
<section style="margin-top:40px"><details><summary class="c">Diagnostics · tick log and raw sessions</summary><div id="diag"></div></details></section>
</div>
<script>
var D=null;
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function ago(t){if(!t)return '';var m=(Date.now()-new Date(t).getTime())/60000;if(m<1)return 'now';if(m<60)return Math.round(m)+'m';if(m<2880)return Math.round(m/60)+'h';return Math.round(m/1440)+'d';}
function link(u,t,cls){return u?'<a href="'+esc(u)+'" target="_blank" rel="noopener"'+(cls?' class="'+cls+'"':'')+'>'+t+'</a>':t;}
function cleanTitle(t){return esc(String(t||'').replace(/\s*\(([A-Z]+-\d+(,\s*[A-Z]+-\d+)*)\)\s*$/,''));}
function proj(x){return esc(x.stream);}
function next(p){
  var after=p.parent?'after '+link(p.parent.url,'#'+p.parent.number)+' · ':'';
  var b=p.bucket;
  if(b==='waiting_you')return {text:after+'Merge it or comment',why:p.verdict&&p.verdict.reason,age:'waiting '+ago(p.waiting_since)};
  if(b==='ci_failing')return {text:'Failing: '+esc(p.checks.failing.join(', ')),why:'agent '+(p.agent==='working'?'is fixing it':p.agent==='idle'?'idle, wakes next tick':'has no session'),age:'opened '+ago(p.created_at)};
  if(b==='waiting_human')return {text:p.reviewers_requested.length?'Waiting on '+esc(p.reviewers_requested.join(', ')):'<span style="color:var(--red)">No reviewer assigned</span>',why:p.verdict&&p.verdict.kind==='hold'?p.verdict.reason:'',age:'waiting '+ago(p.waiting_since)};
  if(b==='approved_soon')return {text:after+(p.auto_merge?'Auto-merge on':p.parent?'Merges with its stack':'Approved · auto-merge not armed'),age:'opened '+ago(p.created_at)};
  if(b==='checks_running')return {text:'Checks running ('+p.checks.pending+')',age:'opened '+ago(p.created_at)};
  return {text:p.review==='APPROVED'?'Approved':'Waiting on review',age:'opened '+ago(p.created_at)};
}
var KIDS={};
function prRow(p){
  var n=next(p);
  var kids=KIDS[p.number]||[];
  if(kids.length)n.why=(n.why?n.why+' · ':'')+kids.length+' stacked PR'+(kids.length>1?'s':'')+' merge after it: '+kids.map(function(k){return '#'+k.number;}).join(' ');
  return '<div class="row"><div>'+link(p.url,'<span class="num">#'+p.number+'</span>'+cleanTitle(p.title),'t')+(n.why?'<div class="why">'+esc(n.why)+'</div>':'')+'</div>'
    +'<div class="c">'+proj(p)+'</div><div class="c">'+(p.ticket?link(p.ticket.url,esc(p.ticket.key)):'')+'</div>'
    +'<div class="next">'+n.text+'</div><div class="age">'+esc(n.age||'')+'</div></div>';
}
function questionRow(t){
  return '<div class="row"><div><span class="tag">QUESTION</span>'+link(t.url,cleanTitle(t.title),'t')+'<div class="why">'+esc(t.question)+'</div></div>'
    +'<div class="c">'+esc(t.stream)+'</div><div class="c">'+link(t.url,esc(t.key))+'</div>'
    +'<div class="next">Reply on the Linear ticket</div><div class="age">waiting '+esc(ago(t.parked_at))+'</div></div>';
}
function decideRow(t){
  return '<div class="row"><div><span class="tag">DECIDE</span>'+link(t.url,cleanTitle(t.title),'t')+'<div class="why">'+esc(t.triage&&t.triage.reason)+'</div></div>'
    +'<div class="c">'+esc(t.stream)+'</div><div class="c">'+link(t.url,esc(t.key))+'</div>'
    +'<div class="next">Pick an option on the ticket, then move it to Todo</div><div class="age">created '+esc(ago(t.created_at))+'</div></div>';
}
function section(title,tone,items,render,emptyNote){
  if(!items.length&&!emptyNote)return '';
  return '<section class="'+tone+'"><h2>'+title+'<span class="n">'+items.length+'</span></h2>'+(items.length?items.map(render).join(''):'<div class="empty">'+emptyNote+'</div>')+'</section>';
}
function byAge(f){return function(a,b){return String(a[f]||'9').localeCompare(String(b[f]||'9'));};}
function prsPage(){
  var P=D.prs||[];
  // A PR stacked on an open PR merges with its stack, so only the stack's bottom PR shows (unless the child's CI is red).
  var byNum={};P.forEach(function(p){byNum[p.number]=p;});
  function stacked(p){return !!(p.parent&&byNum[p.parent.number]);}
  function rootOf(p){for(var i=0;i<20&&stacked(p);i++)p=byNum[p.parent.number];return p;}
  KIDS={};P.forEach(function(p){if(stacked(p)){var r=rootOf(p).number;(KIDS[r]=KIDS[r]||[]).push(p);}});
  function of(b){return P.filter(function(p){return p.bucket===b&&(!stacked(p)||b==='ci_failing');});}
  var yours=of('waiting_you').sort(byAge('waiting_since'));
  var h='';
  var decide=D.streams.flatMap(function(s){return s.decide.map(function(t){return Object.assign({},t,{stream:s.name});});});
  var needs=yours.map(prRow).concat((D.needs_you||[]).map(questionRow)).concat(decide.map(decideRow));
  h+='<section class="amber"><h2>Needs your call<span class="n">'+needs.length+'</span></h2>'+(needs.join('')||'<div class="empty">Nothing needs your call.</div>')+'</section>';
  h+=section('CI failing','red',of('ci_failing'),prRow);
  h+=section('Needs a reviewer','',of('waiting_human').sort(byAge('waiting_since')),prRow);
  h+=section('Approved · merging','green',of('approved_soon'),prRow);
  h+=section('Checks running or waiting on review','',of('checks_running').concat(of('open')),prRow);
  h+=agentsTable();
  return h;
}
function agentsTable(){
  var A=(D.agents||[]).slice().sort(function(a,b){return (a.activity==='working'?0:1)-(b.activity==='working'?0:1)||String(a.stream).localeCompare(String(b.stream));});
  var orphans=D.orphan_sessions||[];
  var label={working:'Working',idle:'Idle',none:'No session'};
  var rows=A.map(function(a){
    var prs=a.prs.length?a.prs.map(function(p){return link(p.url,'#'+p.number);}).join(' '):'<span class="c">no PR yet</span>';
    return '<tr><td><span class="dot '+a.activity+'"></span>'+esc(label[a.activity])+'</td><td>'+esc(a.stream)+'</td>'
      +'<td>'+a.tickets.map(function(t){return link(t.url,esc(t.key))+' <span class="c">'+cleanTitle(t.title)+'</span>';}).join('<br>')+'</td>'
      +'<td>'+prs+'</td><td class="c">'+(a.last_babysit?'babysat '+ago(a.last_babysit)+' ago':'started '+ago(a.started_at)+' ago')+(a.restarts?' · '+a.restarts+' restarts':'')+'</td></tr>';
  }).concat(orphans.map(function(s){return '<tr><td><span class="dot '+(s.busy?'working':'')+'"></span>'+(s.busy?'Working':'Idle')+'</td><td class="c">unknown</td><td class="c">'+esc(s.worktree)+' · no ticket claims it</td><td></td><td class="c">started '+ago(s.started)+' ago</td></tr>';}));
  var busy=A.filter(function(a){return a.activity==='working';}).length;
  return '<section><h2>Agents<span class="n">'+busy+' working · '+A.length+' total</span></h2>'+(rows.length?'<table><tr><th>Activity</th><th>Project</th><th>Tickets</th><th>PRs</th><th>Last</th></tr>'+rows.join('')+'</table>':'<div class="empty">No agents.</div>')+'</section>';
}
function projectsPage(){
  var P=D.prs||[],A=D.agents||[];
  function cnt(s,b){return P.filter(function(p){return p.stream===s.name&&p.bucket===b;}).length;}
  function td(n,tone){return '<td class="n '+(n?tone||'':'zero')+'">'+n+'</td>';}
  var head='<tr><th>Project</th><th class="n">Queued</th><th class="n">Building</th><th class="n">Needs you</th><th class="n">CI failing</th><th class="n">Needs reviewer</th><th class="n">Approved</th><th class="n">Other open</th><th class="n">Agents working</th><th class="n">Merged 14d</th></tr>';
  var rows=D.streams.map(function(s){
    return '<tr class="'+(s.paused?'paused':'')+'"><td>'+esc(s.name)+'<div class="c">'+esc(s.project)+' › '+esc(s.milestone||'all')+(s.paused?' · paused':'')+'</div></td>'
      +td(s.queued.length)+td(s.working.length)+td(cnt(s,'waiting_you')+s.needs_you.length+s.decide.length,'amber')+td(cnt(s,'ci_failing'),'red')+td(cnt(s,'waiting_human'))
      +td(cnt(s,'approved_soon'),'green')+td(cnt(s,'checks_running')+cnt(s,'open'))+td(A.filter(function(a){return a.stream===s.name&&a.activity==='working';}).length,'green')+td(s.shipped.length)+'</tr>';
  }).join('');
  var h='<section><h2>Projects</h2><table>'+head+rows+'</table></section>';
  h+='<section><h2>Details</h2>'+D.streams.map(streamDetails).join('')+'</section>';
  h+='<section><h2>Merged in 14 days<span class="n">'+D.shipped.length+' factory PRs</span></h2>'+D.shipped.map(function(m){
    return '<div class="row" style="grid-template-columns:minmax(0,1fr) 170px 100px 170px 96px"><div>'+link(m.url,'<span class="num">#'+m.number+'</span>'+cleanTitle(m.title),'t')+'</div><div class="c">'+esc(m.stream||'')+'</div><div class="c">'+(m.ticket.url?link(m.ticket.url,esc(m.ticket.key)):esc(m.ticket.key||''))+'</div><div class="c">approved by '+esc(m.approved_by.join(', ')||'nobody')+'</div><div class="age">'+ago(m.merged_at)+' ago</div></div>';
  }).join('')+'</section>';
  return h;
}
function tlist(title,items,extra){
  if(!items.length)return '';
  return '<h3>'+title+' · '+items.length+'</h3>'+items.map(function(t){return '<div class="li">'+link(t.url,esc(t.key))+' '+cleanTitle(t.title)+(extra?'<span class="c">'+extra(t)+'</span>':'')+'</div>';}).join('');
}
function streamDetails(s){
  var links=s.links?Object.keys(s.links).map(function(k){return link(s.links[k],esc(k));}).join(' · '):'';
  return '<details><summary>'+esc(s.name)+'<span class="c">'+(s.paused?'paused · ':'')+s.in_flight+' of '+s.max_in_flight+' slots used · '+s.awaiting_review+' of '+(s.max_awaiting_review==null?'∞':s.max_awaiting_review)+' PRs awaiting review'+(s.reviewers.length?' · reviewer '+esc(s.reviewers.join(', ')):'')+'</span></summary><div class="sub">'
    +'<div class="scope">'+esc(s.scope_rule)+'</div>'+(links?'<div class="c" style="margin-top:6px">'+links+'</div>':'')
    +tlist('Queued',s.queued,function(t){return t.stacks_on?' · stacks on '+esc(t.stacks_on.join(', ')):'';})
    +tlist('Blocked',s.blocked,function(t){return ' · by '+t.blockers.map(function(b){return esc(b.key);}).join(', ');})
    +tlist('Decide',s.decide,function(t){return t.triage?' · '+esc(t.triage.reason):'';})
    +tlist('In Progress, not the factory',s.manual)
    +tlist('Untriaged',s.untriaged)
    +tlist('Later · out of scope',s.later)
    +tlist('Linear Done in 14 days',s.done_14d,function(t){return ' · '+ago(t.completed_at)+' ago';})
    +'</div></details>';
}
function diag(){
  var t=D.last_tick;
  return '<pre>'+(t?'last tick '+ago(t.updated_at)+' ago, took '+t.took_s+'s · dispatched '+t.dispatched.length+' · woke '+t.woke.length+' · resumed '+t.resumed.length+' · parked '+t.parked.length+'\n\n':'')
    +esc((D.log||[]).join('\n'))+'\n\nsessions:\n'+esc((D.sessions||[]).map(function(s){return s.worktree+'  '+(s.busy?'working':s.state)+'  claude attach '+s.id;}).join('\n'))+'</pre>';
}
function render(){
  if(!D)return;
  var page=location.hash==='#projects'?'projects':'prs';
  document.getElementById('nav-prs').className=page==='prs'?'on':'';
  document.getElementById('nav-projects').className=page==='projects'?'on':'';
  var busy=(D.agents||[]).filter(function(a){return a.activity==='working';}).length;
  var t=D.last_tick;
  document.getElementById('meta').innerHTML='<b>'+(D.prs||[]).length+'</b> open PRs · <b>'+busy+'</b> of '+D.metrics.slots+' agents working · '+link('#projects','<b>'+D.shipped.length+'</b> factory PRs merged in 14 days')+' · last tick '+(t?ago(t.updated_at)+' ago':'never')+' · data '+ago(D.updated_at);
  var w=[D.error,D.warning,t&&(Date.now()-new Date(t.updated_at))>20*60000?'The tick has not run for '+ago(t.updated_at)+'.':null].filter(Boolean);
  document.getElementById('warn').textContent=w.join(' · ');
  document.getElementById('page').innerHTML=page==='projects'?projectsPage():prsPage();
  document.getElementById('diag').innerHTML=diag();
}
async function load(){try{D=await (await fetch('/api/state')).json();}catch(e){document.getElementById('meta').textContent='cannot reach the dashboard server';return;}render();}
window.addEventListener('hashchange',render);
load();setInterval(load,30000);
</script></body></html>`;

http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/state')) {
      if (!cache.data) await refresh();
      else if (Date.now() - cache.at > 25000) refresh();
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
  setInterval(refresh, 30000);
});
