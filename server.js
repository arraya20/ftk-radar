import express from 'express';
import cors from 'cors';
import path from 'node:path';

// Trust nginx reverse proxy so req.ip reflects X-Forwarded-For / X-Real-IP
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { startMoveListener } from './move-listener.js';
import { createAtomicRateGate } from './atomic-rate-gate.js';
import { createRateLimiter, fetchWithTimeout, requireAdminToken } from './security.js';

// ─── Cross-process API gate (shared with ftk-bot) ───
const gate = createAtomicRateGate({
  stateFile: process.env.FTK_API_GATE_FILE || '/tmp/ftk-api-gate.json',
  minGapMs: Number(process.env.FTK_API_MIN_GAP_MS || 1_200),
});
const acquireGate = label => gate.acquire(label);
const signalCooldown = cooldownMs => gate.cooldown(cooldownMs);

// ─── Item database for name resolution ───
const ITEMS_PATH = process.env.ITEMS_PATH || '/home/ubuntu/ftk-bot/data/items.json';
let ITEM_DB = {};
try {
  const raw = readFileSync(ITEMS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  ITEM_DB = parsed.items ?? parsed;
  console.log(`[items] Loaded ${Object.keys(ITEM_DB).length} items from ${ITEMS_PATH}`);
} catch (err) {
  console.warn(`[items] Failed to load ${ITEMS_PATH}:`, err.message);
}

function resolveItemName(itemId) {
  const item = ITEM_DB[String(itemId)];
  if (!item) return `Item #${itemId}`;
  return item.name?.trim() ?? `Item #${itemId}`;
}

function resolveItemTier(itemId) {
  const item = ITEM_DB[String(itemId)];
  return item?.tier ?? null;
}

function resolveSlotType(itemId) {
  const item = ITEM_DB[String(itemId)];
  return item?.equipmentInfo?.slotType ?? null;
}

const EQUIP_SLOT_NAMES = {
  0: 'Weapon', 1: 'Shield', 2: 'Armor', 3: 'Helmet',
  4: 'Boots', 5: 'Mount', 6: 'Pet', 7: 'Ring',
};

const EQUIP_TYPE_NAMES = {
  6: 'Sword', 7: 'Axe', 8: 'Spear', 9: 'Bow', 10: 'Staff', 11: 'Dagger',
  12: 'Shield', 13: 'Cloth Armor', 14: 'Cloth Headgear', 15: 'Cloth Boots',
  16: 'Leather Armor', 17: 'Leather Helmet', 18: 'Leather Boots',
  19: 'Plate Armor', 20: 'Plate Helmet', 21: 'Plate Boots',
  22: 'Mount', 29: 'Pet', 33: 'Ring',
};

function resolveItemType(itemId) {
  const item = ITEM_DB[String(itemId)];
  const t = item?.type;
  return EQUIP_TYPE_NAMES[t] ?? null;
}

// ─── Inventory cache (on-demand, per-player) ───
const inventoryCache = new Map(); // id -> { data, fetchedAt }
const INVENTORY_CACHE_TTL = 60_000;
const INVENTORY_CACHE_MAX = 500; // LRU cap — evict oldest to bound memory

// Insert into inventoryCache with LRU eviction (Map preserves insertion order).
export function setInventoryCache(id, data) {
  inventoryCache.delete(id); // re-insert to move to newest position
  inventoryCache.set(id, { data, fetchedAt: Date.now() });
  while (inventoryCache.size > INVENTORY_CACHE_MAX) {
    const oldestKey = inventoryCache.keys().next().value;
    inventoryCache.delete(oldestKey);
  }
}

export function getInventoryCacheSize() {
  return inventoryCache.size;
}

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '127.0.0.1';
const EXTERNAL_FETCH_TIMEOUT_MS = Number(process.env.EXTERNAL_FETCH_TIMEOUT_MS || 10_000);
const CORS_ORIGINS = new Set(
  (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const API_BASE = 'https://app.forthekingdom.xyz/v0/api';
const FULL_REFRESH_INTERVAL_MS = 5 * 60_000;
const POSITION_REFRESH_INTERVAL_MS = 20_000; // 20s (on-chain listener handles real-time)
const LEADERBOARD_REFRESH_INTERVAL_MS = 5 * 60_000; // 5min (match full refresh, reduce API load)
const GUILD_REFRESH_INTERVAL_MS = 5 * 60_000;
const BATCH_SIZE = 2; // FTK API now enforces max 2 ids per /character call (was 15)
const POSITION_BATCH_SIZE = 100; // max per /characterPosition call
const BATCH_DELAY_MS = 2_500; // Raised from 1500 — with BATCH_SIZE=2, more requests per poll; 2.5s avoids CF 429
const TILE_REQUEST_DELAY_MS = 1_200;
const TILE_SCAN_BATCH_SIZE = 5;
const TILE_SCAN_INTERVAL_MS = 15_000;
const LEADERBOARD_PAGE_SIZE = 50;
const MAX_LEADERBOARD_PAGES = 12;
const NAMRI_ID = 111;
// Track all public guilds because active PvP-relevant players can be absent from
// leaderboard pages. Example: 0xDamm28 (id=78) is active via /guilds but not ranked.
const TRACKED_GUILD_IDS = [];
const TRACKED_GUILD_LABELS = [];
const ONLINE_WINDOW_SECONDS = 24 * 60 * 60;

// ─── SSE clients ───
const sseClients = new Set();
const sseConnectionsByIp = new Map(); // ip -> active SSE connection count
const sseOpenAttemptsByIp = new Map(); // ip -> recent connection-open timestamps
const SSE_MAX_CONNECTIONS_PER_IP = Number(process.env.SSE_MAX_CONNECTIONS_PER_IP || 4);
const SSE_OPEN_WINDOW_MS = Number(process.env.SSE_OPEN_WINDOW_MS || 60_000);
const SSE_MAX_OPENS_PER_WINDOW = Number(process.env.SSE_MAX_OPENS_PER_WINDOW || 20);
const prevPositions = new Map(); // id -> {x, y, nx, ny, state} for change detection
const prevFullPlayerIds = new Set(); // track player ids from last broadcastFull for delta/remove detection
const onchainTimestamps = new Map(); // id -> timestamp of last on-chain move (prevents stale API overwrite)
const combatEvents = [];
let lastCombatEventId = 0;
const COMBAT_EVENT_LIMIT = 30;

function addCombatEvents(rows) {
  for (const row of rows ?? []) {
    const id = Number(row.id);
    if (!id || combatEvents.some((e) => e.id === id)) continue;
    combatEvents.push({
      id,
      timestamp: Number(row.timestamp ?? 0),
      attacker_id: Number(row.attacker_id), attacker_name: row.attacker_name ?? `#${row.attacker_id}`,
      defender_id: Number(row.defender_id), defender_name: row.defender_name ?? `#${row.defender_id}`,
      hps: Array.isArray(row.hps) ? row.hps.map(Number) : [],
      location: row.location ?? null,
    });
    lastCombatEventId = Math.max(lastCombatEventId, id);
  }
  combatEvents.sort((a, b) => b.timestamp - a.timestamp);
  if (combatEvents.length > COMBAT_EVENT_LIMIT) combatEvents.length = COMBAT_EVENT_LIMIT;
}

async function pollCombatEvents() {
  try {
    // Dedicated combat fetch: do not queue behind the 5-minute character metadata poll.
    // This endpoint is small and is the fallback/enrichment path only.
    const response = await fetchWithTimeout(`${API_BASE}/characterPvp/${NAMRI_ID}?limit=20`, {}, EXTERNAL_FETCH_TIMEOUT_MS);
    if (!response.ok) return;
    const rows = (await response.json())?.data ?? [];
    const before = new Set(combatEvents.map((e) => e.id));
    addCombatEvents(rows);
    const fresh = combatEvents.filter((e) => !before.has(e.id));
    for (const event of fresh.reverse()) broadcast('combat-event', event);
  } catch (error) {
    console.warn(`[combat-events] ${error.message}`);
  }
}

// Combat API is the current authoritative event source; poll frequently, then fan out via SSE.
// Keep this separate from the heavier player metadata polls.
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// Lightweight player update — only position fields for fast SSE (~90 bytes vs ~300)
function broadcastPlayerUpdate(player) {
  broadcast('player-update', {
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    nx: player.nx,
    ny: player.ny,
    state: player.state,
    kingdom_id: player.kingdom_id,
  });
}

function broadcastPositionDiffs() {
  const allPlayers = [...cache.players, cache.me].filter(Boolean);
  for (const p of allPlayers) {
    const prev = prevPositions.get(p.id);
    const changed = !prev || prev.x !== p.x || prev.y !== p.y || prev.nx !== p.nx || prev.ny !== p.ny || prev.state !== p.state;
    if (changed) {
      broadcastPlayerUpdate(p);
      prevPositions.set(p.id, { x: p.x, y: p.y, nx: p.nx, ny: p.ny, state: p.state });
    }
  }
}

// Delta-aware full broadcast: send player-update only for changed/new players,
// player-remove for players that went offline, and always send me + status.
function broadcastFull() {
  const allPlayers = [...cache.players, cache.me].filter(Boolean);
  const currentIds = new Set(allPlayers.map(p => p.id));

  // Detect removed players (were in previous full set, gone now)
  for (const prevId of prevFullPlayerIds) {
    if (!currentIds.has(prevId)) {
      broadcast('player-remove', { id: prevId });
      prevPositions.delete(prevId);
    }
  }

  // Send per-player diffs for changed/new players
  for (const p of allPlayers) {
    const prev = prevPositions.get(p.id);
    const changed = !prev || prev.x !== p.x || prev.y !== p.y
      || prev.nx !== p.nx || prev.ny !== p.ny || prev.state !== p.state;
    if (changed || !prevFullPlayerIds.has(p.id)) {
      broadcastPlayerUpdate(p);
      prevPositions.set(p.id, { x: p.x, y: p.y, nx: p.nx, ny: p.ny, state: p.state });
    }
  }

  // Update tracked set for next diff
  prevFullPlayerIds.clear();
  for (const id of currentIds) prevFullPlayerIds.add(id);

  // me + status are small, always send
  broadcast('me', cache.me);
  broadcast('status', buildStatus());
}

// Build the status payload — shared by broadcastFull() and initial SSE connect
// so a freshly connected client sees tile/scan counters immediately (previously
// the "Tiles" stat showed 0 until the next full broadcast).
function buildStatus() {
  return {
    playerCount: cache.players.length,
    onlineCount: cache.onlineCount,
    trackedCount: cache.trackedCount,
    lastUpdated: cache.lastUpdated,
    lastError: cache.lastError,
    polling: cache.polling,
    tilesScanned: tileCache.size,
    scanRing,
    scanComplete,
  };
}

const app = express();
app.set('trust proxy', 'loopback');  // trust nginx on 127.0.0.1
app.disable('x-powered-by');  // don't advertise Express version
app.use(cors({
  origin(origin, callback) {
    // Same-origin requests do not send Origin and should always be allowed.
    callback(null, !origin || CORS_ORIGINS.has(origin));
  },
}));
const restRateLimiter = createRateLimiter({
  windowMs: Number(process.env.REST_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.REST_RATE_LIMIT_MAX || 120),
});
const inventoryRateLimiter = createRateLimiter({
  windowMs: Number(process.env.INVENTORY_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.INVENTORY_RATE_LIMIT_MAX || 20),
});
app.use('/api/', restRateLimiter);
const adminDebugAccess = (req, res, next) => {
  if (process.env.ENABLE_DEBUG_ENDPOINT !== 'true') return res.status(404).json({ error: 'Not found' });
  return requireAdminToken()(req, res, next);
};

// Baseline security headers (no external dependency — manual middleware).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ─── Player cache ───
const cache = {
  players: [],
  me: null,
  lastUpdated: null,
  lastError: null,
  polling: false,
  trackedCount: 0,
  onlineCount: 0,
};

const trackedMetaCache = new Map();
let trackedMetaLastUpdated = 0;
let leaderboardLastUpdated = 0;
let guildLastUpdated = 0;
let positionPolling = false;

// ─── Tile cache ───
const tileCache = new Map(); // "x,y" -> { kingdom_id, zone_type }
let tileScanning = false;
let tilesScanned = 0;
let scanRing = 0; // current spiral ring
let scanIdx = 0;  // index within ring
let scanComplete = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── FTK API rate-limit guard ───
let apiCooldownUntil = 0;
let apiBackoffMs = 0;
let lastApiRequestAt = 0;
let rateLimitHitCount = 0;

// In-process mutex: chain every rateLimitGuard() call so they run strictly
// one-at-a-time. Without this, concurrent callers (e.g. Promise.all in guild
// refresh) all read the same lastApiRequestAt, compute the same wait, and fire
// simultaneously — collapsing the gap and tripping 429s.
let gateChain = Promise.resolve();

function rateLimitGuard() {
  const run = gateChain.then(() => gateGuardCritical());
  // Keep the chain alive even if one call throws, so the queue never wedges.
  gateChain = run.catch(() => {});
  return run;
}

async function gateGuardCritical() {
  await acquireGate('radar'); // cross-process gate — coordinates with bot
  const now = Date.now();
  if (now < apiCooldownUntil) {
    await sleep(apiCooldownUntil - now);
  }
  const sinceLast = Date.now() - lastApiRequestAt;
  const minGap = 900;
  if (sinceLast < minGap) await sleep(minGap - sinceLast);
  lastApiRequestAt = Date.now();
}

function noteApiSuccess() {
  apiBackoffMs = Math.max(0, Math.floor(apiBackoffMs * 0.5));
}

function noteRateLimited() {
  rateLimitHitCount++;
  apiBackoffMs = apiBackoffMs ? Math.min(apiBackoffMs * 2, 10 * 60_000) : 60_000;
  apiCooldownUntil = Date.now() + apiBackoffMs;
  signalCooldown(apiBackoffMs); // push gate forward for bot too
  console.warn(`[rate-limit] FTK API 429 (#${rateLimitHitCount}). Cooling down for ${Math.round(apiBackoffMs / 1000)}s`);
}

function isRateLimitError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes('HTTP 429') || msg.includes('Error 1015') || msg.includes('rate limited') || msg.includes('rate-limited');
}

function getCharacterId(value) {
  const n = Number(value?.id ?? value?.character_id ?? value?.characterId ?? value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getLastActive(value) {
  const n = Number(value?.last_active_time ?? value?.lastActiveTime ?? value?.lastSeenAt ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeGuild(guild) {
  if (!guild) return null;
  return {
    id: guild.id ?? guild.guild_id ?? null,
    name: guild.name ?? null,
    tag: guild.tag ?? null,
    logo: guild.logo ?? null,
  };
}

function isOnlineLastActive(lastActive, now = Math.floor(Date.now() / 1000)) {
  return Number.isFinite(lastActive) && lastActive > 0 && now - lastActive <= ONLINE_WINDOW_SECONDS;
}

function addTrackingMeta(meta, value, source) {
  const id = getCharacterId(value);
  if (!id) return;
  const existing = meta.get(id) ?? {};
  const lastActive = getLastActive(value);
  const existingLastActive = Number(existing.last_active_time ?? 0);
  const mergedLastActive = Math.max(existingLastActive, lastActive ?? 0);
  const sourceSet = new Set(String(existing.source ?? '').split(',').filter(Boolean));
  sourceSet.add(source);
  meta.set(id, {
    ...existing,
    id: existing.id ?? id,
    name: value?.name ?? existing.name,
    level: value?.level ?? existing.level,
    kingdom_id: value?.kingdom_id ?? existing.kingdom_id,
    character_type: value?.character_type ?? existing.character_type,
    source: [...sourceSet].join(','),
    last_active_time: mergedLastActive,
    online: isOnlineLastActive(mergedLastActive),
    guild: value?.guild ?? existing.guild,
  });
}

// ─── Spiral tile scanner ───

function getSpiralCoords(ring, idx) {
  // ring 0 = just (0,0)
  if (ring === 0) return { x: 0, y: 0 };

  // For a given ring r, the tiles on the ring perimeter are:
  // 6 sides, each with r tiles
  const r = ring;
  const totalOnRing = r * 6;
  const i = idx % totalOnRing;

  // Flat-top hex coordinates on ring
  // Side 0: move +x direction
  // Side 1: move -y direction
  // Side 2: move (-x, -y) direction
  // Side 3: move -x direction
  // Side 4: move +y direction
  // Side 5: move (+x, +y) direction
  const side = Math.floor(i / r);
  const step = i % r;

  switch (side) {
    case 0: return { x: r - step, y: -step };
    case 1: return { x: -step, y: -r };
    case 2: return { x: -r, y: -r + step };
    case 3: return { x: -r + step, y: step };
    case 4: return { x: step, y: r };
    case 5: return { x: r, y: r - step };
    default: return { x: 0, y: 0 };
  }
}

async function fetchTile(x, y) {
  if (Date.now() < apiCooldownUntil) return null;
  const key = `${x},${y}`;
  try {
    await rateLimitGuard();
    const url = `${API_BASE}/tileInfo?x=${x}&y=${y}`;
    const response = await fetchWithTimeout(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'ftk-radar/0.2',
      },
    }, EXTERNAL_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      if (response.status === 429) noteRateLimited();
      return null;
    }
    noteApiSuccess();
    const json = await response.json();
    const data = json?.data;
    if (!data) return null;
    const tile = {
      kingdom_id: Number(data.kingdom_id ?? 0),
      zone_type: Number(data.zone_type ?? 0),
    };
    tileCache.set(key, tile);
    tilesScanned++;
    return tile;
  } catch (error) {
    if (isRateLimitError(error)) noteRateLimited();
    return null;
  }
}

async function spiralScanCycle() {
  if (tileScanning) return;
  if (scanComplete) return; // scan finished — stop burning API/CPU/memory
  tileScanning = true;

  try {
    if (Date.now() < apiCooldownUntil) return;
    const batchSize = TILE_SCAN_BATCH_SIZE;
    const newTiles = []; // delta: only tiles fetched this cycle

    for (let i = 0; i < batchSize; i++) {
      const { x, y } = getSpiralCoords(scanRing, scanIdx);
      const tile = await fetchTile(x, y);
      if (tile) newTiles.push({ x, y, ...tile });
      await sleep(TILE_REQUEST_DELAY_MS);

      scanIdx++;
      const totalOnRing = scanRing === 0 ? 1 : scanRing * 6;
      if (scanIdx >= totalOnRing) {
        scanRing++;
        scanIdx = 0;
        if (scanRing > 200) {
          scanComplete = true;
          console.log(`[tile-scan] Scan complete at ring 200 — ${tileCache.size} tiles cached, scanner stopped`);
        }
      }
    }
    // Broadcast ONLY the delta (new tiles), not the entire cache.
    // Frontend merges by "x,y" key, so this is safe and far cheaper.
    if (newTiles.length) broadcast('tiles', newTiles);
  } catch (err) {
    console.error('[tile-scan] Error:', err.message);
  } finally {
    tileScanning = false;
  }
}

async function fetchJson(url) {
  await rateLimitGuard();
  const response = await fetchWithTimeout(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'ftk-radar-mvp/0.1',
    },
  }, EXTERNAL_FETCH_TIMEOUT_MS);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 429) noteRateLimited();
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}: ${body.slice(0, 300)}`);
  }

  noteApiSuccess();
  return response.json();
}

async function fetchGuildMembers(guildId) {
  try {
    const json = await fetchJson(`${API_BASE}/guilds/${guildId}`);
    const data = json?.data;
    if (!json?.success || !data) {
      console.warn(`[guild:${guildId}] ${json?.reason || 'not available'}`);
      return [];
    }

    return extractGuildMembers(data);
  } catch (error) {
    if (isRateLimitError(error)) return [];
    console.warn(`[guild:${guildId}] fetch failed:`, error instanceof Error ? error.message : String(error));
    return [];
  }
}

function extractGuildMembers(guild) {
  const members = [];
  const guildInfo = normalizeGuild(guild);
  const pushMember = (member) => {
    if (!member) return;
    members.push({ ...member, guild: guildInfo });
  };

  if (Array.isArray(guild.members)) guild.members.forEach(pushMember);
  pushMember(guild.guild_master);
  pushMember(guild.guildMaster);
  for (const id of guild.memberIds ?? []) pushMember({ id });
  for (const id of guild.member_ids ?? []) pushMember({ id });
  return members;
}

async function fetchAllGuildMembers() {
  try {
    const json = await fetchJson(`${API_BASE}/guilds`);
    const guilds = Array.isArray(json?.data) ? json.data : [];
    const allMembers = [];
    const labels = [];
    const ids = [];

    for (const guild of guilds) {
      const guildId = Number(guild.id ?? guild.guild_id);
      if (Number.isFinite(guildId) && guildId > 0) ids.push(guildId);
      const label = String(guild.tag ?? guild.name ?? guildId ?? '').trim();
      if (label) labels.push(label);
      allMembers.push(...extractGuildMembers(guild));
    }

    TRACKED_GUILD_IDS.splice(0, TRACKED_GUILD_IDS.length, ...ids);
    TRACKED_GUILD_LABELS.splice(0, TRACKED_GUILD_LABELS.length, ...labels);
    return allMembers;
  } catch (error) {
    if (isRateLimitError(error)) return [];
    console.warn('[guilds] fetch failed:', error instanceof Error ? error.message : String(error));
    return [];
  }
}

async function fetchLeaderboardRows() {
  const rowsOut = [];
  const seenIds = new Set();

  for (let page = 1; page <= MAX_LEADERBOARD_PAGES; page++) {
    if (Date.now() < apiCooldownUntil) break;
    const url = `${API_BASE}/leaderboard?limit=${LEADERBOARD_PAGE_SIZE}&page=${page}`;
    const json = await fetchJson(url);
    const rows = Array.isArray(json?.data) ? json.data : [];
    if (!rows.length) break;

    for (const row of rows) {
      const id = getCharacterId(row);
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        rowsOut.push(row);
      }
    }

    const anyOnline = rows.some((row) => isOnlineLastActive(getLastActive(row)));
    if (rows.length < LEADERBOARD_PAGE_SIZE || !anyOnline) break;
    await sleep(900 + Math.floor(Math.random() * 600));
  }

  return rowsOut;
}

async function refreshTrackingMeta({ includeLeaderboard = true, includeGuild = false } = {}) {
  const nowMs = Date.now();

  if (includeLeaderboard) {
    try {
      const leaderboardRows = await fetchLeaderboardRows();
      leaderboardRows.forEach((row) => addTrackingMeta(trackedMetaCache, row, 'leaderboard'));
      leaderboardLastUpdated = nowMs;
    } catch (error) {
      if (!isRateLimitError(error)) throw error;
      noteRateLimited();
    }
  }

  if (includeGuild) {
    const guildMembers = TRACKED_GUILD_IDS.length
      ? (await Promise.all(TRACKED_GUILD_IDS.map((guildId) => fetchGuildMembers(guildId)))).flat()
      : await fetchAllGuildMembers();
    guildMembers.forEach((member) => {
      const guildId = member?.guild?.id ?? 'unknown';
      addTrackingMeta(trackedMetaCache, member, `guild:${guildId}`);
    });
    guildLastUpdated = nowMs;
  }

  const namriMeta = trackedMetaCache.get(NAMRI_ID) ?? {};
  trackedMetaCache.set(NAMRI_ID, { ...namriMeta, source: namriMeta.source ?? 'self' });
  trackedMetaLastUpdated = nowMs;
  return new Map(trackedMetaCache);
}

async function fetchTrackedIds({ forceFull = false } = {}) {
  const nowMs = Date.now();
  const includeLeaderboard = forceFull || nowMs - leaderboardLastUpdated >= LEADERBOARD_REFRESH_INTERVAL_MS || trackedMetaCache.size === 0;
  const includeGuild = forceFull || nowMs - guildLastUpdated >= GUILD_REFRESH_INTERVAL_MS || trackedMetaCache.size === 0;
  return refreshTrackingMeta({ includeLeaderboard, includeGuild });
}

async function fetchCharacters(ids) {
  const uniqueIds = [...new Set(ids.filter((id) => Number.isFinite(Number(id))).map(Number))];
  const characters = [];

  for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + BATCH_SIZE);
    const params = new URLSearchParams();
    for (const id of batch) params.append('ids', String(id));

    try {
      const json = await fetchJson(`${API_BASE}/character?${params.toString()}`);
      if (Array.isArray(json?.data)) characters.push(...json.data);
    } catch (err) {
      // Per-batch failure: skip this batch, continue with remaining batches.
      // Prevents a single bad batch from aborting the entire fetch.
      console.warn(`[fetchCharacters] batch ${batch} failed (${err?.message ?? err}), skipping`);
    }

    if (i + BATCH_SIZE < uniqueIds.length) await sleep(BATCH_DELAY_MS);
  }

  return characters;
}

async function fetchCharacterPositions(ids) {
  const uniqueIds = [...new Set(ids.filter((id) => Number.isFinite(Number(id))).map(Number))];
  const positions = [];

  try {
    for (let i = 0; i < uniqueIds.length; i += POSITION_BATCH_SIZE) {
      const batch = uniqueIds.slice(i, i + POSITION_BATCH_SIZE);
      const params = new URLSearchParams();
      for (const id of batch) params.append('ids', String(id));

      const json = await fetchJson(`${API_BASE}/characterPosition?${params.toString()}`);
      if (Array.isArray(json?.data)) positions.push(...json.data);

      if (i + POSITION_BATCH_SIZE < uniqueIds.length) await sleep(900 + Math.floor(Math.random() * 600));
    }
    return positions;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[position-fallback] /characterPosition failed (${msg}), falling back to /character`);
    return fetchCharacters(uniqueIds);
  }
}

function applyPositionUpdate(player, positionRow, meta = {}) {
  // Fix #2: Skip API position if on-chain data is fresher (prevents bounce-back)
  const onchainTime = onchainTimestamps.get(player.id);
  const ONCHAIN_FRESH_MS = 60_000; // on-chain data valid for 60s
  if (onchainTime && (Date.now() - onchainTime < ONCHAIN_FRESH_MS)) {
    // Keep on-chain position, update metadata only from API
    return {
      ...player,
      level: player.level,
      fame: player.fame,
      gold: player.gold,
      hp: player.hp,
      max_hp: player.max_hp,
    };
  }

  const normalized = normalizeCharacter({
    ...player,
    id: positionRow.id ?? positionRow.character_id ?? player.id,
    name: positionRow.name ?? player.name,
    kingdom_id: positionRow.kingdom_id ?? player.kingdom_id,
    character_type: positionRow.character_type ?? player.character_type,
    position: positionRow.position ?? {},
    guild: positionRow.guild ?? player.guild,
  }, {
    ...meta,
    last_active_time: meta.last_active_time ?? player.last_active_time ?? 0,
  });

  return {
    ...player,
    ...normalized,
    level: player.level,
    fame: player.fame,
    gold: player.gold,
    hp: player.hp,
    max_hp: player.max_hp,
  };
}

function updateCachesFromPlayers(players, idsToFetch) {
  const byId = new Map(players.map((player) => [player.id, player]));
  // Keep a snapshot of current cached positions so on-chain-fresh positions survive
  const prevById = new Map(
    [...cache.players, cache.me].filter(Boolean).map((p) => [p.id, p])
  );
  const trackedPlayers = idsToFetch.map((id) => {
    const meta = trackedMetaCache.get(Number(id)) ?? {};
    const player = byId.get(Number(id));
    if (player) {
      // Guard: if on-chain listener set a fresher position, keep it
      const onchainTime = onchainTimestamps.get(Number(id));
      const prev = prevById.get(Number(id));
      if (onchainTime && (Date.now() - onchainTime < 60_000) && prev) {
        // On-chain position still fresh — update metadata only, keep cached position
        return {
          ...prev,
          name: player.name ?? prev.name,
          level: Number(player.level ?? prev.level ?? 0),
          fame: Number(player.fame ?? prev.fame ?? 0),
          gold: Number(player.gold ?? prev.gold ?? 0),
          hp: Number(player.current_hp ?? player.hp ?? prev.hp ?? 0),
          max_hp: Number(player.max_hp ?? prev.max_hp ?? 0),
          state: player.state ?? prev.state,
          kingdom_id: Number(player.kingdom_id ?? prev.kingdom_id ?? 0),
          guild: normalizeGuild(player.guild) ?? prev.guild ?? meta.guild ?? null,
          source: meta.source ?? prev.source ?? null,
          online: prev.online,
        };
      }
      return normalizeCharacter({
        ...meta,
        ...player,
        position: player.position ?? { current_x: player.x, current_y: player.y, next_x: player.x, next_y: player.y, arrival_time: 0 },
        guild: player.guild ?? meta.guild,
      }, meta);
    }

    // /character sometimes omits valid active players. Keep them on the map if
    // /leaderboard or /guilds gave enough metadata; their position will be filled
    // by the lightweight /characterPosition poll below.
    if (meta.online && Number.isFinite(Number(meta.id))) {
      return normalizeCharacter({
        id: meta.id,
        name: meta.name,
        level: meta.level,
        kingdom_id: meta.kingdom_id,
        character_type: meta.character_type,
        guild: meta.guild,
        position: { current_x: 0, current_y: 0, next_x: 0, next_y: 0, arrival_time: 0 },
      }, meta);
    }

    return null;
  }).filter(Boolean);
  cache.trackedCount = trackedPlayers.length;
  cache.players = trackedPlayers.filter((player) => player.id !== NAMRI_ID && player.online);
  cache.onlineCount = cache.players.length;
  cache.me = byId.get(NAMRI_ID) ?? cache.me ?? null;
  cache.lastUpdated = new Date().toISOString();
  cache.lastError = null;
}

function normalizeCharacter(character, meta = {}) {
  const position = character?.position ?? {};
  const now = Math.floor(Date.now() / 1000);
  const arrival = Number(position.arrival_time ?? 0);
  const inTransit = arrival > now;
  // Always use destination (next_x/y) — this matches on-chain app__move
  // Using current_x/y causes bounce-back when on-chain listener sends destination
  // Use destination (next_x/y) when present, else current_x/y.
  // IMPORTANT: use Number.isFinite, not `||`, so a valid coordinate of 0
  // (on an axis) is not falsely discarded as falsy.
  const nextX = Number(position.next_x);
  const nextY = Number(position.next_y);
  const curX = Number(position.current_x);
  const curY = Number(position.current_y);
  const x = Number.isFinite(nextX) ? nextX : (Number.isFinite(curX) ? curX : 0);
  const y = Number.isFinite(nextY) ? nextY : (Number.isFinite(curY) ? curY : 0);
  const lastActive = Number(meta.last_active_time ?? character.last_active_time ?? 0);

  return {
    id: Number(character.id),
    name: character.name ?? `#${character.id}`,
    level: Number(character.level ?? 0),
    kingdom_id: Number(character.kingdom_id ?? 0),
    x,
    y,
    nx: inTransit && Number.isFinite(nextX) ? nextX : null,
    ny: inTransit && Number.isFinite(nextY) ? nextY : null,
    state: character.state ?? null,
    fame: Number(character.fame ?? 0),
    gold: Number(character.gold ?? 0),
    hp: Number(character.current_hp ?? character.hp ?? 0),
    max_hp: Number(character.max_hp ?? 0),
    character_type: Number(character.character_type ?? character.type ?? 0),
    last_active_time: lastActive || null,
    online: isOnlineLastActive(lastActive, now),
    source: meta.source ?? null,
    guild: normalizeGuild(character.guild) ?? meta.guild ?? null,
  };
}

async function pollFtk() {
  if (cache.polling) return;
  if (Date.now() < apiCooldownUntil && cache.players.length > 0) return;
  cache.polling = true;
  const started = Date.now();

  try {
    const trackedMeta = await fetchTrackedIds({ forceFull: false });
    const idsToFetch = [...trackedMeta.keys()];
    if (!idsToFetch.length) throw new Error('No FTK ids available to fetch');

    // Optimization: only fetch full /character metadata for online players + Namri.
    // Offline players already have leaderboard/guild metadata in trackedMetaCache —
    // no need to burn rate-limit budget on stale offline data every poll.
    const idsForMetadata = idsToFetch.filter((id) => {
      if (id === NAMRI_ID) return true;
      const meta = trackedMeta.get(id);
      return meta?.online === true;
    });

    const characters = await fetchCharacters(idsForMetadata);
    const normalized = characters
      .map((character) => normalizeCharacter(character, trackedMeta.get(Number(character.id)) ?? {}))
      .filter((player) => Number.isFinite(player.id));

    updateCachesFromPlayers(normalized, idsToFetch);

    // Avoid aggressive tile rescans around every player: this was causing Cloudflare 429s.
    // Death-zone boundary uses the slow spiral scanner instead.

    console.log(`[${cache.lastUpdated}] Poll complete: ${cache.onlineCount}/${cache.trackedCount} online players, Namri ${cache.me ? 'loaded' : 'missing'}, ${Date.now() - started}ms`);
    broadcastFull();
  } catch (error) {
    if (isRateLimitError(error)) noteRateLimited();
    // Never surface Cloudflare 429 / Error 1015 to the frontend.
    // The radar still uses cached data, and the banner is meant for real outages.
    cache.lastError = isRateLimitError(error)
      ? null
      : (error instanceof Error ? error.message : String(error));
    console.error(`[${new Date().toISOString()}] Poll failed:`, error);
  } finally {
    cache.polling = false;
  }
}

async function pollPositions() {
  if (positionPolling || cache.polling) return;
  if (Date.now() < apiCooldownUntil && cache.players.length > 0) return;
  if (!cache.players.length && !cache.me) return;
  positionPolling = true;
  const started = Date.now();

  try {
    // Fix #3: Use cached tracked IDs, don't trigger leaderboard/guild refresh here
    // Metadata refresh happens in pollFtk() every 5min, not in pollPositions
    const trackedMeta = trackedMetaCache.size > 0 ? trackedMetaCache : await fetchTrackedIds({ forceFull: false });
    const cachedPlayers = [...cache.players, cache.me].filter(Boolean);
    const missingTracked = [...trackedMeta.keys()]
      .filter((id) => id !== NAMRI_ID && !cachedPlayers.some((player) => player.id === id));
    const idsToFetch = [...new Set([
      ...cachedPlayers.map((player) => player.id).filter(Boolean),
      ...missingTracked,
    ])];
    if (!idsToFetch.length) return;

    const positionRows = await fetchCharacterPositions(idsToFetch);
    const rowsById = new Map(positionRows.map((row) => [getCharacterId(row), row]).filter(([id]) => id));
    const updated = idsToFetch.map((id) => {
      const player = cachedPlayers.find((cached) => cached.id === id);
      const meta = trackedMeta.get(Number(id)) ?? {};
      const seed = player ?? normalizeCharacter({
        id: meta.id ?? id,
        name: meta.name,
        level: meta.level,
        kingdom_id: meta.kingdom_id,
        character_type: meta.character_type,
        guild: meta.guild,
        position: { current_x: 0, current_y: 0, next_x: 0, next_y: 0, arrival_time: 0 },
      }, meta);
      const row = rowsById.get(Number(id));
      if (!row) return seed;
      return applyPositionUpdate(seed, row, meta);
    });

    updateCachesFromPlayers(updated, idsToFetch);
    console.log(`[${cache.lastUpdated}] Position refresh: ${positionRows.length} players, ${Date.now() - started}ms`);
    broadcastPositionDiffs(); // per-player SSE — only changed positions
  } catch (error) {
    if (isRateLimitError(error)) noteRateLimited();
    cache.lastError = isRateLimitError(error)
      ? null
      : (error instanceof Error ? error.message : String(error));
    console.error(`[${new Date().toISOString()}] Position refresh failed:`, error);
  } finally {
    positionPolling = false;
  }
}

// ─── API Endpoints ───

app.get('/api/players', (_req, res) => {
  if (cache.lastUpdated) res.setHeader('X-Last-Update', cache.lastUpdated);
  res.json(cache.players);
});

app.get('/api/me', (_req, res) => {
  if (!cache.me) return res.status(503).json({ error: 'Namri data not loaded yet' });
  res.json(cache.me);
});

app.get('/api/debug/player/:query', adminDebugAccess, (req, res) => {
  const query = String(req.params.query ?? '').toLowerCase();
  const idQuery = Number(query);
  const players = [...cache.players, cache.me].filter(Boolean);
  const tracked = [...trackedMetaCache.values()];
  const match = (player) => Number.isFinite(idQuery)
    ? Number(player.id) === idQuery
    : String(player.name ?? '').toLowerCase().includes(query);

  res.json({
    cache: players.filter(match),
    trackedMeta: tracked.filter(match),
    cacheCount: players.length,
    trackedMetaCount: tracked.length,
    lastUpdated: cache.lastUpdated,
  });
});

app.get('/api/status', (_req, res) => {
  res.json({
    playerCount: cache.players.length,
    onlineCount: cache.onlineCount,
    trackedCount: cache.trackedCount,
    lastUpdated: cache.lastUpdated,
    polling: cache.polling,
    tilesScanned: tileCache.size,
    scanRing,
    scanComplete,
  });
});

app.get('/api/tiles', (req, res) => {
  const xMin = Number(req.query.xMin);
  const xMax = Number(req.query.xMax);
  const yMin = Number(req.query.yMin);
  const yMax = Number(req.query.yMax);

  const hasRegion = Number.isFinite(xMin) && Number.isFinite(xMax) && Number.isFinite(yMin) && Number.isFinite(yMax);

  const tiles = [];
  for (const [key, tile] of tileCache) {
    const [x, y] = key.split(',').map(Number);
    if (hasRegion) {
      if (x < xMin || x > xMax || y < yMin || y > yMax) continue;
    }
    tiles.push({ x, y, kingdom_id: tile.kingdom_id, zone_type: tile.zone_type });
  }

  res.json(tiles);
});

// ─── On-demand player inventory endpoint ───

app.get('/api/player/:id', inventoryRateLimiter, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });

  // Restrict to tracked players only — prevents arbitrary IDs from being used
  // to drain the FTK API quota / fill the inventory cache.
  if (id !== NAMRI_ID && !trackedMetaCache.has(id)) {
    return res.status(403).json({ error: 'Player not tracked' });
  }

  // Check cache
  const cached = inventoryCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < INVENTORY_CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    // NOTE: no explicit rateLimitGuard() here — fetchJson() already calls it.
    // Calling it twice double-charged the gate (~900ms wasted per request).
    const url = `${API_BASE}/character?ids=${id}&includeInventory=true`;
    const json = await fetchJson(url);
    const char = Array.isArray(json?.data) ? json.data[0] : null;
    if (!char) return res.status(404).json({ error: 'Character not found' });

    // Build inventory response with resolved names
    const inventory = char.inventory ?? {};

    // Wearing = char.equipments (dict keyed by slot) — currently equipped
    const charEquips = char.equipments ?? {};
    const wearing = [];
    if (charEquips && typeof charEquips === 'object' && !Array.isArray(charEquips)) {
      for (const [slot, eq] of Object.entries(charEquips)) {
        const slotNum = Number(slot);
        wearing.push({
          slot: slotNum,
          slotName: EQUIP_SLOT_NAMES[slotNum] ?? `Slot ${slotNum}`,
          typeName: resolveItemType(eq.item_id),
          item_id: eq.item_id,
          name: resolveItemName(eq.item_id),
          tier: resolveItemTier(eq.item_id),
          level: eq.level ?? 1,
          instanceId: eq.id,
          author: eq.author,
          petInfo: eq.pet_info ?? null,
        });
      }
    }

    // Inventory equipments = inventory.equipments (list) — in bag, not worn
    const invEquips = inventory.equipments;
    const equipped = [];
    if (Array.isArray(invEquips)) {
      for (const eq of invEquips) {
        const slotType = resolveSlotType(eq.item_id);
        equipped.push({
          slot: slotType ?? -1,
          slotName: EQUIP_SLOT_NAMES[slotType] ?? 'Unknown',
          typeName: resolveItemType(eq.item_id),
          item_id: eq.item_id,
          name: resolveItemName(eq.item_id),
          tier: resolveItemTier(eq.item_id),
          level: eq.level ?? 1,
          instanceId: eq.id,
          author: eq.author,
          petInfo: eq.pet_info ?? null,
        });
      }
    }

    const tools = (inventory.tools ?? []).map((t) => ({
      id: t.id,
      item_id: t.item_id,
      name: resolveItemName(t.item_id),
      tier: resolveItemTier(t.item_id),
      durability: t.durability,
    }));

    const items = (inventory.other_items ?? []).map((i) => ({
      id: i.id,
      name: resolveItemName(i.id),
      tier: resolveItemTier(i.id),
      amount: i.amount,
    }));

    const result = {
      id: char.id,
      name: char.name,
      level: char.level,
      kingdom_id: char.kingdom_id,
      wearing,
      equipped,
      tools,
      items,
      weight: { current: char.current_weight, max: char.max_weight },
      stats: { atk: char.current_atk, def: char.current_def, agi: char.current_agi, hp: char.current_hp, max_hp: char.max_hp },
    };

    setInventoryCache(id, result);
    noteApiSuccess();
    res.json(result);
  } catch (error) {
    if (isRateLimitError(error)) noteRateLimited();
    console.error(`[/api/player/${id}] Fetch failed:`, error.message);
    res.status(502).json({ error: 'Failed to fetch player data' });
  }
});

// ─── SSE endpoint ───

function allowSseOpen(ip) {
  const now = Date.now();
  const cutoff = now - SSE_OPEN_WINDOW_MS;
  const attempts = (sseOpenAttemptsByIp.get(ip) ?? []).filter(t => t > cutoff);
  if (attempts.length >= SSE_MAX_OPENS_PER_WINDOW) return false;
  attempts.push(now);
  sseOpenAttemptsByIp.set(ip, attempts);
  return true;
}

app.get('/events', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!allowSseOpen(ip)) {
    return res.status(429).set('Retry-After', '60').end('Too many SSE connection attempts');
  }

  const activeForIp = sseConnectionsByIp.get(ip) ?? 0;
  if (activeForIp >= SSE_MAX_CONNECTIONS_PER_IP) {
    return res.status(429).set('Retry-After', '15').end('Too many concurrent SSE connections');
  }

  sseConnectionsByIp.set(ip, activeForIp + 1);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  // Send current state immediately
  res.write(`event: players\ndata: ${JSON.stringify(cache.players)}\n\n`);
  res.write(`event: me\ndata: ${JSON.stringify(cache.me)}\n\n`);
  res.write(`event: status\ndata: ${JSON.stringify(buildStatus())}\n\n`);
  res.write(`event: tiles\ndata: ${JSON.stringify([...tileCache].map(([k, v]) => { const [x, y] = k.split(','); return { x: +x, y: +y, ...v }; }))}\n\n`);
  res.write(`event: combat-events\ndata: ${JSON.stringify(combatEvents)}\n\n`);
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
    const remaining = (sseConnectionsByIp.get(ip) ?? 1) - 1;
    if (remaining > 0) sseConnectionsByIp.set(ip, remaining);
    else sseConnectionsByIp.delete(ip);
  });
});

export function getSseClientCount() {
  return sseClients.size;
}

// ─── Serve frontend ───

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDist = path.join(__dirname, 'frontend', 'dist');
// Static files with proper cache control — HTML no-cache, assets with ETag
app.use(express.static(frontendDist, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      // Assets (JS/CSS) have content-hash in filename — safe to cache
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(frontendDist, 'index.html'), (err) => {
    if (err) next();
  });
});

export function startServer() {
  return app.listen(PORT, HOST, () => {
  console.log(`FTK Radar backend listening on http://${HOST}:${PORT}`);

  setInterval(pollCombatEvents, 5_000);
  setTimeout(() => pollCombatEvents(), 0);

  // Initial full player poll, then lighter position refreshes between full polls.
  pollFtk();
  setInterval(pollFtk, FULL_REFRESH_INTERVAL_MS);
  setInterval(pollPositions, POSITION_REFRESH_INTERVAL_MS);

  // Tile scanner: intentionally slow to avoid FTK Cloudflare 429
  setInterval(() => spiralScanCycle(), TILE_SCAN_INTERVAL_MS);
  // Run first scan immediately
  setTimeout(() => spiralScanCycle(), 1000);

  // ─── On-chain move listener: real-time player position updates ───
  const rpcUrl = process.env.RPC_URL;
  if (rpcUrl) {
    startMoveListener(rpcUrl, (characterId, destX, destY, blockNum) => {
      // Find player in cache by characterId
      const allPlayers = [...cache.players, cache.me].filter(Boolean);
      const player = allPlayers.find(p => p.id === characterId);
      if (!player) {
        // Cache not ready or player not tracked — still broadcast with minimal data
        broadcast('player-update', {
          id: characterId,
          name: `#${characterId}`,
          x: destX,
          y: destY,
          nx: null,
          ny: null,
          state: 2, // moving
          kingdom_id: 0,
        });
        return;
      }

      // Update cached player position immediately
      player.x = destX;
      player.y = destY;
      player.nx = null;
      player.ny = null;

      // Mark on-chain timestamp to prevent stale API overwrite
      onchainTimestamps.set(characterId, Date.now());

      // Update prevPositions for the diff tracker
      prevPositions.set(player.id, { x: destX, y: destY, nx: null, ny: null, state: player.state });

      // Broadcast per-player SSE update instantly
      broadcastPlayerUpdate(player);
    }, (attackerId, defenderId, blockNum, txHash, kind) => {
      const allPlayers = [...cache.players, cache.me].filter(Boolean);
      const attacker = allPlayers.find(p => p.id === attackerId);
      const defender = allPlayers.find(p => p.id === defenderId);
      const event = {
        id: `chain:${txHash}`,
        timestamp: Math.floor(Date.now() / 1000),
        attacker_id: attackerId, attacker_name: attacker?.name ?? `#${attackerId}`,
        defender_id: defenderId, defender_name: defender?.name ?? `#${defenderId}`,
        hps: [], location: attacker && Number.isFinite(attacker.x) ? { x: attacker.x, y: attacker.y } : null,
        block_number: blockNum, tx_hash: txHash, kind,
      };
      addCombatEvents([event]);
      broadcast('combat-event', event);
    });
  } else {
    console.warn('[move-listener] RPC_URL not set — on-chain listener disabled');
  }
  });
}

export { app, restRateLimiter, inventoryRateLimiter };

if (process.env.NODE_ENV !== 'test') startServer();
