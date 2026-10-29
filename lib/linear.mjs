// Every Linear GraphQL call the factory makes. Linear is the factory's only state of record.
export async function linear(query, variables = {}) {
  if (!process.env.LINEAR_API_KEY) throw new Error('LINEAR_API_KEY missing: put it in .env next to factory.json');
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: process.env.LINEAR_API_KEY },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json();
  if (json.errors) throw new Error('Linear: ' + JSON.stringify(json.errors));
  return json.data;
}

export const ISSUE_FIELDS = `
  id identifier title description priority url createdAt updatedAt completedAt
  state { id name type }
  labels { nodes { id name } }
  assignee { id name }
  project { id name }
  projectMilestone { id name }
  inverseRelations { nodes { type issue { identifier state { type } } } }
  comments(first: 50) { nodes { id body createdAt user { id name } } }
`;

export async function fetchTargetIssues(target, stateNames) {
  const filter = { project: { name: { eq: target.project } }, state: { name: { in: stateNames } } };
  if (target.milestone) filter.projectMilestone = { name: { eq: target.milestone } };
  const out = [];
  let after = null;
  for (;;) {
    const data = await linear(`query($filter: IssueFilter!, $after: String) {
      issues(filter: $filter, first: 100, after: $after) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } }
    }`, { filter, after });
    out.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage) break;
    after = data.issues.pageInfo.endCursor;
  }
  return out;
}

// Resolves the team, the state for each role, and the labels the tick writes. Missing triage labels are returned,
// not thrown: label creation can be admin-only, and verdicts live in the triage comment regardless.
export async function bootstrapLinear(cfg) {
  const data = await linear(`query($key: String!) {
    viewer { id name }
    teams(filter: { key: { eq: $key } }) { nodes { id key states { nodes { id name type } } } }
    issueLabels(first: 250) { nodes { id name } }
  }`, { key: cfg.linear.team });
  const team = data.teams.nodes[0];
  if (!team) throw new Error(`Linear team ${cfg.linear.team} not found`);
  const states = Object.fromEntries(team.states.nodes.map((s) => [s.name, s]));
  const stateByRole = {};
  for (const [role, name] of Object.entries(cfg.linear.states)) {
    if (!states[name]) throw new Error(`state "${name}" not in team ${team.key}`);
    stateByRole[role] = states[name];
  }
  const labels = Object.fromEntries(data.issueLabels.nodes.map((l) => [l.name, l]));
  const needsHuman = labels[cfg.linear.needs_human_label];
  if (!needsHuman) throw new Error(`label "${cfg.linear.needs_human_label}" not found`);
  const triageLabels = {};
  const missingLabels = [];
  for (const [verdict, name] of Object.entries(cfg.linear.triage_labels || {})) {
    triageLabels[verdict] = labels[name] || null;
    if (!labels[name]) missingLabels.push(name);
  }
  return { viewer: data.viewer, team, stateByRole, needsHuman, triageLabels, missingLabels };
}

export function updateComment(id, body) {
  return linear(`mutation($id: String!, $body: String!) { commentUpdate(id: $id, input: { body: $body }) { success } }`, { id, body });
}
export async function createComment(issueId, body) {
  const res = await linear(`mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { comment { id } } }`, { issueId, body });
  return res?.commentCreate?.comment?.id || null;
}
export function updateIssue(id, input) {
  return linear(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, { id, input });
}
export async function issueHistory(id) {
  const { issue } = await linear(`query($id: String!) { issue(id: $id) { history(first: 10) { nodes { createdAt fromState { id name } toState { name } } } } }`, { id });
  return issue.history.nodes;
}

// ---------- reading what the tick wrote on a ticket ----------
export function findMarked(issue, mark) {
  return (issue.comments?.nodes || []).find((c) => c.body.trimStart().startsWith(mark));
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
export function hasLabel(issue, labelName) {
  return (issue.labels?.nodes || []).some((l) => l.name === labelName);
}
export function openBlockers(issue) {
  return (issue.inverseRelations?.nodes || []).filter(
    (r) => r.type === 'blocks' && r.issue && !['completed', 'canceled', 'duplicate'].includes(r.issue.state?.type),
  );
}
export function priorityRank(p) {
  return p === 0 || p == null ? 4.5 : p;
}
