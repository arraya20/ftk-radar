import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readState(stateFile) {
  try {
    if (!existsSync(stateFile)) return { nextAllowedAt: 0 };
    const data = JSON.parse(readFileSync(stateFile, 'utf8'));
    return typeof data.nextAllowedAt === 'number' ? data : { nextAllowedAt: 0 };
  } catch {
    return { nextAllowedAt: 0 };
  }
}

async function withLock(lockFile, fn, { lockWaitMs, staleLockMs }) {
  const startedAt = Date.now();
  mkdirSync(path.dirname(lockFile), { recursive: true });
  while (true) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      try {
        return await fn();
      } finally {
        closeSync(fd);
        unlinkSync(lockFile);
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > staleLockMs) unlinkSync(lockFile);
      } catch {}
      if (Date.now() - startedAt >= lockWaitMs) throw new Error('Rate gate lock timeout');
      await sleep(5);
    }
  }
}

export function createAtomicRateGate({
  stateFile = '/tmp/ftk-api-gate.json',
  lockFile = `${stateFile}.lock`,
  minGapMs = 1_200,
  lockWaitMs = 5_000,
  staleLockMs = 30_000,
} = {}) {
  const lockOptions = { lockWaitMs, staleLockMs };
  const reserve = async (label = '') => withLock(lockFile, async () => {
    const now = Date.now();
    const state = readState(stateFile);
    const nextAllowedAt = Math.max(now, state.nextAllowedAt) + minGapMs;
    const tempFile = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(tempFile, JSON.stringify({ nextAllowedAt }), { mode: 0o600 });
    renameSync(tempFile, stateFile);
    if (label) console.log(`[gate] ${label} acquired`);
    return Math.max(0, nextAllowedAt - minGapMs - now);
  }, lockOptions);

  return {
    async acquire(label = '') {
      const waitMs = await reserve(label);
      if (waitMs > 0) await sleep(waitMs);
    },
    async cooldown(cooldownMs = 60_000) {
      await withLock(lockFile, async () => {
        const nextAllowedAt = Date.now() + cooldownMs;
        const tempFile = `${stateFile}.${process.pid}.tmp`;
        writeFileSync(tempFile, JSON.stringify({ nextAllowedAt }), { mode: 0o600 });
        renameSync(tempFile, stateFile);
      }, lockOptions);
    },
    status() {
      const nextAllowedAt = readState(stateFile).nextAllowedAt;
      return {
        nextAllowedAt,
        cooldownSeconds: Math.max(0, Math.ceil((nextAllowedAt - Date.now()) / 1000)),
      };
    },
  };
}
