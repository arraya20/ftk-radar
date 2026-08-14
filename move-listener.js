// move-listener.js — On-chain event listener for real-time player movement
// Listens for app__move transactions on the FTK World contract
// and fires a callback with decoded movement data instantly.

import { JsonRpcProvider, AbiCoder, toQuantity } from 'ethers';

const WORLD_ADDRESS = '0x0888B2Dc99710879dD0917ea67A693aa3AbB3A5D';
const APP_MOVE_SELECTOR = '0xa130aa39';
const APP_BATTLE_PVP_SELECTOR = '0x1cfac08d';
const APP_CHALLENGE_PVP_SELECTOR = '0x5b27c17c';
const POLL_INTERVAL_MS = 500; // 500ms (single RPC call ~117ms)
const coder = AbiCoder.defaultAbiCoder();

let provider = null;
let lastBlock = 0;
let pollTimer = null;
let moveCallback = null;
let pvpCallback = null;
let processing = false; // polling lock — prevents overlapping runs when RPC is slow

/**
 * Start listening for app__move transactions.
 * @param {string} rpcUrl - RPC endpoint URL
 * @param {function} onMove - callback(characterId, destX, destY, blockNumber)
 * @param {function} onPvp - callback(attackerId, defenderId, blockNumber, txHash, kind)
 */
export function startMoveListener(rpcUrl, onMove, onPvp) {
  provider = new JsonRpcProvider(rpcUrl);
  moveCallback = onMove;
  pvpCallback = onPvp;
  lastBlock = 0;

  console.log(`[move-listener] Starting on ${rpcUrl}`);
  console.log(`[move-listener] World: ${WORLD_ADDRESS}`);
  console.log(`[move-listener] Selector: ${APP_MOVE_SELECTOR}`);
  console.log(`[move-listener] Poll interval: ${POLL_INTERVAL_MS}ms`);

  pollLoop();
}

export function stopMoveListener() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.log('[move-listener] Stopped');
}

async function pollLoop() {
  // Process immediately, then on interval
  await processNewBlocks();
  pollTimer = setInterval(processNewBlocks, POLL_INTERVAL_MS);
}

async function processNewBlocks() {
  // Polling lock: if a previous run is still in flight (slow RPC / catch-up),
  // skip this tick so blocks are never processed by two overlapping runs.
  if (processing) return;
  processing = true;
  try {
    // Single RPC call: fetch latest block directly (117ms vs 446ms with getBlockNumber + getBlock)
    const block = await provider.send('eth_getBlockByNumber', ['latest', true]);
    if (!block?.transactions) return;

    const blockNum = parseInt(block.number, 16);
    if (blockNum <= lastBlock) return;

    // Process strictly ascending: oldest missed block first, latest LAST.
    // This guarantees the newest position always wins (no stale overwrite).
    if (lastBlock > 0 && blockNum > lastBlock + 1) {
      for (let missed = lastBlock + 1; missed < blockNum; missed++) {
        const b = await provider.send('eth_getBlockByNumber', [toQuantity(missed), true]);
        if (b) processBlockData(b, missed);
      }
    }

    // Latest block processed last so its data is the freshest applied.
    processBlockData(block, blockNum);

    lastBlock = blockNum;
  } catch (err) {
    if (!err.message?.includes('timeout')) {
      console.warn('[move-listener] Error:', err.message?.slice(0, 120));
    }
  } finally {
    processing = false;
  }
}

function processBlockData(block, blockNum) {
  const worldAddr = WORLD_ADDRESS.toLowerCase();
  for (const tx of block.transactions) {
    if (tx.to?.toLowerCase() !== worldAddr) continue;
    const selector = tx.input?.slice(0, 10);

    if (selector === APP_BATTLE_PVP_SELECTOR || selector === APP_CHALLENGE_PVP_SELECTOR) {
      try {
        const [attackerId, defenderId] = coder.decode(['uint256', 'uint256'], '0x' + tx.input.slice(10));
        pvpCallback?.(Number(attackerId), Number(defenderId), blockNum, tx.hash, selector === APP_CHALLENGE_PVP_SELECTOR ? 'challenge' : 'battle');
      } catch {}
      continue;
    }
    if (selector !== APP_MOVE_SELECTOR) continue;
    if (tx.input.length < 202) continue;

    try {
      const [characterId, destX, destY] = coder.decode(
        ['uint256', 'int32', 'int32'],
        '0x' + tx.input.slice(10)
      );
      const charId = Number(characterId);
      const x = Number(destX);
      const y = Number(destY);

      if (moveCallback) {
        moveCallback(charId, x, y, blockNum);
      }
    } catch (err) {
      // Malformed tx, skip
    }
  }
}
