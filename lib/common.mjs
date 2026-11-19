// Shared helpers for the factory tick and dashboard. No third-party deps.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const STATE_MARK = '<!-- factory-state -->';
export const TRIAGE_MARK = '<!-- factory-triage -->';
export const QUESTION_MARK = '<!-- factory-question -->';
export const NOTE_MARK = '<!-- factory-note -->';

// The factory's lifecycle on GitHub is labels; ~/.claude/factory/issues.md §5 is the human-facing table.
export const LABELS = {
  ready: { name: 'factory: ready', color: '0e8a16', description: 'Cleared for the factory to build' },
  working: { name: 'factory: working', color: '1d76db', description: 'A factory worker has claimed it' },
  in_review: { name: 'factory: in review', color: '5319e7', description: 'Its factory PR is open' },
  needs_info: { name: 'factory: needs info', color: 'd93f0b', description: 'Parked on a question for a human; answer with a comment' },
  decide: { name: 'factory: decide', color: 'fbca04', description: 'A product fork for a human; options in a comment' },
  split: { name: 'factory: split', color: 'c5def5', description: 'Split into a batch by factory triage' },
  human: { name: 'factory: human', color: 'f9d0c4', description: 'Needs a step only a human can do' },
  later: { name: 'factory: later', color: 'ededed', description: 'Outside the factory target scope' },
};
export const TRIAGE_LABEL = { decide: LABELS.decide.name, split: LABELS.split.name, human: LABELS.human.name, later: LABELS.later.name };
export const PRIORITY_LABELS = { 'priority: high': 1, 'priority: medium': 2, 'priority: low': 3 };

// Paths in factory.json may start with `~`; a relative path is relative to the factory checkout.
export function expandPath(p) {
  if (!p) return p;
  if (p === '~' || p.startsWith('~/')) return path.join(process.env.HOME, p.slice(1));
  return path.resolve(ROOT, p);
}
export function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'factory.json'), 'utf8'));
  loadEnv(path.join(ROOT, '.env'));
  cfg.owner = { name: 'the owner', ...(cfg.owner || {}) };
  cfg.issues_doc = expandPath(cfg.issues_doc || 'issues.md');
  cfg.tick = { lock_stale_minutes: 30, ...(cfg.tick || {}) };
  cfg.tick.state_dir = expandPath(cfg.tick.state_dir || 'state');
  cfg.workers.settings = expandPath(cfg.workers.settings || 'worker-settings.json');
  for (const [name, repo] of Object.entries(cfg.repos)) {
    repo.name = name;
    repo.remote ||= 'origin';
    repo.base ||= 'main';
    repo.branch_prefix ||= 'factory/';
    repo.path = expandPath(repo.path);
    repo.worktrees_dir = expandPath(repo.worktrees_dir || path.join(repo.path, '.claude', 'worktrees'));
    repo.principles = expandPath(repo.principles || `principles/${name}.md`);
  }
  for (const t of cfg.targets) {
    if (!cfg.repos[t.repo]) throw new Error(`target ${t.name}: repo "${t.repo}" is not in factory.json repos`);
  }
  fs.mkdirSync(cfg.tick.state_dir, { recursive: true });
  return cfg;
}
export function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!(k in process.env)) process.env[k] = v;
  }
}
// A call that hangs (gh on a connection dropped while the Mac slept) must fail this tick, not freeze the loop:
// launchd starts no new tick while one is still running.
export function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 120000, ...opts });
}
export function shJson(cmd, args, opts = {}) {
  const out = sh(cmd, args, opts);
  return out.trim() ? JSON.parse(out) : null;
}
export function hash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}
export function minutesAgo(iso) {
  return (Date.now() - new Date(iso).getTime()) / 60000;
}
export function issueKey(repo, n) {
  return `${repo.name}#${n}`;
}

// ---------- GitHub issues ----------
export function graphql(query, variables = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(variables)) {
    if (v === null || v === undefined) continue;
    args.push(typeof v === 'string' ? '-f' : '-F', `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  const res = shJson('gh', args);
  if (res.errors) throw new Error('GitHub: ' + JSON.stringify(res.errors).slice(0, 1000));
  return res.data;
}

const ISSUE_FIELDS = `
  id databaseId number title body url state stateReason createdAt updatedAt closedAt
  labels(first: 30) { nodes { name } }
  assignees(first: 5) { nodes { login } }
  parent { number state }
  subIssues(first: 50) { nodes { number state } }
  blockedBy(first: 20) { nodes { number state } }
  comments(first: 100) { nodes { id databaseId body createdAt author { login } } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number state mergedAt headRefName baseRefName url title repository { nameWithOwner } } }
`;

function normalizeIssue(repo, n) {
  return {
    id: n.id, databaseId: n.databaseId, number: n.number, key: issueKey(repo, n.number), title: n.title, body: n.body || '', url: n.url,
    state: n.state, stateReason: n.stateReason, createdAt: n.createdAt, updatedAt: n.updatedAt, closedAt: n.closedAt,
    labels: n.labels.nodes.map((l) => l.name), assignees: n.assignees.nodes.map((a) => a.login),
    parent: n.parent, subIssues: n.subIssues.nodes, blockedBy: n.blockedBy.nodes,
    comments: n.comments.nodes.map((c) => ({ id: c.databaseId, body: c.body, createdAt: c.createdAt, author: c.author?.login || null })),
    // A PR in another repo can close this issue (a CLI-repo PR closing an app-repo issue): the worker built it from
    // here, so the package owns it and the tick babysits it in its own repo.
    prs: n.closedByPullRequestsReferences.nodes.map(({ repository, ...p }) => ({ ...p, repo: repository.nameWithOwner })),
  };
}

// Open issues, or issues closed since `closedSince` (ISO). One paginated query per call.
export function fetchRepoIssues(repo, { closedSince } = {}) {
  const [owner, name] = repo.github.split('/');
  const states = closedSince ? 'CLOSED' : 'OPEN';
  const out = [];
  let after = null;
  for (;;) {
    const data = graphql(`query($owner: String!, $name: String!, $after: String, $since: DateTime) {
      repository(owner: $owner, name: $name) {
        issues(states: [${states}], first: 50, after: $after, filterBy: { since: $since }, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor }
        }
      }
    }`, { owner, name, after, since: closedSince || null });
    const page = data.repository.issues;
    out.push(...page.nodes.map((n) => normalizeIssue(repo, n)));
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return closedSince ? out.filter((i) => i.closedAt && i.closedAt >= closedSince) : out;
}

// A target selects issues by a batch parent (its sub-issues), by labels (all must be present), or both.
export function inTarget(target, issue) {
  if (target.batch && issue.parent?.number !== target.batch) return false;
  if ((target.exclude_labels || []).some((l) => issue.labels.includes(l))) return false;
  return (target.labels || []).every((l) => issue.labels.includes(l));
}
export function isBatchParent(issue) {
  return issue.labels.includes('batch');
}
export function hasLabel(issue, name) {
  return issue.labels.includes(name);
}
export function hasFactoryLabel(issue) {
  return issue.labels.some((l) => l.startsWith('factory: '));
}
export function priorityRank(issue) {
  return Math.min(4.5, ...issue.labels.map((l) => PRIORITY_LABELS[l] || 4.5));
}
export function blockedByOpen(issue) {
  return issue.blockedBy.filter((b) => b.state === 'OPEN').map((b) => b.number);
}
export function findMarked(issue, mark) {
  return issue.comments.find((c) => c.body.trimStart().startsWith(mark));
}
export function parseMarked(comment) {
  if (!comment) return null;
  const m = comment.body.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
// A human's comment is any comment without a factory marker (agents write every factory comment behind one).
export function humanCommentsAfter(issue, iso) {
  return issue.comments
    .filter((c) => new Date(c.createdAt) > new Date(iso) && !c.body.trimStart().startsWith('<!--'))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

export function ensureLabels(repo) {
  const have = new Set((shJson('gh', ['label', 'list', '-R', repo.github, '--limit', '300', '--json', 'name']) || []).map((l) => l.name));
  const missing = Object.values(LABELS).filter((l) => !have.has(l.name));
  for (const l of missing) sh('gh', ['label', 'create', l.name, '-R', repo.github, '--color', l.color, '--description', l.description]);
  return missing.map((l) => l.name);
}

// ---------- GitHub PRs ----------
// How a PR is named in logs, state and messages: `#123` in the factory repo, `acme/cli#45` in another. Also the
// key of the signal and notify caches, so two repos' PR #45 never share one.
export function prRef(repo, p) {
  return !p.repo || p.repo === repo.github ? `#${p.number}` : `${p.repo}#${p.number}`;
}
// Workers name every branch after the package lead: factory/123, factory/123-player (prefix `factory/`).
export function leadOfBranch(repo, branch) {
  if (!branch?.startsWith(repo.branch_prefix)) return null;
  const m = branch.slice(repo.branch_prefix.length).match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}
const PR_FIELDS = 'number,title,body,state,isDraft,headRefName,headRefOid,baseRefName,mergedAt,url,createdAt,reviewDecision';
// Every factory PR in the repo, newest first: the branch prefix is what makes a PR the factory's.
export function factoryPrs(repo) {
  return (shJson('gh', [
    'pr', 'list', '--repo', repo.github, '--author', '@me', '--state', 'all', '--limit', '200',
    '--search', `head:${repo.branch_prefix}`, '--json', PR_FIELDS,
  ]) || []).filter((p) => p.headRefName.startsWith(repo.branch_prefix)).map((p) => ({ ...p, repo: repo.github }));
}
// A state entry is a bare number for the package's own repo, or a prRef (`acme/cli#45`) for another.
export function parseListedPr(repo, entry) {
  if (typeof entry === 'number') return { repo: repo.github, number: entry };
  const m = String(entry).match(/^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/);
  return m ? { repo: m[1] || repo.github, number: Number(m[2]) } : null;
}
// One tick asks for the same package's PRs several times; fetch a listed PR once.
const listedPrCache = new Map();
function listedPr({ repo, number }) {
  const key = `${repo}#${number}`;
  if (!listedPrCache.has(key)) {
    let p = null;
    try { p = shJson('gh', ['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS]); } catch { p = null; }
    listedPrCache.set(key, p && { ...p, repo });
  }
  return listedPrCache.get(key);
}
// A package owns a PR on a branch named after its lead, one that closes any of its issues, or one its state lists: a
// worker can open a PR from a branch of its own choosing that closes nothing (a hold PR, one part of a larger issue).
export function packagePrs(repo, prs, st, issuesByNumber) {
  const lead = st.lead;
  const own = prs.filter((p) => leadOfBranch(repo, p.headRefName) === lead);
  const add = (p) => { if (p && !own.some((o) => o.url === p.url)) own.push(p); };
  for (const n of st.package || [lead]) for (const p of issuesByNumber.get(n)?.prs || []) add(p);
  for (const ref of (st.prs || []).map((e) => parseListedPr(repo, e)).filter(Boolean)) {
    add(prs.find((p) => p.repo === ref.repo && p.number === ref.number) || listedPr(ref));
  }
  return own;
}
export function prSignals(github, number) {
  const v = shJson('gh', [
    'pr', 'view', String(number), '--repo', github, '--json',
    'state,isDraft,mergeable,mergeStateStatus,headRefOid,reviewDecision,statusCheckRollup,comments,reviews,labels,baseRefName,reviewRequests,url,title',
  ]);
  const checks = Object.fromEntries((v.statusCheckRollup || []).map((c) => [c.name || c.context, c.conclusion || c.state || c.status]));
  const sig = {
    state: v.state, head: v.headRefOid, merge: v.mergeStateStatus, review: v.reviewDecision, base: v.baseRefName, checks,
    comments: (v.comments || []).length, reviews: (v.reviews || []).length, labels: (v.labels || []).map((l) => l.name).sort(),
    requests: (v.reviewRequests || []).length,
  };
  return { view: v, sig, hash: hash(sig), wake: wakeSig(v) };
}
// What a babysit wake can act on, recorded at each wake and compared on the next tick. A check going from queued to
// running, a green-or-pending flip, the PR's own head moving or a transient merge state is not worth a wake: 90 of 108
// wakes in one stretch did nothing, each on a ~580k-token context.
function wakeSig(v) {
  const merge = ['DIRTY', 'BEHIND'].includes(v.mergeStateStatus) ? v.mergeStateStatus : 'ok';
  return {
    state: v.state, head: v.headRefOid, base: v.baseRefName, merge, review: v.reviewDecision || null,
    failing: checksOf(v).failing.sort(), comments: (v.comments || []).length, reviews: (v.reviews || []).length,
    requests: (v.reviewRequests || []).length,
  };
}
// A wake is worth it when something new needs the worker: a check failed that hadn't failed on this head, a conflict or
// a behind-base appeared, the PR's state, base or review decision changed, or a person commented, reviewed or asked.
// A cache entry from before this shape (a bare hash) only seeds the record: it wakes nothing.
export function wakeWorthy(prev, now) {
  if (!prev || typeof prev !== 'object') return false;
  const before = new Set(prev.head === now.head ? prev.failing : []);
  if (now.failing.some((c) => !before.has(c))) return true;
  if (now.merge !== 'ok' && now.merge !== prev.merge) return true;
  if (now.state !== prev.state || now.base !== prev.base || now.review !== prev.review) return true;
  return now.comments > prev.comments || now.reviews > prev.reviews || now.requests > prev.requests;
}
export const FAILED_CHECK = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED'];
export const PASSED_CHECK = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];
export function checksOf(view) {
  const all = (view.statusCheckRollup || []).map((c) => ({ name: c.name || c.context, result: c.conclusion || c.state || c.status }));
  return {
    all,
    failing: all.filter((c) => FAILED_CHECK.includes(c.result)).map((c) => c.name),
    pending: all.filter((c) => !FAILED_CHECK.includes(c.result) && !PASSED_CHECK.includes(c.result)).map((c) => c.name),
  };
}

// Green and mergeable: the owner's merge cue. `ran` also requires that checks exist, because a PR pushed seconds ago has none
// yet and would read as green; a stacked issue starts only on a PR whose CI actually passed.
export function prIsGreen(view, { ran = false } = {}) {
  const c = checksOf(view);
  if (ran && !c.all.length) return false;
  return !view.isDraft && !c.failing.length && !c.pending.length && ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(view.mergeStateStatus);
}

// ---------- Claude sessions ----------
// Returns null (not []) when the claude CLI cannot be run: callers must not treat that as "no sessions".
export function listSessions() {
  try {
    return shJson('claude', ['agents', '--json', '--all']) || [];
  } catch {
    return null;
  }
}
export function sessionFor(sessions, worktree) {
  const matches = sessions.filter((s) => s.cwd === worktree);
  matches.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return matches[0] || null;
}
export function sessionBusy(s) {
  if (!s) return false;
  // A live background session keeps state "working" after its turn ends; status says whether a turn is running.
  if (s.status) return s.status === 'busy';
  return ['running', 'working', 'busy'].includes(s.state);
}
// `claude agents` lists a pid only while the process runs; a session that exited keeps its last state ("blocked").
export function sessionAlive(s) {
  if (!s?.pid) return false;
  try {
    process.kill(s.pid, 0);
    return true;
  } catch {
    return false;
  }
}
export function inWorktreesOf(cfg, cwd) {
  return !!cwd && Object.values(cfg.repos).some((r) => cwd.startsWith(r.worktrees_dir + path.sep));
}
// A running worker whose context passes this is asked to hand off at its next natural break. It is well above where a
// piece usually ends: each fresh session starts ~80k deep (instructions, skill list) and re-reads its files, so at 200k
// a piece took 4 sessions and 56M tokens against 1 session and 33M with no mid-run cap,
// whose sessions peaked at a median 271k and passed 500k only 13% of the time. This catches only those runaways.
export const HANDOFF_CONTEXT_TOKENS = 500000;
// After the first ask, the hook asks again each time the context grows this much more.
export const HANDOFF_RENUDGE_TOKENS = 100000;
// A wake (a babysit, an answer from the owner) on an idle conversation this big starts fresh from the worker's handoff
// instead of resuming it: such wakes are mostly short, so re-reading a big context on each of their turns is the waste.
export const WAKE_FRESH_TOKENS = 200000;
export const HANDOFF_FILE = path.join('.context', 'handoff.md');
export const HANDOFF_LINE = 'FACTORY: handoff';
export function sessionTranscript(cwd, sessionId) {
  return path.join(process.env.HOME, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}
function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').split('\n');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
// The context the session's latest main-thread turn was sent with, in tokens (0 when unknown).
export function contextTokens(transcriptFile) {
  const lines = readTail(transcriptFile, 4 * 1024 * 1024) || [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    try {
      const d = JSON.parse(lines[i]);
      const u = d.message?.usage;
      if (u && !d.isSidechain) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    } catch { /* torn first line of the tail */ }
  }
  return 0;
}
// The session's last assistant message, when it is an API error (a usage limit, an overload): the turn never ran.
// Returns { limit, resetsAt (ms), text } or null.
function transcriptPath(s) {
  return sessionTranscript(s.cwd, s.sessionId);
}
function transcriptTail(s) {
  if (!s?.sessionId || !s.cwd) return null;
  return readTail(transcriptPath(s), 256 * 1024);
}
export function lastApiError(s) {
  const tail = transcriptTail(s);
  if (!tail) return null;
  for (let i = tail.length - 1; i >= 0; i--) {
    let d;
    try { d = JSON.parse(tail[i]); } catch { continue; }
    if (d.type !== 'assistant' || d.isSidechain) continue;
    if (!d.isApiErrorMessage) return null;
    const resetsAt = d.quotaLimits?.resetsAt || d.apiErrorParams?.rate_limit_info?.resetsAt;
    const text = (d.message?.content || []).map((c) => c.text || '').join(' ');
    return { limit: d.apiError === 'usage_limit_reached' || isLimitText(text), resetsAt: resetsAt ? resetsAt * 1000 : null, text };
  }
  return null;
}
// The session's last main-thread assistant text ends with HANDOFF_LINE: it stopped so a fresh session can continue.
export function endedWithHandoff(s) {
  return tailEndsWithHandoff(transcriptTail(s));
}
export function transcriptEndsWithHandoff(file) {
  return tailEndsWithHandoff(readTail(file, 256 * 1024));
}
function tailEndsWithHandoff(tail) {
  if (!tail) return false;
  for (let i = tail.length - 1; i >= 0; i--) {
    let d;
    try { d = JSON.parse(tail[i]); } catch { continue; }
    if (d.isSidechain || d.type !== 'assistant') continue;
    const text = (d.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    if (!text) continue;
    return text.split('\n').pop().trim() === HANDOFF_LINE;
  }
  return false;
}
// Minutes since anything of the session last moved (its transcript's newest entry, subagents, task output, job dir),
// and whether its last turn ended. A turn that ended while the session still reports busy is held only by its own
// background jobs; a turn still running with nothing moving is frozen on a request that never returned. The transcript
// counts by its entries' timestamps, not its mtime: a frozen session's file was seen touched with no new entry.
export function sessionQuiet(s) {
  const tail = transcriptTail(s);
  if (!tail) return null;
  let turnEnded = false;
  for (let i = tail.length - 1; i >= 0; i--) {
    let d;
    try { d = JSON.parse(tail[i]); } catch { continue; }
    if (d.isSidechain) continue;
    if (d.type === 'system' && d.subtype === 'turn_duration') { turnEnded = true; break; }
    if (d.type === 'user' || d.type === 'assistant') break;
  }
  let newest = 0;
  for (let i = tail.length - 1; i >= 0 && !newest; i--) {
    const m = tail[i].match(/"timestamp":"([^"]+)"/);
    if (m) newest = Date.parse(m[1]) || 0;
  }
  const dir = s.cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const roots = [
    path.join(process.env.HOME, '.claude', 'projects', dir, s.sessionId),
    path.join(`/tmp/claude-${process.getuid()}`, dir, s.sessionId),
    path.join(process.env.HOME, '.claude', 'jobs', s.sessionId.slice(0, 8)),
  ];
  const walk = (p, depth) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    newest = Math.max(newest, st.mtimeMs);
    if (!st.isDirectory() || depth > 3) return;
    for (const e of fs.readdirSync(p)) walk(path.join(p, e), depth + 1);
  };
  for (const r of roots) walk(r, 0);
  if (!newest) return null;
  return { minutes: (Date.now() - newest) / 60000, turnEnded };
}
// The transcript's latest main-thread entry is a 429 retry: over the account limit, the CLI retries for hours rather
// than failing. Returns { resetsAt (ms) | null } or null. The reset it reports is the plan's, which bought extra usage
// can beat, so callers retry sooner than it.
export function rateLimitRetry(file) {
  const tail = readTail(file, 256 * 1024);
  if (!tail) return null;
  for (let i = tail.length - 1; i >= 0; i--) {
    let d;
    try { d = JSON.parse(tail[i]); } catch { continue; }
    if (d.isSidechain) continue;
    if (d.type === 'user' || d.type === 'assistant') return null;
    if (d.type === 'system' && d.subtype === 'api_error') {
      // An account limit names its window or sets a long retry; a brief throttle 429 is neither and clears on its own.
      if (d.error?.status !== 429 || !(d.error.rateLimits || (d.retryInMs || 0) >= 60000)) return null;
      const r = d.error.rateLimits?.resetsAt;
      return { resetsAt: r ? r * 1000 : null };
    }
  }
  return null;
}
export function sessionRateLimited(s) {
  return s?.sessionId && s.cwd ? rateLimitRetry(transcriptPath(s)) : null;
}
export function isLimitText(text) {
  return /usage_limit_reached|hit your [^.]{0,40}limit/i.test(text || '');
}

// ---------- files ----------
export function readCache(cfg, name, dflt) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cfg.tick.state_dir, name), 'utf8'));
  } catch {
    return dflt;
  }
}
export function writeCache(cfg, name, obj) {
  fs.writeFileSync(path.join(cfg.tick.state_dir, name), JSON.stringify(obj, null, 2));
}
export function tailFile(file, lines = 40) {
  try {
    const all = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    return all.slice(-lines);
  } catch {
    return [];
  }
}
