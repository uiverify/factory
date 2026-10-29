// GitHub helpers over the gh CLI: which PRs belong to which ticket, and the signals that wake babysit.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shJson, hash, keyPattern } from './common.mjs';

const run = promisify(execFile);

let REPO_SLUG = null;
export function repoSlug(cfg) {
  if (!REPO_SLUG) REPO_SLUG = shJson('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd: cfg.repo.path }).nameWithOwner;
  return REPO_SLUG;
}

// Every open PR on a factory branch, once per tick.
export function openFactoryPrs(cfg) {
  return (shJson('gh', [
    'pr', 'list', '--repo', repoSlug(cfg), '--author', '@me', '--state', 'open', '--limit', '200',
    '--search', `head:${cfg.repo.branch_prefix}`, '--json', 'number,title,body,state,headRefName,baseRefName,reviewDecision,createdAt',
  ]) || []).filter((p) => p.headRefName.startsWith(cfg.repo.branch_prefix));
}

export function prsForTicket(cfg, key) {
  const list = shJson('gh', [
    'pr', 'list', '--repo', repoSlug(cfg), '--author', '@me', '--state', 'all', '--limit', '30',
    '--search', `${key} in:title,body`, '--json', 'number,title,body,state,isDraft,headRefName,baseRefName,mergedAt,url,createdAt',
  ]) || [];
  // A PR belongs to a ticket when the key is in its title or on a "Fixes/Closes/Resolves" line.
  // A bare mention in the body ("depends on ABC-123") is not ownership.
  const k = keyPattern(key);
  const inTitle = new RegExp(`\\b${k}\\b`, 'i');
  const fixesLine = new RegExp(`^\\s*(?:fixes|closes|resolves)\\b[^\\n]*\\b${k}\\b`, 'im');
  return list.filter((p) => inTitle.test(p.title) || fixesLine.test(p.body || ''));
}

export function prSignals(cfg, number) {
  const v = shJson('gh', [
    'pr', 'view', String(number), '--repo', repoSlug(cfg), '--json',
    'state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefOid,reviewDecision,statusCheckRollup,comments,reviews,labels,baseRefName,autoMergeRequest,reviewRequests,url,title',
  ]);
  const checks = Object.fromEntries((v.statusCheckRollup || []).map((c) => [c.name || c.context, c.conclusion || c.state || c.status]));
  const sig = {
    state: v.state, head: v.headRefOid, merge: v.mergeStateStatus, review: v.reviewDecision, base: v.baseRefName, checks,
    comments: (v.comments || []).length, reviews: (v.reviews || []).length, labels: (v.labels || []).map((l) => l.name).sort(),
    auto: v.autoMergeRequest ? 1 : 0, requests: (v.reviewRequests || []).length,
    // A PR stacked on an unmerged branch wakes when that parent moves; the base branch moves too often to count.
    parent: v.baseRefName === cfg.repo.base ? null : v.baseRefOid,
  };
  return { view: v, sig, hash: hash(sig) };
}

// Workers name every branch after the package lead: <prefix>abc-123, <prefix>abc-123-api.
export function leadOfBranch(cfg, branch) {
  if (!branch?.startsWith(cfg.repo.branch_prefix)) return null;
  return branch.slice(cfg.repo.branch_prefix.length).match(/^[a-z]+-\d+/i)?.[0].toUpperCase() || null;
}
// A package owns a PR named after its lead, or one whose title carries a package ticket key: agents do not always
// name a second branch after the lead.
export function ownsPr(cfg, lead, keys, pr) {
  if (leadOfBranch(cfg, pr.headRefName) === lead) return true;
  return (keys || []).some((k) => new RegExp(`\\b${keyPattern(k)}\\b`, 'i').test(pr.title || ''));
}
export function topOfStack(prs) {
  const open = prs.filter((p) => p.state === 'OPEN');
  if (!open.length) return null;
  const bases = new Set(open.map((p) => p.baseRefName));
  return open.find((p) => !bases.has(p.headRefName)) || open[open.length - 1];
}

// ---------- dashboard: every factory PR from two searches, not one gh call per PR ----------
const ACTOR = '... on User { login } ... on Team { name } ... on Bot { login }';
const PR_FIELDS = `number title body url state isDraft createdAt mergedAt headRefName baseRefName reviewDecision mergeStateStatus
  autoMergeRequest { enabledAt }
  reviewRequests(first: 10) { nodes { requestedReviewer { ${ACTOR} } } }
  reviews(last: 30) { nodes { author { login } state submittedAt } }
  comments(first: 50) { nodes { author { login } body createdAt updatedAt } }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) { nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ${ACTOR} } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { ... on CheckRun { name conclusion status } ... on StatusContext { context state } } } } } } }`;

// First 100 results, no pagination: enough until a factory has 100+ open or recently merged PRs.
export async function searchFactoryPrs(cfg, q) {
  const query = `query($q: String!) { search(query: $q, type: ISSUE, first: 100) { nodes { ... on PullRequest { ${PR_FIELDS} } } } }`;
  const { stdout } = await run('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `q=${q}`], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  // GitHub search tokenizes head: loosely, so the prefix is checked again here.
  return JSON.parse(stdout).data.search.nodes.filter((p) => p.headRefName?.startsWith(cfg.repo.branch_prefix));
}
export async function myOpenPrs(cfg) {
  const { stdout } = await run('gh', ['pr', 'list', '--repo', repoSlug(cfg), '--author', '@me', '--state', 'open', '--limit', '200', '--json', 'number,title,url,createdAt'], { maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  return JSON.parse(stdout);
}
