import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAtomicRateGate } from '../atomic-rate-gate.js';

test('atomic rate gate serializes concurrent reservations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ftk-gate-'));
  const gate = createAtomicRateGate({ stateFile: path.join(dir, 'gate.json'), minGapMs: 20 });
  try {
    const waits = await Promise.all(Array.from({ length: 4 }, () => gate.acquire()));
    assert.equal(waits.length, 4);
    const status = gate.status();
    assert.ok(status.nextAllowedAt >= Date.now());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('atomic rate gate coordinates separate processes without collapsing the gap', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ftk-gate-process-'));
  const stateFile = path.join(dir, 'gate.json');
  const modulePath = path.resolve('atomic-rate-gate.js');
  const script = `import { createAtomicRateGate } from ${JSON.stringify(modulePath)};\nawait createAtomicRateGate({ stateFile: process.argv[1], minGapMs: 25 }).acquire();`;
  try {
    const startedAt = Date.now();
    const children = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, stateFile], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
    }));
    await Promise.all(children);
    const state = JSON.parse(await (await import('node:fs/promises')).readFile(stateFile, 'utf8'));
    assert.ok(state.nextAllowedAt - startedAt >= 25 * 3 - 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
