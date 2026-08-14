// shared/ftk-api-gate.js — Cross-process file-based rate limiter for FTK API
// Both radar (ftk-radar/server.js) and bot (ftk-bot/api.js) call this before
// any FTK API request so the TOTAL request rate stays under Cloudflare limits.
//
// Mechanism: writes next-allowed timestamp to /tmp/ftk-api-gate.json.
// Direct write (not temp+rename) — JSON is small enough that writeFileSync
// is effectively atomic on Linux for <4KB payloads.
// Worst-case race: 2 processes read simultaneously → 2 requests slip through
// at the same instant. Acceptable — gap collapses from 1200ms to ~0ms once,
// then self-corrects on the next call.

import { readFileSync, writeFileSync, existsSync } from 'fs';

const GATE_FILE = '/tmp/ftk-api-gate.json';
const MIN_GAP_MS = 1200; // minimum gap between any two FTK API calls (across all processes)

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readGate() {
  try {
    if (!existsSync(GATE_FILE)) return 0;
    const data = JSON.parse(readFileSync(GATE_FILE, 'utf8'));
    return typeof data.nextAllowedAt === 'number' ? data.nextAllowedAt : 0;
  } catch {
    return 0; // corrupt/missing file → allow immediately
  }
}

function writeGate(nextAllowedAt) {
  try {
    writeFileSync(GATE_FILE, JSON.stringify({ nextAllowedAt }), 'utf8');
  } catch (e) {
    console.warn('[gate] writeGate error:', e.message);
  }
}

/**
 * Wait until it's our turn to make an FTK API call.
 * Call this BEFORE every fetch() to app.forthekingdom.xyz.
 *
 * @param {string} [label] — optional label for debug logging
 */
export async function acquireGate(label = '') {
  const nextAllowed = readGate();
  const now = Date.now();
  const waitMs = nextAllowed - now;
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  writeGate(Date.now() + MIN_GAP_MS);
  // Debug: confirm gate was acquired (remove after verification)
  if (label) console.log(`[gate] ${label} acquired`);
}

/**
 * Signal that a 429 was hit — pushes the gate forward so both processes back off.
 * Call this when ANY fetch to FTK API returns HTTP 429.
 *
 * @param {number} [cooldownMs=60000] — how long to block (default 60s, escalate externally)
 */
export function signalCooldown(cooldownMs = 60_000) {
  writeGate(Date.now() + cooldownMs);
}

/**
 * Check current gate state (for status endpoints).
 */
export function gateStatus() {
  const nextAllowed = readGate();
  const now = Date.now();
  return {
    nextAllowedAt: nextAllowed,
    cooldownSeconds: Math.max(0, Math.ceil((nextAllowed - now) / 1000)),
  };
}
