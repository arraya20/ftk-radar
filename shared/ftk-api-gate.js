// Cross-process FTK API rate gate shared by radar and bot processes.
// Reservations are serialized with an exclusive lock and committed via rename.

import { createAtomicRateGate } from '../atomic-rate-gate.js';

const gate = createAtomicRateGate({
  stateFile: process.env.FTK_API_GATE_FILE || '/tmp/ftk-api-gate.json',
  minGapMs: Number(process.env.FTK_API_MIN_GAP_MS || 1_200),
});

/** Wait until it is safe to make an FTK API request. */
export function acquireGate(label = '') {
  return gate.acquire(label);
}

/** Push the shared gate forward after an upstream rate-limit response. */
export function signalCooldown(cooldownMs = 60_000) {
  return gate.cooldown(cooldownMs);
}

/** Return the current shared gate state. */
export function gateStatus() {
  return gate.status();
}
