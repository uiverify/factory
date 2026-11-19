#!/usr/bin/env node
// factory-tick: one reconcile pass over GitHub issues + PRs + local Claude sessions, for every repo in factory.json.
// No LLM in the control loop. The only Claude invocations are explicit: a worker (`/factory-auto`), a babysit
// tick, a triage call, a package-planning call.
//
//   node bin/factory-tick.mjs [--dry-run] [--verbose] [--only=<target>]
//
// State of record is GitHub: issue labels (`factory: *`) + one `<!-- factory-state -->` comment per claimed issue.
// Local files under state/ are caches (signal hashes, lock, log). The flow is ~/.claude/factory/issues.md.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  ROOT, STATE_MARK, TRIAGE_MARK, QUESTION_MARK, NOTE_MARK, LABELS, TRIAGE_LABEL, PRIORITY_LABELS, loadConfig, sh, shJson,
  fetchRepoIssues, inTarget, isBatchParent, hasLabel, hasFactoryLabel, priorityRank, blockedByOpen, findMarked, parseMarked,
  humanCommentsAfter, ensureLabels, factoryPrs, packagePrs, prRef, prSignals, wakeWorthy, checksOf, prIsGreen, listSessions, sessionFor, sessionBusy,
  sessionAlive, inWorktreesOf, lastApiError, sessionQuiet, sessionRateLimited, rateLimitRetry, isLimitText, readCache, writeCache, minutesAgo,
  WAKE_FRESH_TOKENS, HANDOFF_FILE, HANDOFF_LINE, contextTokens, sessionTranscript, endedWithHandoff,
} from '../lib/common.mjs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const cfg = loadConfig();
// Who the factory works for: named in worker prompts and parked questions, and @-mentioned when `owner.github` is set.
const OWNER = cfg.owner.name;
const MENTION = cfg.owner.github ? `@${cfg.owner.github} ` : '';
const STATE_DIR = cfg.tick.state_dir;
// A session launched moments ago may not be listed yet: do not mistake it for a stopped one.
const START_GRACE_MINUTES = 5;
// A busy session whose turn ended is waiting on its own background jobs. Once its package is closed they don't matter
// after this long; with the package still open, nothing moving for this long means it waits on a job that never reports.
const DONE_QUIET_MINUTES = 10;
// A busy session with nothing moving for this long is stuck, whether its turn ended (a background job that never
// reports) or not (a request that never returned: seen when the usage limit hit mid-turn).
const WEDGED_MINUTES = 60;
// A failed `claude -p` does not say when the limit resets: pause this long, then try again.
const LIMIT_RETRY_MINUTES = 30;
const LIMIT_OUTAGE_GAP_MINUTES = 60;

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

// ---------- GitHub writes ----------
function renderState(state) {
  return [STATE_MARK, '**Factory state** (machine-owned; humans: do not edit)', '', '```json', JSON.stringify(state, null, 2), '```'].join('\n');
}
function writeState(repo, issue, state) {
  const existing = findMarked(issue, STATE_MARK);
  state.updated_at = new Date().toISOString();
  const body = renderState(state);
  if (existing) {
    act(`update state comment on ${issue.key}`, () => sh('gh', ['api', '-X', 'PATCH', `repos/${repo.github}/issues/comments/${existing.id}`, '-f', `body=${body}`]));
    existing.body = body;
  } else {
    const res = act(`create state comment on ${issue.key}`, () => shJson('gh', ['api', `repos/${repo.github}/issues/${issue.number}/comments`, '-f', `body=${body}`]));
    issue.comments.push({ id: res?.id || 'dry', body, createdAt: new Date().toISOString(), author: null });
  }
}
function addComment(repo, issue, body, why) {
  act(`comment on ${issue.key} (${why})`, () => sh('gh', ['api', `repos/${repo.github}/issues/${issue.number}/comments`, '-f', `body=${body}`]));
}
function editIssue(repo, issue, { add = [], remove = [], assignMe = false }, why) {
  const adds = add.filter((l) => !issue.labels.includes(l));
  const removes = remove.filter((l) => issue.labels.includes(l));
  if (!adds.length && !removes.length && !assignMe) return;
  const args = ['issue', 'edit', String(issue.number), '-R', repo.github];
  for (const l of adds) args.push('--add-label', l);
  for (const l of removes) args.push('--remove-label', l);
  if (assignMe) args.push('--add-assignee', '@me');
  act(`edit ${issue.key} (${why}):${adds.length ? ` +[${adds.join(', ')}]` : ''}${removes.length ? ` -[${removes.join(', ')}]` : ''}${assignMe ? ' assign @me' : ''}`, () => sh('gh', args));
  issue.labels = [...issue.labels.filter((l) => !removes.includes(l)), ...adds];
}
// ---------- Claude invocations ----------
function workerEnv(repo) {
  return {
    ...process.env, ...(cfg.workers.env || {}), FACTORY_ROOT: ROOT, FACTORY_ISSUES_DOC: cfg.issues_doc,
    FACTORY_PRINCIPLES: repo.principles, FACTORY_REPO: repo.github, FACTORY_SHIP: repo.ship,
  };
}
// A target may override its repo's ship mode, worker model and effort: a project inside a repo can run on a stronger
// model, or build on one long-lived branch instead of a PR per issue.
function forTarget(repo, target) {
  return {
    ...repo,
    ship: target.ship || repo.ship,
    ship_why: target.ship_why || repo.ship_why,
    worker_model: target.worker_model || repo.worker_model,
    worker_effort: target.worker_effort || repo.worker_effort,
    plugins: target.plugins || repo.plugins,
    ...(target.ship === 'branch' ? { long_branch: target.branch, target_name: target.name } : {}),
    ...(target.land_on ? { land_on: target.land_on } : {}),
  };
}
// The configured model wins on every wake, so a config change reaches packages already in flight (moving workers to
// Sonnet once left nine Opus packages running). The package's own model only covers a repo with none set,
// so a resume never falls back to whatever the CLI defaults to.
function workerModel(repo, st) {
  return repo.worker_model || st?.model || cfg.workers.model;
}
// Workers get the plugins their target lists (`plugins`, by name or name@marketplace) and none of the others the owner
// has enabled: a handful of plugins' skill listings can cost every session ~12k tokens before its first step.
function workerSettings(repo) {
  const base = JSON.parse(fs.readFileSync(cfg.workers.settings, 'utf8'));
  let enabled = {};
  try { enabled = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.claude', 'settings.json'), 'utf8')).enabledPlugins || {}; } catch {}
  const wanted = repo?.plugins || [];
  const off = Object.keys(enabled).filter((k) => enabled[k] && !wanted.some((w) => k === w || k.startsWith(`${w}@`)));
  return JSON.stringify({ ...base, enabledPlugins: { ...(base.enabledPlugins || {}), ...Object.fromEntries(off.map((k) => [k, false])) } });
}
function effortOf(repo) {
  return repo.worker_effort || cfg.workers.effort;
}
// A wake on a conversation this big starts a fresh session from the worker's own handoff instead: resumed wakes were
// seen starting on a median 578k tokens, paid again on every turn. The worker rewrites the handoff each time it
// goes idle (factoryRules); a fresh start moves it aside, so the next one is used only once it's been rewritten.
function takeHandoff(cwd, sessionId) {
  const file = path.join(cwd, HANDOFF_FILE);
  if (!fs.existsSync(file)) return null;
  const tokens = contextTokens(sessionTranscript(cwd, sessionId));
  if (tokens < WAKE_FRESH_TOKENS) return null;
  const used = path.join(cwd, '.context', `handoff-used-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  fs.renameSync(file, used);
  log(`fresh session for ${path.basename(cwd)} from its handoff (old context ${Math.round(tokens / 1000)}k)`);
  return `You are taking over this factory job from a previous session whose context grew too large to keep resuming. Its handoff is ${used}: read it first, then the factory state comment on the issue and \`git log\`, and continue from its "next step". Don't redo finished work.\n\n`;
}
function claudeBg({ repo, cwd, name, prompt, resume, model, extraArgs = [] }) {
  const briefing = resume && !DRY ? takeHandoff(cwd, resume) : null;
  if (briefing) {
    try { sh('claude', ['stop', resume.slice(0, 8)], { timeout: 30000 }); } catch {}
    for (let i = 0; i < 15 && ['working', 'running', 'blocked'].includes((listSessions() || []).find((x) => x.sessionId === resume)?.state); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    const out = claudeBg({ repo, cwd, name, prompt: briefing + prompt, model: model || workerModel(repo), extraArgs });
    try { sh('claude', ['rm', resume.slice(0, 8)], { timeout: 30000 }); } catch (e) { log('claude rm of the old session failed:', String(e.message).split('\n')[0]); }
    return out;
  }
  // A wake resumes the conversation as a copy that carries the worker flags (a resume with flags always copies, and a
  // copy without them waits on permission prompts), then removes the old session: one session per worktree, history kept.
  if (resume) {
    try { sh('claude', ['stop', resume.slice(0, 8)], { timeout: 30000 }); } catch {}
    // stop returns before the session is down; two live sessions in one worktree would edit the same files.
    for (let i = 0; i < 15 && ['working', 'running', 'blocked'].includes((listSessions() || []).find((x) => x.sessionId === resume)?.state); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  const args = ['--bg', ...(resume ? ['--resume', resume] : ['--name', name || path.basename(cwd)]), ...(model ? ['--model', model] : []),
    ...(effortOf(repo) ? ['--effort', effortOf(repo)] : []), ...(cfg.workers.claude_args || []), '--settings', workerSettings(repo), ...extraArgs, prompt];
  vlog('$ claude', args.slice(0, -1).join(' '), '<prompt>');
  const r = spawnSync('claude', args, { cwd, env: workerEnv(repo), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  if (r.status !== 0) {
    // A removed session cannot be woken: start a fresh one in the same worktree rather than failing the whole tick.
    if (resume) return claudeBg({ repo, cwd, name, prompt, model: model || workerModel(repo), extraArgs });
    throw new Error(`claude --bg failed: ${r.stderr || r.stdout}`);
  }
  const out = (r.stdout || '').trim();
  const started = out.match(/backgrounded · ([0-9a-f]{8})/)?.[1];
  if (resume && started && started !== resume.slice(0, 8)) {
    try { sh('claude', ['rm', resume.slice(0, 8)], { timeout: 30000 }); } catch (e) { log('claude rm of the old session failed:', String(e.message).split('\n')[0]); }
  }
  return out;
}
function parseClaudeJson(stdout) {
  const envelope = JSON.parse(stdout);
  if (envelope.structured_output) return envelope.structured_output;
  const text = typeof envelope.result === 'string' ? envelope.result : JSON.stringify(envelope.result);
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text);
}
function claudeJsonArgs({ repo, model, schema, prompt, sessionId }) {
  const args = ['-p', '--output-format', 'json', '--model', model || 'sonnet', ...(cfg.workers.claude_args || []), '--settings', workerSettings(repo)];
  if (sessionId) args.push('--session-id', sessionId);
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  args.push(prompt);
  return args;
}
// Over the account limit `claude -p` doesn't fail: it retries the 429 for hours, so a triage only ever timed out and the
// tick never paused (15 minutes lost per tick). Watch its transcript and give up on the first 429 retry.
const RATE_LIMIT_POLL_MS = 15000;
function claudeJsonAsync({ repo, cwd, prompt, model, schema, timeoutMs = 15 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const sessionId = crypto.randomUUID();
    // Its own process group, so a kill reaches whatever it spawned: a surviving grandchild holds the pipes open and the
    // tick (and its lock) would never exit.
    const child = spawn('claude', claudeJsonArgs({ repo, model, schema, prompt, sessionId }), { cwd, env: workerEnv(repo), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '', err = '', settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      fn(v);
    };
    const signal = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const kill = () => {
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), 10000);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    const timer = setTimeout(() => { kill(); finish(reject, new Error('claude -p timed out')); }, timeoutMs);
    const poll = setInterval(() => {
      const rl = rateLimitRetry(sessionTranscript(cwd, sessionId));
      if (!rl) return;
      kill();
      finish(reject, new Error('claude -p failed (usage_limit_reached): the API answered 429 and the CLI is retrying'));
    }, RATE_LIMIT_POLL_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (code !== 0) return finish(reject, new Error(`claude -p failed${isLimitText(out + err) ? ' (usage_limit_reached)' : ''}: ${(err || out).slice(0, 2000)}`));
      try { finish(resolve, parseClaudeJson(out)); } catch (e) { finish(reject, e); }
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
// A stacked issue starts from its parent PR's branch instead of the base.
function ensureWorktree(repo, lead, from = repo.base, { dir = `factory-${lead}`, branch = `${repo.branch_prefix}${lead}` } = {}) {
  const wt = path.join(repo.worktrees_dir, dir);
  if (fs.existsSync(wt)) return { wt, branch, created: false };
  fs.mkdirSync(repo.worktrees_dir, { recursive: true });
  act(`git fetch ${repo.remote} (${repo.name})`, () => sh('git', ['fetch', '--prune', repo.remote], { cwd: repo.path }));
  act(`git worktree add ${wt} (${branch} from ${repo.remote}/${from})`, () => {
    try {
      sh('git', ['worktree', 'add', '-b', branch, wt, `${repo.remote}/${from}`], { cwd: repo.path });
    } catch {
      sh('git', ['worktree', 'add', wt, branch], { cwd: repo.path });
    }
  });
  // Every session here runs unattended, including a copy that `--resume` starts without the original's flags.
  act(`bypass permissions in ${wt}`, () => {
    fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }, null, 2) + '\n');
  });
  if (repo.setup) act(`setup worktree: ${repo.setup}`, () => sh('sh', ['-c', repo.setup], { cwd: wt, stdio: ['ignore', 'ignore', 'pipe'], timeout: 600000 }));
  return { wt, branch, created: true };
}
// A branch-mode target builds every issue, one after another, in one worktree on its long-lived branch, which starts
// from the base the first time and from the pushed branch after that.
function ensureBranchWorktree(repo) {
  const wt = path.join(repo.worktrees_dir, `factory-${repo.target_name}`);
  const branch = repo.long_branch;
  if (fs.existsSync(wt)) return { wt, branch, created: false };
  act(`git fetch ${repo.remote} (${repo.name})`, () => sh('git', ['fetch', '--prune', repo.remote], { cwd: repo.path }));
  const pushed = !!sh('git', ['ls-remote', '--heads', repo.remote, branch], { cwd: repo.path }).trim();
  return ensureWorktree(repo, null, pushed ? branch : repo.base, { dir: `factory-${repo.target_name}`, branch });
}
// The tick pushes a branch-mode target's branch after each finished package: the worker only commits, so the backup and
// the final PR don't wait on a push the repo's review gate would judge against the whole branch.
// Other targets merge into the same branch (`land_on`), so take theirs first; a conflict fails the push and the tick retries.
function pushLongBranch(repo, wt, branch) {
  act(`git push ${repo.remote} ${branch} (from ${wt})`, () => {
    sh('git', ['fetch', repo.remote], { cwd: wt });
    if (sh('git', ['ls-remote', '--heads', repo.remote, branch], { cwd: wt }).trim()) {
      try {
        sh('git', ['merge', '--no-edit', `${repo.remote}/${branch}`], { cwd: wt });
      } catch (e) {
        try { sh('git', ['merge', '--abort'], { cwd: wt }); } catch {}
        throw Object.assign(e, { mergeConflict: true });
      }
    }
    sh('git', ['push', repo.remote, `HEAD:refs/heads/${branch}`], { cwd: wt });
  });
}
// A `land_on` target's finished package: merge its worktree branch into the shared branch from a scratch worktree, so no
// worker's checkout moves. Workers don't push it themselves: the review gate would judge the merged branch, not their piece.
function mergeIntoLongBranch(repo, wt, branch) {
  const own = sh('git', ['branch', '--show-current'], { cwd: wt }).trim();
  const tmp = path.join(repo.worktrees_dir, `merge-into-${branch.replace(/[^a-zA-Z0-9]/g, '-')}`);
  act(`merge ${own} into ${branch} and push`, () => {
    sh('git', ['fetch', repo.remote], { cwd: repo.path });
    if (fs.existsSync(tmp)) sh('git', ['worktree', 'remove', '--force', tmp], { cwd: repo.path });
    sh('git', ['worktree', 'add', '--detach', tmp, `${repo.remote}/${branch}`], { cwd: repo.path });
    try {
      try {
        sh('git', ['merge-base', '--is-ancestor', own, 'HEAD'], { cwd: tmp });
        return;
      } catch { /* not merged yet */ }
      try {
        sh('git', ['merge', '--no-edit', '--no-ff', '-m', `Merge ${own} into ${branch}`, own], { cwd: tmp });
      } catch (e) {
        try { sh('git', ['merge', '--abort'], { cwd: tmp }); } catch {}
        throw Object.assign(e, { mergeConflict: true });
      }
      sh('git', ['push', repo.remote, `HEAD:refs/heads/${branch}`], { cwd: tmp });
    } finally {
      sh('git', ['worktree', 'remove', '--force', tmp], { cwd: repo.path });
    }
  });
}
function removeWorktree(repo, wt) {
  if (!fs.existsSync(wt)) return;
  act(`git worktree remove ${wt}`, () => {
    try {
      sh('git', ['worktree', 'remove', '--force', wt], { cwd: repo.path });
    } catch (e) {
      log('worktree remove failed:', String(e.message).split('\n')[0]);
    }
  });
}
// Subagent worktrees (agent-*) are left behind when they hold commits. Their branches keep the commits,
// so a clean one older than 3 days only costs disk. A detached HEAD may hold the only copy: keep it.
function sweepAgentWorktrees(repo) {
  let dirs = [];
  try { dirs = fs.readdirSync(repo.worktrees_dir).filter((d) => d.startsWith('agent-')); } catch { return; }
  for (const d of dirs) {
    const wt = path.join(repo.worktrees_dir, d);
    if (minutesAgo(fs.statSync(wt).mtime) < 3 * 24 * 60) continue;
    try {
      if (sh('git', ['status', '--porcelain'], { cwd: wt }).trim()) continue;
      if (sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt }).trim() === 'HEAD') continue;
    } catch { continue; }
    removeWorktree(repo, wt);
  }
}

async function openBranchPr(repo, target, summary) {
  const branch = target.branch;
  try {
    if (!sh('git', ['ls-remote', '--heads', repo.remote, branch], { cwd: repo.path }).trim()) return;
    sh('git', ['fetch', repo.remote, repo.base, branch], { cwd: repo.path });
    // An open PR is already the one; a merged or closed one at this same head means the owner already dealt with it (a squash
    // merge leaves the branch's commits looking unmerged).
    const head = sh('git', ['rev-parse', `${repo.remote}/${branch}`], { cwd: repo.path }).trim();
    const existing = shJson('gh', ['pr', 'list', '-R', repo.github, '--head', branch, '--state', 'all', '--json', 'state,headRefOid']) || [];
    if (existing.some((p) => p.state === 'OPEN' || p.headRefOid === head)) return;
    const commits = sh('git', ['log', '--reverse', '--format=- %s (%h)', `${repo.remote}/${repo.base}..${repo.remote}/${branch}`], { cwd: repo.path }).trim();
    if (!commits) return;
    const batch = target.batch ? `Closes #${target.batch}.\n\n` : '';
    const body = `${batch}Built by the factory in branch mode: each commit below is one issue of the \`${target.name}\` target, reviewed and through the repo's checks on its own, and its issue was closed when it landed here. No review of the whole branch; merge once CI is green.\n\n${commits}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
    const url = act(`open the branch PR for ${target.name} (${branch} -> ${repo.base})`, () =>
      sh('gh', ['pr', 'create', '-R', repo.github, '--base', repo.base, '--head', branch, '--title', target.pr_title || `${target.name}: the branch's work`, '--body', body]).trim());
    if (url) {
      await notify(`Factory: ${target.name} is done on ${branch}. One PR for all of it: ${url}. Merge once CI is green.`, url);
      summary.done.push(`${target.name} PR`);
    }
  } catch (e) {
    log(`branch PR for ${target.name} failed: ${String(e.message).split('\n')[0]}`);
  }
}

// ---------- notify ----------
// Slack mrkdwn link; the relay posts text verbatim, so a bare "#123" would not be clickable.
function slackLink(url, label) {
  return `<${url}|${label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '/')}>`;
}
// macOS banner. terminal-notifier opens the URL on click; without it, osascript shows a plain banner.
function desktopNotify(text, url) {
  if (DRY || cfg.notify?.desktop === false) return;
  const [title, ...rest] = text.replace(/<([^|>]+)\|([^>]+)>/g, '$2').split('\n').filter(Boolean);
  const message = (rest[0] || title).slice(0, 200);
  try {
    const args = ['-title', 'Factory', '-subtitle', title.slice(0, 120), '-message', message, '-sound', 'default'];
    if (url) args.push('-open', url);
    sh('terminal-notifier', args, { timeout: 10000 });
  } catch {
    try {
      sh('osascript', ['-e', 'on run argv\ndisplay notification (item 1 of argv) with title "Factory" subtitle (item 2 of argv) sound name "default"\nend run', message, title.slice(0, 120)], { timeout: 10000 });
    } catch (e) { log('desktop notify failed:', String(e.message).split('\n')[0]); }
  }
}
async function notify(text, url) {
  desktopNotify(text, url);
  if (!cfg.notify?.relay_webhook) return log('notify:', text.split('\n')[0]);
  await act(`notify: ${text.split('\n')[0]}`, async () => {
    const res = await fetch(cfg.notify.relay_webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(30000) });
    if (!res.ok) log('relay returned', res.status);
  });
}

// ---------- usage limit ----------
// While the account is over its Claude limit every agent call fails at once: no dispatch, resume, wake or triage until
// it resets, so nothing spends a restart or a wake on it. The owner hears once per limit window.
function agentsPausedUntil() {
  const l = readCache(cfg, 'limit.json', null);
  return l && new Date(l.until) > new Date() ? l.until : null;
}
async function noteLimit(untilMs, source) {
  const cur = readCache(cfg, 'limit.json', null);
  if (cur && new Date(cur.until).getTime() >= untilMs) return;
  const until = new Date(untilMs).toISOString();
  log(`Claude usage limit hit (${source}); agent work paused until ${until}`);
  if (DRY) return;
  writeCache(cfg, 'limit.json', { until, source, at: new Date().toISOString() });
  // A limit that keeps re-arming every LIMIT_RETRY_MINUTES is one outage: tell the owner when it starts, not on every retry.
  if (!cur || Date.now() - new Date(cur.until).getTime() > LIMIT_OUTAGE_GAP_MINUTES * 60000) {
    await notify(`Factory paused: Claude usage limit hit (${source}). No agent work until ${until.slice(11, 16)} UTC; it resumes by itself.`);
  }
}

// ---------- prompts ----------
// A merge conflict with the shared long-lived branch never resolves by retrying: two pieces edited the same lines. Hand
// it to a session in the package's worktree (merge the branch in, keep both sides' intent, run the checks, commit); after
// MERGE_RESOLVE_ATTEMPTS sessions that didn't clear it, tell the owner. Without this one conflict froze a whole
// branch-mode target silently for hours.
const MERGE_RESOLVE_ATTEMPTS = 2;
async function onLongBranchConflict(repo, pkg, st, branch, session, summary) {
  const mc = st.merge_conflict || { branch, since: new Date().toISOString(), attempts: 0, notified: false };
  if (mc.attempts >= MERGE_RESOLVE_ATTEMPTS) {
    if (!mc.notified) {
      addComment(repo, pkg.lead, `${QUESTION_MARK}\n${MENTION}merging \`${branch}\` into this package's work keeps conflicting: ${mc.attempts} resolver sessions didn't clear it, so the branch can't be pushed and the target is stalled since ${mc.since}. Worktree: \`${st.worktree}\`. Resolve it there (\`git fetch && git merge ${repo.remote}/${branch}\`, commit) or tell me how to proceed.`, 'merge conflict unresolved');
      await notify(`Factory: ${pkg.lead.key} can't merge ${branch} after ${mc.attempts} tries; the target is stalled. See the issue.`, pkg.lead.url);
      mc.notified = true;
      summary.parked.push(pkg.lead.key);
    }
  } else {
    mc.attempts += 1;
    const prompt = `${factoryRules(repo)}\n\nMerge conflict. This worktree's finished work can't be combined with the shared branch \`${branch}\`: \`git fetch ${repo.remote} && git merge --no-edit ${repo.remote}/${branch}\` conflicts, because another piece landed there meanwhile and edited the same lines. Resolve it: run that merge, read both sides' commits (\`git log --merge\`, \`git show\`) and the designs they cite, and combine them so both sides' intent survives (no side dropped, no logic duplicated). Then run the typecheck and the tests of the touched modules (and lint on the changed files), fix what the merge broke, and commit the merge with git's message plus one line naming the files you resolved. Don't push and don't open a PR: the tick pushes. If the two sides genuinely contradict each other, \`git merge --abort\` and ask on the issue per the issue flow instead. End with the last line \`FACTORY: merged ${branch}\`.`;
    act(`resolve the ${branch} merge conflict for ${pkg.lead.key} (attempt ${mc.attempts})`, () =>
      claudeBg({ repo, cwd: st.worktree, name: `merge-${path.basename(st.worktree)}`, prompt, resume: session?.id || undefined, model: workerModel(repo, st) }));
    st.launched_at = new Date().toISOString();
    summary.woke.push(pkg.lead.key);
  }
  st.merge_conflict = mc;
  writeState(repo, pkg.lead, st);
}
function factoryRules(repo) {
  return `Factory mode. Repo ${repo.github}, ship mode "${repo.ship}"${repo.ship_why ? ` (${repo.ship_why})` : ''}. Principles: ${repo.principles}. Issue flow: ${cfg.issues_doc}. Never use AskUserQuestion; escalate per the issue flow (a <!-- factory-question --> comment, the "${LABELS.needs_info.name}" label, parked_at in the state comment) and end the session. Before you end any turn that leaves the job waiting (on CI, a merge or ${OWNER}), rewrite \`${HANDOFF_FILE}\` in the worktree for a successor with no context, under ~150 lines, pointing to files rather than pasting them: the issues and scope, what's done, design and review-loop status, the PR, what's left in order, the exact next step, decisions taken and gotchas. The tick may continue the job in a fresh session from it.`;
}
function handOff(repo) {
  if (repo.ship === 'branch') return branchHandOff(repo);
  if (repo.land_on) return landOnHandOff(repo);
  return repo.ship === 'pr'
    ? `When the PR(s) are open, run /babysit-pr once on the top PR with "${babysitNote(repo)}" and end the session with the last line \`FACTORY: in review #<PR numbers>\`; the factory tick re-invokes babysit when the PR's signals change.`
    : `Ship per the repo's ship rule (land on ${repo.base}). Each commit that finishes an issue carries \`Fixes #<n>\`; close any issue the push did not close with \`gh issue close <n> -c "Shipped in <sha>."\`. Then end the session with the last line \`FACTORY: shipped <shas>\`.`;
}
// The target's fixes collect on another target's long-lived branch, tested together before they reach the base.
function landOnHandOff(repo) {
  const b = repo.land_on;
  return [
    `Collect mode: this target's work doesn't land on ${repo.base}. It collects on the shared branch \`${b}\` with the related fixes, tested together there, and reaches ${repo.base} with that branch's one PR.`,
    `Run the /factory loop as usual (triage, design, implement, review-loop, the repo's checks) on this worktree's own branch, with REVIEW_BASE=${repo.remote}/${repo.base}. Don't land it on ${repo.base}, don't push and don't open a PR.`,
    `Commit each finished issue on this worktree's branch with "Part of #<n>" (not "Fixes": it hasn't reached ${repo.base}) and the Decisions taken section in the commit message. Then close the issue with \`gh issue close <n> -c "Built at <sha>; the factory merges it into ${b}, which reaches ${repo.base} with that branch's PR."\`. The tick merges this branch into ${b} once every issue in the package is closed.`,
    'End the session with the last line `FACTORY: landed <shas>`.',
  ].join(' ');
}
// Branch mode: every issue of the target lands as reviewed commits on one long-lived branch in one shared worktree; the
// tick pushes it and opens the single PR once the target is done.
function branchHandOff(repo) {
  const b = repo.long_branch;
  return [
    `Branch mode: this worktree is the target's long-lived branch \`${b}\`, shared by its issues one after another. There is no PR per issue.`,
    `Before you start: \`git fetch ${repo.remote} && git merge --no-edit ${repo.remote}/${repo.base}\`, and \`git merge --no-edit ${repo.remote}/${b}\` when it exists (other targets' fixes merge into it) (merge, never rebase: the branch is pushed), fix any conflict, then \`git branch -f factory-piece-base HEAD\` so this issue's work is the diff from there.`,
    `Run the repo's /factory loop as usual (triage, implement, review-loop, the repo's checks), with two differences. Review only this issue's work: every review-loop round with REVIEW_BASE=factory-piece-base. Don't record a review gate (if the repo has one), don't push and don't open a PR: the tick pushes the branch after each package and opens the one PR when the target is done.`,
    `Commit each finished issue on this branch with "Part of #<n>" (not "Fixes": it hasn't reached ${repo.base}) and the Decisions taken section in the commit message. Then close the issue with \`gh issue close <n> -c "Landed on ${b} at <sha>; reaches ${repo.base} with the branch's PR."\`.`,
    'End the session with the last line `FACTORY: landed <shas>`.',
  ].join(' ');
}
// The project's flows and wireframes (factory-project writes them) live on this machine, outside the repo.
function designNote(target) {
  return target.design ? ` Project visuals (flows.html, wireframes.html): ${target.design.replace(/^~(?=\/)/, process.env.HOME)}.` : '';
}
// A stacked worker builds on a parent PR that is green but not merged. Its PR still targets the base, because CI runs
// only on PRs into it; the body says which PR merges first.
function stackNote(repo, on) {
  return ` This issue is stacked: it builds on ${repo.github}#${on.issue}, whose PR #${on.pr} is green but not merged yet. Your worktree starts from its branch \`${on.branch}\` (at ${on.head.slice(0, 12)}), so that code is already here: build only this issue's change on top of it. Open your PR with \`--base ${repo.base}\` (CI runs only on PRs into ${repo.base}) and start its body with "Stacked on #${on.pr}: merge #${on.pr} first. Until it merges, this diff also shows #${on.pr}'s changes." Review only your own change: run review-loop's rounds with REVIEW_BASE=${on.branch}, then its last round with REVIEW_BASE=${repo.base} so the whole branch has been reviewed once. A finding in #${on.pr}'s code is not yours to fix here: leave it as a comment on #${on.pr} and go on.`;
}
// What a stacked PR's babysit does when its parent moved. `built_on` is the parent head the branch was last built on.
function stackWakeNote(repo, on, parent) {
  if (!parent) return '';
  if (parent.mergedAt) return ` Its parent PR #${on.pr} has merged into ${repo.base} (squashed). Move this branch onto ${repo.base}: \`git fetch ${repo.remote} && git rebase --onto ${repo.remote}/${repo.base} ${on.built_on}\`, check \`git log --oneline ${repo.remote}/${repo.base}..HEAD\` shows only this issue's commits, remove the "Stacked on" line from the PR body, record a fresh review if the review gate asks for one, and push with --force-with-lease.`;
  if (parent.state !== 'OPEN') return ` Its parent PR #${on.pr} was closed without merging. If this change stands on its own, rebase it onto ${repo.base}; if it needs the parent's code, ask on the issue.`;
  if (parent.headRefOid !== on.built_on) return ` Its parent PR #${on.pr} has new commits (${on.built_on.slice(0, 12)} -> ${parent.headRefOid.slice(0, 12)}). Rebase onto them: \`git fetch ${repo.remote} && git rebase --onto ${repo.remote}/${on.branch} ${on.built_on}\`, check \`git log --oneline ${repo.remote}/${on.branch}..HEAD\` shows only this issue's commits, record a fresh review if the review gate asks for one, and push with --force-with-lease.`;
  return ` It is stacked on PR #${on.pr} (branch \`${on.branch}\`), still open and unchanged.`;
}
function babysitNote(repo) {
  const base = 'factory: one pass only, no loop and no ScheduleWakeup; fix what is red or conflicting, reply to new comments, then end the turn.';
  const win = repo?.merge_window;
  if (!win?.until || new Date(win.until) <= new Date()) return `${base} Never merge or approve.`;
  return `${base} Never approve. Merge window open until ${win.until} (${win.why}): you may merge THIS PR yourself with \`gh pr merge <n> --squash\` only when all of these hold: it is not a draft; review-loop is recorded for its final diff; it is up to date with ${repo.base} (fetch, rebase if behind, push, and wait for CI to finish again: another PR may have merged a conflicting change); every required check is green on that head, none pending; mergeStateStatus is CLEAN. Never merge: ${win.not}. After the merge, watch the workflow runs on that ${repo.base} push (deploys, migrations); if one fails, comment on the issue and mention ${OWNER}. If unsure whether a PR is excluded, don't merge it.`;
}

// ---------- the pass ----------
async function main() {
  acquireLock();
  const started = Date.now();
  const sessions = listSessions();
  if (sessions === null) {
    log('claude CLI is not reachable from this process (PATH?); refusing to dispatch, resume, wake or triage this tick');
    return;
  }
  const signalCache = readCache(cfg, 'signals.json', {});
  const notified = readCache(cfg, 'notified.json', {});
  const summary = { targets: {}, busy: 0, dispatched: [], woke: [], parked: [], resumed: [], triaged: [], done: [] };
  summary.busy = sessions.filter((s) => sessionBusy(s) && inWorktreesOf(cfg, s.cwd)).length;
  for (const s of sessions.filter((x) => inWorktreesOf(cfg, x.cwd))) {
    if (sessionBusy(s)) {
      if (sessionRateLimited(s)) await noteLimit(Date.now() + LIMIT_RETRY_MINUTES * 60000, `worker in ${path.basename(s.cwd)} retrying a 429`);
      continue;
    }
    const err = lastApiError(s);
    if (err?.limit && (err.resetsAt || 0) > Date.now()) await noteLimit(err.resetsAt, `worker in ${path.basename(s.cwd)}`);
  }
  const paused = () => agentsPausedUntil();
  if (paused()) log(`agent work paused until ${paused()} (usage limit)`);

  for (const repo of Object.values(cfg.repos)) {
    const targets = cfg.targets.filter((t) => t.repo === repo.name && (!ONLY || t.name === ONLY));
    if (!targets.length) continue;
    for (const t of targets.filter((x) => x.paused)) log(`target ${t.name}: paused`);
    const active = targets.filter((t) => !t.paused);
    if (!active.length) continue;

    if (DRY) vlog(`${repo.name}: label check skipped in a dry run`);
    else for (const l of ensureLabels(repo)) log(`${repo.name}: created label "${l}"`);
    const open = fetchRepoIssues(repo);
    const closed = fetchRepoIssues(repo, { closedSince: new Date(Date.now() - 7 * 864e5).toISOString() });
    const byNumber = new Map([...closed, ...open].map((i) => [i.number, i]));
    const prs = factoryPrs(repo);
    if (cfg.tick.sweep_agent_worktrees) sweepAgentWorktrees(repo);

    // A package is the lead issue's state comment; every member carries a copy naming the lead.
    const packages = new Map();
    for (const i of byNumber.values()) {
      const st = parseMarked(findMarked(i, STATE_MARK));
      if (!st?.lead || st.lead !== i.number) continue;
      packages.set(i.number, { lead: i, st, members: (st.package || [i.number]).map((n) => byNumber.get(n)).filter(Boolean) });
    }
    const memberOpen = (pkg) => pkg.members.filter((m) => m.state === 'OPEN');
    // An issue the owner moved to "later" has left the package: without this the tick takes its worker for a dead one and
    // restarts it.
    const memberLive = (pkg) => memberOpen(pkg).filter((m) => !hasLabel(m, LABELS.later.name));
    // A package is parked only once every issue still in it waits on the owner: a worker that parks one member of a
    // batch carries on with the others, and the tick must keep resuming it (one parked issue once held two others for 7 h).
    const pkgParked = (pkg) => { const live = memberLive(pkg); return live.length > 0 && live.every((m) => hasLabel(m, LABELS.needs_info.name)); };
    // A worker that handed every open issue to the owner (`factory: human`) is done, not dead: restarting it only costs
    // a session that finds nothing to do. The package waits until the owner closes the issues or relabels one ready.
    const pkgWithOwner = (pkg) => memberLive(pkg).every((m) => hasLabel(m, LABELS.human.name));

    // 1. Finished packages: every member closed or moved to later, and no PR open -> remove the session and the worktree.
    for (const pkg of packages.values()) {
      const { st } = pkg;
      if (!st.worktree || st.cleaned || memberLive(pkg).length) continue;
      // A branch-mode piece's other-repo PR (say, a CLI half) can wait on a release by the owner; holding the package for it
      // stalls the whole branch, since the next issue starts only once this one is pushed.
      const onBranch = cfg.targets.some((t) => t.name === st.target && (t.ship === 'branch' || t.land_on));
      const pkgPrs = packagePrs(repo, prs, st, byNumber).filter((p) => !onBranch || p.repo === repo.github);
      if (pkgPrs.some((p) => p.state === 'OPEN')) continue;
      const doneSession = sessionFor(sessions, st.worktree);
      const doneBusy = sessionBusy(doneSession);
      const doneQuiet = doneBusy ? sessionQuiet(doneSession) : null;
      if (doneBusy && !(doneQuiet && doneQuiet.minutes >= (doneQuiet.turnEnded ? DONE_QUIET_MINUTES : WEDGED_MINUTES))) continue;
      // A branch-mode package keeps its worktree (the next issue builds on it) and is pushed instead; a failed push
      // leaves the package unfinished so the next tick tries again.
      const branchTarget = cfg.targets.find((t) => t.name === st.target && t.ship === 'branch');
      const landOn = cfg.targets.find((t) => t.name === st.target)?.land_on;
      if (landOn && !branchTarget && st.worktree && fs.existsSync(st.worktree)) {
        try {
          mergeIntoLongBranch(repo, st.worktree, landOn);
        } catch (e) {
          log(`merge of ${pkg.lead.key} into ${landOn} failed, retrying next tick: ${String(e.message).split('\n')[0]}`);
          if (e.mergeConflict) await onLongBranchConflict(repo, pkg, st, landOn, doneSession, summary);
          continue;
        }
      }
      if (branchTarget) {
        try {
          pushLongBranch(repo, st.worktree, branchTarget.branch);
        } catch (e) {
          log(`push of ${branchTarget.branch} for ${pkg.lead.key} failed, retrying next tick: ${String(e.message).split('\n')[0]}`);
          if (e.mergeConflict) await onLongBranchConflict(repo, pkg, st, branchTarget.branch, doneSession, summary);
          continue;
        }
      }
      if (st.merge_conflict) delete st.merge_conflict;
      if (doneBusy) summary.busy--;
      if (doneSession?.id) act(`claude rm ${doneSession.id} (finished worker for ${pkg.lead.key})`, () => { try { sh('claude', ['rm', doneSession.id]); } catch {} });
      if (!branchTarget) removeWorktree(repo, st.worktree);
      for (const m of pkg.members) editIssue(repo, m, { remove: [LABELS.working.name, LABELS.in_review.name, LABELS.needs_info.name] }, m.state === 'OPEN' ? 'moved to later' : 'closed');
      st.cleaned = true;
      writeState(repo, pkg.lead, st);
      summary.done.push(pkg.lead.key);
    }

    const baseRepo = repo;
    for (const target of active) {
      const repo = forTarget(baseRepo, target);
      // A batch belongs to the target that names it: a labels-only target (e.g. any `factory: ready`) never takes a
      // sub-issue of another target's batch, or a branch-mode batch gets built as separate PRs behind its back.
      const ownedBatches = new Set(cfg.targets.filter((o) => o.repo === baseRepo.name && o.batch && o.name !== target.name).map((o) => o.batch));
      const issues = open.filter((i) => inTarget(target, i) && !isBatchParent(i) && !(!target.batch && ownedBatches.has(i.parent?.number)));
      const targetPkgs = [...packages.values()].filter((p) => p.st.target === target.name && !p.st.cleaned && memberLive(p).length);
      // Tracked in any repo that ships by PR or by push: a push repo's package can still have a PR (a PR in another
      // repo, a held change). A repo with no PRs never gets the label, so nothing changes there.
      const inReview = (pkg) => repo.ship !== 'branch' && memberOpen(pkg).some((m) => hasLabel(m, LABELS.in_review.name));
      const t = (summary.targets[target.name] = {
        repo: repo.name,
        untriaged: issues.filter((i) => !hasFactoryLabel(i) && !findMarked(i, TRIAGE_MARK) && !findMarked(i, STATE_MARK)).length,
        ready: issues.filter((i) => hasLabel(i, LABELS.ready.name)).length,
        working: targetPkgs.filter((p) => !inReview(p) && !pkgParked(p) && !pkgWithOwner(p)).length,
        in_review: targetPkgs.filter((p) => inReview(p) && !pkgParked(p)).length,
        parked: targetPkgs.filter(pkgParked).length,
      });
      log(`target ${target.name} (${repo.github}): ${JSON.stringify(t)}`);

      // 2. Parked issues: resume on a human reply, or notify once.
      for (const issue of open.filter((i) => hasLabel(i, LABELS.needs_info.name))) {
        const st = parseMarked(findMarked(issue, STATE_MARK));
        if (!st?.parked_at || st.target !== target.name) continue;
        const reply = humanCommentsAfter(issue, st.parked_at)[0];
        if (reply && paused()) continue;
        if (reply) {
          const s = sessionFor(sessions, st.worktree);
          const prompt = `${OWNER} answered on ${repo.github}#${issue.number}:\n\n"""\n${reply.body}\n"""\n\nContinue the work from that answer. Record it under Decisions taken. Do not ask again. ${factoryRules(repo)} ${handOff(repo)}`;
          act(`resume ${issue.key} with the owner's answer`, () =>
            claudeBg({ repo, cwd: st.worktree, prompt, resume: s?.sessionId || st.session || undefined, model: workerModel(repo, st) }),
          );
          editIssue(repo, issue, { add: [LABELS.working.name], remove: [LABELS.needs_info.name] }, 'answered');
          const launched = { launched_at: new Date().toISOString(), lease_until: new Date(Date.now() + cfg.workers.lease_minutes * 60000).toISOString() };
          Object.assign(st, launched, { parked_at: null, notified: null });
          writeState(repo, issue, st);
          // Step 3 reads the launch time from the package's own parsed copy: without this it would resume the same
          // worker a second time in this pass.
          const pkg = packages.get(st.lead);
          if (pkg && pkg.lead === issue) pkg.st = st;
          else if (pkg) {
            Object.assign(pkg.st, launched);
            writeState(repo, pkg.lead, pkg.st);
          }
          summary.resumed.push(issue.key);
        } else if (!st.notified) {
          const q = findMarked(issue, QUESTION_MARK);
          const excerpt = q ? q.body.replace(QUESTION_MARK, '').trim().slice(0, 600) : '(see the issue)';
          await notify(`Factory needs you: ${slackLink(issue.url, `${issue.key} ${issue.title}`)}\n\n${excerpt}\n\nReply with a comment on the issue.`, issue.url);
          st.notified = new Date().toISOString();
          writeState(repo, issue, st);
          summary.parked.push(issue.key);
        }
      }

      // 3. Working packages: a PR opened -> in review; dead session -> resume; too many restarts -> park.
      for (const pkg of targetPkgs.filter((p) => !inReview(p) && !pkgParked(p) && !pkgWithOwner(p))) {
        const { st, lead } = pkg;
        const s = sessionFor(sessions, st.worktree);
        const q = sessionBusy(s) ? sessionQuiet(s) : null;
        const quiet = q?.minutes ?? null;
        const wedged = quiet !== null && quiet >= WEDGED_MINUTES;
        const frozen = wedged && !q.turnEnded;
        if (sessionBusy(s) && !wedged) continue;
        const pkgPrs = packagePrs(repo, prs, st, byNumber);
        // A PR merged before the worker's latest launch is earlier work (the owner answered after it shipped): counting it would
        // move the package to review and step 4 would close it as shipped while the resumed worker is still building.
        const launchedAt = st.launched_at || st.started_at;
        const newWork = (p) => p.state === 'OPEN' || (p.mergedAt && (!launchedAt || new Date(p.mergedAt) > new Date(launchedAt)));
        if (repo.ship !== 'branch' && pkgPrs.some(newWork)) {
          for (const m of memberOpen(pkg)) editIssue(repo, m, { add: [LABELS.in_review.name], remove: [LABELS.working.name] }, 'PR exists');
          st.prs = pkgPrs.map((p) => (p.repo === repo.github ? p.number : prRef(repo, p)));
          writeState(repo, lead, st);
          continue;
        }
        // A worker whose process exited, or whose last turn was an API error, has stopped: resume it now. The lease only
        // covers a live, idle session, which may be waiting on its own subagents.
        const err = lastApiError(s);
        // A worker the context hook told to hand off ends its turn at a natural break: continue it in a fresh session now
        // rather than letting the idle session sit out its lease.
        const handedOff = !err && !wedged && sessionAlive(s) && endedWithHandoff(s);
        const stopped = !sessionAlive(s) || !!err || wedged || handedOff;
        if (!stopped && st.lease_until && new Date(st.lease_until) > new Date()) continue;
        if (minutesAgo(st.launched_at || st.started_at) < START_GRACE_MINUTES) continue;
        if (paused()) continue;
        // The usage limit is not the worker's fault, a handoff is the plan working, and a frozen request is the API's:
        // none spends the restart budget.
        const counts = !err?.limit && !handedOff && !frozen;
        const parkOn = memberOpen(pkg)[0];
        if (counts && (st.restarts || 0) >= cfg.workers.max_restarts) {
          addComment(repo, parkOn, `${QUESTION_MARK}\n${MENTION}the factory worker for ${(st.package || [st.lead]).map((n) => `#${n}`).join(' ')} stopped ${st.restarts} times without finishing. Worktree: \`${st.worktree}\`. Last session: ${st.session || 'unknown'}. Tell me how to proceed (retry, split, or drop).`, 'restart budget spent');
          editIssue(repo, parkOn, { add: [LABELS.needs_info.name] }, 'restart budget spent');
          const pst = parseMarked(findMarked(parkOn, STATE_MARK)) || { ...st };
          pst.parked_at = new Date().toISOString();
          writeState(repo, parkOn, pst);
          summary.parked.push(parkOn.key);
          continue;
        }
        const keys = (st.package || [st.lead]).map((n) => `#${n}`).join(' ');
        const why = handedOff
          ? `The previous session handed off at a natural break because its context grew large.`
          : frozen
          ? `The previous session froze mid-turn: nothing moved for ${Math.round(quiet)} minutes (a request that never returned, or subagents that died with it), so the tick stopped it. Check what any subagents it launched left in the worktree before relaunching them.`
          : wedged
          ? `The previous session ended its turn and then waited ${Math.round(quiet)} minutes on a background job that never reported, so the tick stopped it. Don't start another wait that can't end on its own.`
          : `The previous session ended before the work was ${repo.ship === 'pr' ? 'in a PR' : 'shipped'}.`;
        const prompt = `Continue /factory-auto for ${keys}. ${why} Read the factory state comment on each issue and the worktree's git log, finish the work. ${factoryRules(repo)} ${handOff(repo)}`;
        act(`resume ${handedOff ? 'handed-off' : frozen ? 'frozen' : wedged ? 'wedged' : stopped ? 'stopped' : 'idle'} worker for ${lead.key} (${counts ? `restart ${(st.restarts || 0) + 1}` : handedOff ? 'fresh session from its handoff, not counted' : frozen ? 'frozen mid-turn, not counted' : 'after the usage limit, not counted'})`, () =>
          claudeBg({ repo, cwd: st.worktree, prompt, resume: s?.sessionId || st.session || undefined, model: workerModel(repo, st) }),
        );
        if (counts) st.restarts = (st.restarts || 0) + 1;
        st.launched_at = new Date().toISOString();
        st.lease_until = new Date(Date.now() + cfg.workers.lease_minutes * 60000).toISOString();
        writeState(repo, lead, st);
        summary.resumed.push(lead.key);
      }

      // 4. In review (any package with a PR): wake one babysit pass when the PR signals changed or the heartbeat is due.
      if (repo.ship !== 'branch' && cfg.babysit?.enabled) {
        for (const pkg of targetPkgs.filter((p) => inReview(p) && !pkgParked(p))) {
          const { st, lead } = pkg;
          if (!st.worktree) continue;
          const s = sessionFor(sessions, st.worktree);
          const pkgPrs = packagePrs(repo, prs, st, byNumber);
          const openPrs = pkgPrs.filter((p) => p.state === 'OPEN');
          if (!openPrs.length) {
            // A merged PR closes the issues it names with a closing keyword. One still open after every PR merged may have
            // been only partly done ("one page first"), so the worker decides whether it is finished, not the tick.
            const merged = pkgPrs.filter((p) => p.mergedAt);
            if (!merged.length || merged.length !== pkgPrs.length || sessionBusy(s) || paused()) continue;
            const left = memberLive(pkg);
            if (!left.length) continue;
            const refs = merged.map((p) => prRef(repo, p)).join(', ');
            const prompt = `${OWNER} merged ${refs}, and ${left.map((m) => `${repo.github}#${m.number}`).join(', ')} ${left.length > 1 ? 'are' : 'is'} still open. For each, check the issue's scope and Verify list against what is merged on ${repo.base}. If it is all done, close it with \`gh issue close <n> -c "Shipped in <PRs>."\`. If work is left, build the next piece as a new PR from ${repo.base}. If the next step needs ${OWNER}, ask on the issue. ${factoryRules(repo)} ${handOff(repo)}`;
            act(`resume ${lead.key} after ${refs} merged (${left.length} still open)`, () =>
              claudeBg({ repo, cwd: st.worktree, prompt, resume: s?.sessionId || st.session || undefined, model: workerModel(repo, st) }),
            );
            for (const m of left) editIssue(repo, m, { add: [LABELS.working.name], remove: [LABELS.in_review.name] }, 'merged, checking what is left');
            st.launched_at = new Date().toISOString();
            st.lease_until = new Date(Date.now() + cfg.workers.lease_minutes * 60000).toISOString();
            writeState(repo, lead, st);
            summary.resumed.push(lead.key);
            continue;
          }
          let changed = false;
          const parts = [];
          const fresh = {};
          const views = [];
          // Own-repo PRs keep their old `<repo>#<n>` cache key, so this change re-notifies nothing.
          const cacheKey = (p) => (p.repo === repo.github ? `${repo.name}#${p.number}` : prRef(repo, p));
          for (const p of openPrs) {
            const { hash: h, view, wake } = prSignals(p.repo || repo.github, p.number);
            const key = cacheKey(p);
            fresh[key] = wake;
            parts.push(`${prRef(repo, p)}:${h}`);
            views.push({ pr: p, view });
            if (wakeWorthy(signalCache[key], wake)) changed = true;
            // The record is otherwise written only at a wake: seed it now, or a PR first seen here never wakes on a failure.
            if (!DRY && (!signalCache[key] || typeof signalCache[key] !== 'object')) signalCache[key] = wake;
          }
          // A stacked PR also wakes when its parent moves: new commits to follow, or a merge to rebase onto the base.
          const on = st.stack_on;
          const parent = on ? prs.find((p) => p.number === on.pr) : null;
          if (on && parent) {
            const key = `${repo.name}#${on.pr}:stack-of:${lead.number}`;
            const h = `${parent.state}:${parent.headRefOid}`;
            fresh[key] = h;
            parts.push(`parent ${prRef(repo, parent)}:${h}`);
            if (signalCache[key] !== h) changed = true;
          }
          // Green and mergeable is the end of the factory's part: the owner merges. Tell them once per head commit. A stacked PR
          // waits for its parent to merge first: until then it carries the parent's diff too.
          for (const { pr, view } of views) {
            const key = cacheKey(pr);
            if (!prIsGreen(view) || (parent && parent.state === 'OPEN')) continue;
            const head = view.headRefOid;
            if (notified[key] === head) continue;
            await notify(`Factory PR ready for you to merge: ${slackLink(view.url, `${prRef(repo, pr)} ${view.title}`)}`, view.url);
            if (!DRY) notified[key] = head;
          }
          if (sessionBusy(s) || paused()) continue;
          // A wake whose turn died on the usage limit never ran: wake again. Any other API error retries with backoff.
          const err = lastApiError(s);
          if (err?.limit) changed = true;
          const lastWake = st.last_babysit ? minutesAgo(st.last_babysit) : Infinity;
          // A PR that is red or conflicting gets retried even when nothing changed: the agent may have given up on a
          // failure that main has since fixed. Every quiet retry doubles the wait (1h, 2h, 4h), capped at the heartbeat.
          const maxWait = (cfg.babysit.heartbeat_hours || 6) * 60;
          const broken = !!err || views.some(({ view }) => ['DIRTY', 'BEHIND'].includes(view.mergeStateStatus) || checksOf(view).failing.length);
          const heartbeatDue = lastWake > (broken ? Math.min(60 * 2 ** (st.quiet_wakes || 0), maxWait) : maxWait);
          if (!changed && !heartbeatDue) continue;
          const top = openPrs[0];
          const seen = views.map(({ pr, view }) => `${prRef(repo, pr)} merge=${view.mergeStateStatus} review=${view.reviewDecision || 'none'} base=${view.baseRefName} failing=${checksOf(view).failing.join(',') || 'none'}`).join('; ');
          // A PR in another repo (a fix built from this worktree in a sibling repo) is babysat by URL, from that repo's own clone.
          const babysitArg = top.repo === repo.github ? String(top.number) : `${top.url}\n\nThis PR is in ${top.repo}, not ${repo.github}: babysit it from the ${top.repo} checkout you built it in, and push only to its branch there.`;
          act(`babysit ${lead.key} -> PR ${prRef(repo, top)} (${err?.limit ? 'last wake hit the usage limit' : changed ? 'signals changed' : broken ? `retry ${(st.quiet_wakes || 0) + 1} of a red or conflicting PR` : 'heartbeat'}; ${parts.join(' ')})`, () =>
            claudeBg({ repo, cwd: st.worktree, prompt: `/babysit-pr ${babysitArg} ${babysitNote(repo)}\n\nWhat the tick sees now: ${seen}. Conflicts or a base change come first: rebase, then judge CI again, since a failure can come from main.${on ? stackWakeNote(repo, on, parent) : ''} ${factoryRules(repo)}`, resume: s?.sessionId || st.session || undefined, model: workerModel(repo, st) }),
          );
          if (on && parent?.state === 'OPEN') st.stack_on = { ...on, built_on: parent.headRefOid };
          if (!DRY) Object.assign(signalCache, fresh);
          st.last_babysit = new Date().toISOString();
          st.quiet_wakes = changed ? 0 : (st.quiet_wakes || 0) + 1;
          st.prs = pkgPrs.map((p) => (p.repo === repo.github ? p.number : prRef(repo, p)));
          writeState(repo, lead, st);
          summary.woke.push(lead.key);
        }
      }

      // 5. Triage: issues in the target the factory has not looked at yet.
      if (cfg.triage?.enabled && !paused()) {
        const untriaged = issues
          .filter((i) => !hasFactoryLabel(i) && !findMarked(i, TRIAGE_MARK) && !findMarked(i, STATE_MARK))
          .sort((a, b) => priorityRank(a) - priorityRank(b) || new Date(a.createdAt) - new Date(b.createdAt))
          .slice(0, cfg.triage.max_per_tick || 20);
        const repoLabels = untriaged.length && !DRY ? new Set((shJson('gh', ['label', 'list', '-R', repo.github, '--limit', '300', '--json', 'name']) || []).map((l) => l.name)) : new Set();
        const verdicts = await mapLimit(untriaged, cfg.triage.parallel || 4, async (issue) => {
          const schema = {
            type: 'object',
            properties: {
              verdict: { type: 'string', enum: ['ready', 'split', 'decide', 'human', 'later'] },
              priority: { type: 'string', enum: ['medium', 'low'] },
              stream: { type: 'string' },
              kind: { type: 'string', enum: ['bug', 'feature', 'rollout', 'task', ''] },
              reason: { type: 'string' },
              verify_added: { type: 'boolean' },
            },
            required: ['verdict', 'priority', 'reason'],
            additionalProperties: false,
          };
          const prompt = `/factory-triage ${repo.github}#${issue.number}\n\nScope rule for this target: ${target.scope_rule}\nPrinciples file: ${repo.principles}\nIssue flow: ${cfg.issues_doc}\nShip mode: ${repo.ship}${designNote(target)}`;
          try {
            return DRY ? { verdict: 'ready', priority: 'medium', reason: 'dry run' } : await claudeJsonAsync({ repo, cwd: repo.path, prompt, model: cfg.triage.model, schema });
          } catch (e) {
            log(`triage failed for ${issue.key}: ${String(e.message).slice(0, 300)}`);
            return isLimitText(e.message) ? { limit: true } : null;
          }
        });
        if (verdicts.some((v) => v?.limit)) await noteLimit(Date.now() + LIMIT_RETRY_MINUTES * 60000, 'triage');
        for (const [idx, issue] of untriaged.entries()) {
          const verdict = verdicts[idx];
          if (!verdict || verdict.limit) continue;
          log(`triage ${issue.key}: ${verdict.verdict} ${verdict.priority} (${verdict.reason.slice(0, 120)})`);
          addComment(repo, issue, `${TRIAGE_MARK}\n**Factory triage:** \`${verdict.verdict}\`. ${verdict.reason}\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``, 'triage');
          const add = [verdict.verdict === 'ready' ? LABELS.ready.name : TRIAGE_LABEL[verdict.verdict]];
          // Only the owner sets priority: high; triage fills in a missing priority, stream or kind and never changes one.
          if (!issue.labels.some((l) => PRIORITY_LABELS[l])) add.push(`priority: ${verdict.priority}`);
          const stream = verdict.stream && `stream: ${verdict.stream.replace(/^stream:\s*/, '')}`;
          if (stream && !issue.labels.some((l) => l.startsWith('stream: ')) && repoLabels.has(stream)) add.push(stream);
          if (verdict.kind && !issue.labels.some((l) => ['bug', 'feature', 'rollout', 'task'].includes(l))) add.push(verdict.kind);
          editIssue(repo, issue, { add }, `triage ${verdict.verdict}`);
          summary.triaged.push(`${issue.key}:${verdict.verdict}`);
        }
      }

      // 6. Dispatch: ready issues -> packages -> workers, under the caps.
      // An in-review package holds no slot (the review cap limits what waits on the owner); nor does a parked one.
      const inFlight = targetPkgs.filter((p) => !inReview(p) && !pkgParked(p)).length;
      const awaitingReview = repo.ship === 'pr'
        ? new Set(targetPkgs.flatMap((k) => packagePrs(repo, prs, k.st, byNumber).filter((p) => p.state === 'OPEN').map((p) => p.url))).size
        : 0;
      const reviewCapHit = awaitingReview >= (target.max_awaiting_review ?? Infinity);
      if (reviewCapHit) log(`target ${target.name}: ${awaitingReview} PRs await ${OWNER} (cap ${target.max_awaiting_review}); starting nothing new`);
      let free = reviewCapHit ? 0 : Math.min(cfg.workers.max_concurrent - summary.busy - summary.dispatched.length, (target.max_in_flight || 99) - inFlight);
      // A branch target builds one issue at a time in its one worktree: the next starts only once the last is pushed.
      const branchHeld = repo.ship === 'branch' && [...packages.values()].some((p) => p.st.target === target.name && p.st.worktree && !p.st.cleaned);
      if (repo.ship === 'branch') free = branchHeld ? 0 : Math.min(free, 1);
      // A stack target starts an issue whose one open blocker has a single open PR that is green: on top of that PR's
      // branch, so a chain of PRs builds without waiting for each merge. Issues with no blocker between them run in parallel.
      const stackFor = new Map();
      const stackParent = (n) => {
        const b = byNumber.get(n);
        if (!b) return null;
        const bst = parseMarked(findMarked(b, STATE_MARK));
        const bpkg = bst?.lead ? packages.get(bst.lead) : null;
        const closing = b.prs.filter((p) => p.state === 'OPEN' && p.repo === repo.github);
        const open = closing.length ? closing : bpkg ? packagePrs(repo, prs, bpkg.st, byNumber).filter((p) => p.state === 'OPEN' && p.repo === repo.github) : [];
        if (open.length !== 1) return null;
        const { view } = prSignals(repo.github, open[0].number);
        if (!prIsGreen(view, { ran: true })) return null;
        return { issue: n, pr: open[0].number, branch: open[0].headRefName, head: view.headRefOid, built_on: view.headRefOid };
      };
      const ready = issues
        .filter((i) => {
          if (!hasLabel(i, LABELS.ready.name) || hasLabel(i, LABELS.needs_info.name) || hasLabel(i, LABELS.working.name)) return false;
          const st = parseMarked(findMarked(i, STATE_MARK));
          // Cleanup marks only the lead's copy, so a member reopened after its package finished reads the lead's. A lead
          // missing from the fetch closed more than a week ago, so its package is finished too.
          const own = !st?.lead || st.lead === i.number;
          const leadPkg = own ? null : packages.get(st.lead);
          const finished = !st || (own ? !!st.cleaned : !leadPkg || !!leadPkg.st.cleaned);
          if (!finished) return false;
          const blockers = blockedByOpen(i);
          if (!blockers.length) return true;
          const on = target.stack && blockers.length === 1 ? stackParent(blockers[0]) : null;
          if (on) {
            vlog(`${i.key} stacks on #${on.pr} (${on.branch}), which is green`);
            stackFor.set(i.number, on);
            return true;
          }
          vlog(`${i.key} waits on ${blockers.map((n) => `#${n}`).join(', ')}`);
          return false;
        })
        .sort((a, b) => priorityRank(a) - priorityRank(b) || new Date(a.createdAt) - new Date(b.createdAt));
      if (free > 0 && ready.length && !paused()) {
        // A stacked issue is its own package: its worktree starts from its parent's branch.
        const stacked = ready.filter((i) => stackFor.has(i.number));
        const plain = ready.filter((i) => !stackFor.has(i.number));
        let packagesToStart = ready.map((i) => [i]);
        // Branch-mode targets batch too: a long-lived branch gets one worker at a time, so each issue run alone paid its own
        // triage, design and review loop. Once, eleven review follow-ups on one branch queued as eleven ~2h pieces, most of
        // them on the same read layer or merge rule.
        if (cfg.planner?.enabled && plain.length >= 2) {
          const schema = {
            type: 'object',
            properties: {
              packages: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { issues: { type: 'array', items: { type: 'integer' } }, reason: { type: 'string' } },
                  required: ['issues', 'reason'],
                  additionalProperties: false,
                },
              },
            },
            required: ['packages'],
            additionalProperties: false,
          };
          const listing = plain.map((i) => `- #${i.number} [${i.labels.filter((l) => !l.startsWith('factory: ')).join(', ')}]${i.parent ? ` (sub-issue of #${i.parent.number})` : ''} ${i.title}\n  ${i.body.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
          const prompt = `/factory-plan\n\nRepo ${repo.github}, ship mode "${repo.ship}". Group these ready issues into work packages (max ${cfg.planner.max_package} per package, in build order). Issues:\n${listing}`;
          try {
            const plan = DRY ? { packages: plain.map((i) => ({ issues: [i.number], reason: 'dry run' })) } : await claudeJsonAsync({ repo, cwd: repo.path, prompt, model: cfg.planner.model, schema });
            const seen = new Set();
            packagesToStart = stacked.map((i) => [i]);
            for (const p of plan.packages || []) {
              const members = p.issues.map((n) => plain.find((i) => i.number === n)).filter((i) => i && !seen.has(i.number)).slice(0, cfg.planner.max_package);
              if (!members.length) continue;
              members.forEach((i) => seen.add(i.number));
              packagesToStart.push(members);
              vlog(`package ${members.map((m) => `#${m.number}`).join('+')}: ${p.reason}`);
            }
            for (const i of plain) if (!seen.has(i.number)) packagesToStart.push([i]);
          } catch (e) {
            log(`planner failed, dispatching singles: ${String(e.message).slice(0, 300)}`);
            if (isLimitText(e.message)) {
              await noteLimit(Date.now() + LIMIT_RETRY_MINUTES * 60000, 'planner');
              continue;
            }
          }
        }
        for (const pkg of packagesToStart) {
          if (free <= 0) break;
          const lead = pkg[0];
          const nums = pkg.map((i) => i.number);
          const keys = nums.map((n) => `${repo.github}#${n}`);
          const on = stackFor.get(lead.number) || null;
          const { wt, branch } = repo.ship === 'branch' ? ensureBranchWorktree(repo) : ensureWorktree(repo, lead.number, on?.branch);
          const prompt = `/factory-auto ${keys.join(' ')}\n\n${factoryRules(repo)} Work package in build order: ${keys.join(' -> ')}. Keep the factory state comment on each issue current (prs, parked_at).${designNote(target)}${on ? stackNote(repo, on) : ''} ${handOff(repo)}`;
          let out = '';
          // A worker already alive here means an earlier pass dispatched it and then died before the claim below landed
          // (a GitHub rate limit between the two): adopt it and finish the claim, never start a second one.
          const running = sessionFor(listSessions() || [], wt);
          if (sessionAlive(running)) {
            log(`worker already running in ${wt} (${running.id}); finishing its claim instead of dispatching again`);
            out = running.sessionId || '';
          } else try {
            out = act(`dispatch worker for ${pkg.map((i) => i.key).join('+')} in ${wt} (${workerModel(repo)})`, () => claudeBg({ repo, cwd: wt, name: `${repo.name}-${lead.number}`, prompt, model: workerModel(repo) })) || '';
          } catch (e) {
            log(`dispatch failed for ${pkg.map((i) => i.key).join('+')}: ${String(e.message).slice(0, 300)}`);
            continue;
          }
          const sessionId = (out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [null])[0]
            || sessionFor(listSessions() || [], wt)?.sessionId || null;
          const state = {
            repo: repo.github, package: nums, lead: lead.number, worktree: wt, branch, session: sessionId, session_hint: out.split('\n')[1] || out.slice(0, 120),
            started_at: new Date().toISOString(), launched_at: new Date().toISOString(), lease_until: new Date(Date.now() + cfg.workers.lease_minutes * 60000).toISOString(),
            restarts: 0, prs: [], parked_at: null, notified: null, target: target.name, model: workerModel(repo), effort: effortOf(repo),
            ...(on ? { stack_on: on } : {}),
          };
          for (const issue of pkg) {
            editIssue(repo, issue, { add: [LABELS.working.name], remove: [LABELS.ready.name], assignMe: !issue.assignees.length }, 'claimed by the factory');
            writeState(repo, issue, { ...state });
          }
          summary.dispatched.push(pkg.map((i) => i.key).join('+'));
          free -= 1;
        }
      }

      // 7. A branch target with nothing left to build (every open issue moved to later, no package unfinished) gets its
      // one PR: each commit was reviewed and passed the repo's checks on its own, so the owner merges once CI is green. With
      // `pr_early`, the PR opens between packages as soon as the branch has work, and later packages grow it (or open a
      // fresh one once the owner merged it), so landed work reaches main without waiting for the whole batch.
      const branchDone = target.pr_early || issues.every((i) => hasLabel(i, LABELS.later.name));
      if (repo.ship === 'branch' && !branchHeld && branchDone) await openBranchPr(repo, target, summary);
    }
  }

  if (!DRY) {
    writeCache(cfg, 'signals.json', signalCache);
    writeCache(cfg, 'notified.json', notified);
  }
  const status = {
    updated_at: new Date().toISOString(), took_s: Math.round((Date.now() - started) / 1000), busy: summary.busy,
    targets: summary.targets, dispatched: summary.dispatched, woke: summary.woke, resumed: summary.resumed, parked: summary.parked, triaged: summary.triaged, cleaned: summary.done,
  };
  if (!DRY) writeCache(cfg, 'last-tick.json', status);
  fs.writeFileSync(cachePath(DRY ? 'status.dry.md' : 'status.md'), [
    `# Factory status${DRY ? ' (dry run)' : ''}`, ``, `Updated ${status.updated_at} · tick took ${status.took_s}s · busy workers ${summary.busy}`, ``,
    `| target | repo | untriaged | ready | working | in review | parked |`, `|---|---|---|---|---|---|---|`,
    ...Object.entries(summary.targets).map(([n, t]) => `| ${n} | ${t.repo} | ${t.untriaged} | ${t.ready} | ${t.working} | ${t.in_review} | ${t.parked} |`), ``,
    `- dispatched: ${summary.dispatched.join(', ') || '-'}`, `- babysit woke: ${summary.woke.join(', ') || '-'}`, `- resumed: ${summary.resumed.join(', ') || '-'}`,
    `- parked (needs ${OWNER}): ${summary.parked.join(', ') || '-'}`, `- agent work paused until: ${paused() || '-'}`, `- triaged: ${summary.triaged.join(', ') || '-'}`, `- cleaned up: ${summary.done.join(', ') || '-'}`,
  ].join('\n') + '\n');
  log(`tick done in ${status.took_s}s: dispatched=${summary.dispatched.length} woke=${summary.woke.length} resumed=${summary.resumed.length} parked=${summary.parked.length} triaged=${summary.triaged.length}`);
}

main().catch((e) => {
  log('tick failed:', e.stack || e.message);
  process.exit(1);
});
