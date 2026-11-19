#!/usr/bin/env node
// Stop hook for factory workers (wired in through worker-settings.json). A worker that ends its turn with the handoff
// line would otherwise sit idle until the next launchd tick, up to 10 minutes per handoff. This kicks the tick instead.
// The first kick waits until the turn has settled, since the tick skips a session that still reports busy; the second
// covers a kick that landed while another tick held the lock (a kickstart of a running job does nothing).
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig, inWorktreesOf, transcriptEndsWithHandoff } from '../lib/common.mjs';

const TICK_JOB = 'local.factory-tick';

function main() {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  if (input.agent_id || input.agent_type) return;
  const { cwd, transcript_path: transcript } = input;
  if (!cwd || !transcript || !inWorktreesOf(loadConfig(), cwd)) return;
  if (!transcriptEndsWithHandoff(transcript)) return;
  const kick = `launchctl kickstart gui/${process.getuid()}/${TICK_JOB}`;
  spawn('sh', ['-c', `sleep 30; ${kick}; sleep 150; ${kick}`], { detached: true, stdio: 'ignore' }).unref();
}
try { main(); } catch { /* never break a worker's turn */ }
