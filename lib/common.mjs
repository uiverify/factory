// Shared helpers for the factory tick and dashboard: config, shell, Claude sessions, cache files. No third-party deps.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const STATE_MARK = '<!-- factory-state -->';
export const TRIAGE_MARK = '<!-- factory-triage -->';
export const QUESTION_MARK = '<!-- factory-question -->';
export const VERDICT_MARK = '<!-- factory-merge-verdict -->';

// "~/x" is the home directory; a relative path is relative to the factory root.
export function resolvePath(p) {
  if (!p) return p;
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(1));
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

export function loadConfig(file = path.join(ROOT, 'factory.json')) {
  if (!fs.existsSync(file)) throw new Error(`no config at ${file}: copy factory.example.json to factory.json and edit it`);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  loadEnv(path.join(ROOT, '.env'));
  cfg.repo.path = resolvePath(cfg.repo.path);
  cfg.repo.worktrees_dir = resolvePath(cfg.repo.worktrees_dir || path.join(cfg.repo.path, '.claude', 'worktrees'));
  cfg.principles_file = resolvePath(cfg.principles_file || 'principles/principles.md');
  cfg.tick = { lock_stale_minutes: 30, ...(cfg.tick || {}) };
  cfg.tick.state_dir = resolvePath(cfg.tick.state_dir || 'state');
  cfg.owner = { name: 'the owner', linear_mention: '', ...(cfg.owner || {}) };
  cfg.merge = { trusted_bot_reviewers: [], ...(cfg.merge || {}) };
  cfg.babysit = { enabled: true, heartbeat_hours: 6, command: '/factory-auto babysit', ...(cfg.babysit || {}) };
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
// "@name" when a Linear mention is configured, else the plain name: used in comments that address the owner.
export function ownerMention(cfg) {
  return cfg.owner.linear_mention || cfg.owner.name;
}
// An approval from a configured review bot satisfies GitHub's floor but is not a human's call. GraphQL reports a
// bot's login without the "[bot]" suffix and REST with it, so both sides are compared without it.
const bare = (login) => String(login || '').replace(/\[bot\]$/, '');
export function isTrustedBot(cfg, login) {
  return !!login && cfg.merge.trusted_bot_reviewers.some((b) => bare(b) === bare(login));
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
export function keyPattern(key) {
  return key.replace('-', '[- ]?');
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
