#!/usr/bin/env node
// PostToolUse hook for factory workers (wired in through worker-settings.json, passed as `--settings` on every launch).
// Once the worker's context passes HANDOFF_CONTEXT_TOKENS, it asks the worker to hand off at its next natural break;
// the tick then continues the job in a fresh session from the handoff. Every turn re-reads the whole context, so a
// worker that runs on from 500k pays several times what a fresh one does for the same step.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, inWorktreesOf, contextTokens, HANDOFF_CONTEXT_TOKENS, HANDOFF_RENUDGE_TOKENS, HANDOFF_FILE, HANDOFF_LINE } from '../lib/common.mjs';

function main() {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  // A subagent's tool call: the ask belongs to the main thread, which owns the job.
  if (input.agent_id || input.agent_type) return;
  const { cwd, session_id: session, transcript_path: transcript } = input;
  if (!cwd || !session || !transcript || !inWorktreesOf(loadConfig(), cwd)) return;
  const tokens = contextTokens(transcript);
  if (tokens < HANDOFF_CONTEXT_TOKENS) return;
  const marker = path.join(cwd, '.context', 'handoff-asked.json');
  let asked = null;
  try { asked = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch {}
  if (asked?.session === session && tokens < asked.tokens + HANDOFF_RENUDGE_TOKENS) return;
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ session, tokens, at: new Date().toISOString() }));
  const k = Math.round(tokens / 1000);
  const note = `Factory notice: this session's context is ${k}k tokens, past the ${HANDOFF_CONTEXT_TOKENS / 1000}k handoff point, and every further turn re-reads all of it. Hand off to a fresh session at your next natural break: a design finished, a review round's fixes applied, tests green, or before any wait. Not mid-edit, and not while subagents or background jobs you still need are running (let them finish and fold their results in first). At that break: leave the work in the worktree (commit it if that is a step you would take anyway), rewrite \`${HANDOFF_FILE}\` for a successor with no context per the factory rules (scope, what's done, design and review status, what's left in order, the exact next step, decisions and gotchas), then end the session with the last line \`${HANDOFF_LINE}\`. The tick starts the fresh session from it within minutes. Don't mention this notice in issue comments.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } }));
}
try { main(); } catch { /* never break a worker's tool call */ }
