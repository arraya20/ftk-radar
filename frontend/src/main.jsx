import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const TILE_SIZE_BASE = 22;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 5;

const MAP_BG = '#000000';
const GRID_LINE = 'rgba(210,210,210,0.28)';
const DZ_BORDER = 'rgba(255,236,160,0.82)'; // visible death zone boundary line
const NAMRI_ID = 111;

const KINGDOM_COLORS = {
  1: '#55c96a', // Sylvanreach / green
  2: '#b06cff', // Misthaven / purple
  3: '#62b7ff', // Everfrost / blue
  4: '#f29b38', // Sunscar / orange
};

const KINGDOM_LABELS = {
  1: 'Sylvanreach',
  2: 'Misthaven',
  3: 'Everfrost',
  4: 'Sunscar',
};

function getKingdomColor(kingdomId) {
  return KINGDOM_COLORS[Number(kingdomId)] ?? '#ffd84a';
}

// ─── Hex coordinate system (flat-top axial) ───
// FTK uses hex grid, not square grid
function hexToPixel(q, r, size) {
  // Flat-top hex: x = size * 3/2 * q, y = size * sqrt(3)/2 * q + sqrt(3) * r
  const x = size * (3/2 * q);
  const y = size * (Math.sqrt(3)/2 * q + Math.sqrt(3) * r);
  return { x, y };
}

function pixelToHex(x, y, size) {
  // Inverse of hexToPixel
  const q = (2/3 * x) / size;
  const r = (-1/3 * x + Math.sqrt(3)/3 * y) / size;
  return { q, r };
}

function drawHex(ctx, cx, cy, size) {
  // Draw flat-top hexagon centered at (cx, cy)
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 180 * (60 * i);
    const x = cx + size * Math.cos(angle);
    const y = cy + size * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// ─── Movement chevron arrow ───
// Draws a compact double-chevron (>>) pointing from current position toward destination.
function drawChevron(ctx, sx, sy, worldDx, worldDy, color) {
  const angle = Math.atan2(-worldDy, worldDx); // screen y is inverted from world y
  const DOT_R = 6;
  const GAP = 5;
  const LEN = 8;
  const W = 6;
  const CHEV_GAP = 4;
  const LW = 2.5;

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(angle);
  ctx.translate(DOT_R + GAP, 0);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (let i = 0; i < 2; i++) {
    const ox = i * CHEV_GAP;
    // Dark shadow for contrast
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = LW + 1;
    ctx.moveTo(ox, -W);
    ctx.lineTo(ox + LEN, 0);
    ctx.lineTo(ox, W);
    ctx.stroke();
    // Yellow chevron
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = LW;
    ctx.moveTo(ox, -W);
    ctx.lineTo(ox + LEN, 0);
    ctx.lineTo(ox, W);
    ctx.stroke();
  }

  ctx.restore();
}

const BOSS_MARKERS = [
  // Boss coordinates from local FTK monsterLocations.json.
  { id: 42, name: 'Kalyndra', x: 18, y: -1, primary: true },
  { id: 9, name: 'Ignis', x: -5, y: 1 },
  { id: 34, name: 'Goopie Puru', x: -23, y: -30 },
  { id: 35, name: 'Jiggly Puru', x: 22, y: 35 },
  { id: 36, name: 'Slushy Puru', x: -48, y: 32 },
  { id: 37, name: 'Yippee Puru', x: 48, y: -6 },
  { id: 43, name: 'Beowulf', x: 9, y: 34 },
  { id: 44, name: 'Grimknuckle', x: -40, y: -26 },
  { id: 45, name: 'Eira', x: -52, y: 43 },
  { id: 46, name: 'Nyxwing', x: 64, y: 15 },
  { id: 47, name: 'Kitsindra', x: 45, y: -17 },
];

// Kingdom capital + canonical sub-settlement markers.
const SETTLEMENTS = [
  { id: 'city-1', name: 'Lumindale', x: -53, y: -11, kingdom: 1, kingdomName: 'Sylvanreach', capital: true },
  { id: 'city-2', name: 'Aetheria', x: 53, y: 29, kingdom: 2, kingdomName: 'Misthaven', capital: true },
  { id: 'city-3', name: 'Frostgard', x: -15, y: 47, kingdom: 3, kingdomName: 'Everfrost', capital: true },
  { id: 'city-4', name: 'Dunewatch', x: 37, y: -33, kingdom: 4, kingdomName: 'Sunscar', capital: true },

  { id: 'sub-sand-snakes-village', name: "Sand Snake's Village", x: 34, y: -13, kingdom: 4, kingdomName: 'Sunscar', capital: false },
  { id: 'sub-mist', name: 'Mist', x: 33, y: 29, kingdom: 2, kingdomName: 'Misthaven', capital: false },
  { id: 'sub-icewatch', name: 'Icewatch', x: -28, y: 28, kingdom: 3, kingdomName: 'Everfrost', capital: false },
  { id: 'sub-crownwatch', name: 'Crownwatch', x: -34, y: -28, kingdom: 1, kingdomName: 'Sylvanreach', capital: false },
];

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString();
}

// ─── Square tile geometry ───

/* ─── Data hook ─── */

function useRadarData() {
  const [players, setPlayers] = useState([]);
  const [me, setMe] = useState(null);
  const [status, setStatus] = useState({ playerCount: 0, lastUpdated: null, lastError: null, polling: false, tilesScanned: 0, scanRing: 0 });
  const [tiles, setTiles] = useState([]);
  const [combatEvents, setCombatEvents] = useState([]);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState(null);
  const playerMapRef = useRef(new Map()); // id -> player (per-player SSE updates, no re-render)

  useEffect(() => {
    const es = new EventSource('/events');
    const markLive = () => setLastEventAt(Date.now());

    es.onopen = () => {
      markLive();
      setConnected(true);
      setError(null);
    };

    // Batch: initial load + metadata refresh
    // Server already sends destination (next_x/y), so batch data is correct
    // BUT: skip position overwrite if real-time player-update is fresher
    es.addEventListener('players', (e) => {
      try {
        markLive();
        const batch = JSON.parse(e.data);
        const map = playerMapRef.current;
        const REALTIME_FRESH_MS = 300_000; // real-time update valid for 5 min (= pollFtk interval); prevents batch overwrite
        batch.forEach(p => {
          const existing = map.get(p.id);
          if (existing && existing._updateTime && (Date.now() - existing._updateTime < REALTIME_FRESH_MS)) {
            // Real-time data is fresher — keep position, update metadata only
            existing.name = p.name;
            existing.level = p.level;
            existing.fame = p.fame;
            existing.gold = p.gold;
            existing.hp = p.hp;
            existing.max_hp = p.max_hp;
            existing.kingdom_id = p.kingdom_id;
            existing.nx = p.nx;
            existing.ny = p.ny;
            existing.state = p.state;
            map.set(p.id, existing);
          } else {
            // No recent real-time data — safe to use batch position
            map.set(p.id, p);
          }
        });
        setPlayers(batch);
      } catch {}
    });

    // Per-player: real-time position updates — update map directly, no React re-render
    // Compute dx/dy from previous position for movement arrows
    // IMPORTANT: merge into existing object to preserve metadata (level, hp, fame, gold)
    // that only arrives via the batch 'players' event, not the lightweight 'player-update'.
    es.addEventListener('player-update', (e) => {
      try {
        markLive();
        const p = JSON.parse(e.data);
        const prev = playerMapRef.current.get(p.id);
        if (prev) {
          p.dx = p.x - prev.x;
          p.dy = p.y - prev.y;
          p._prevX = prev.x;
          p._prevY = prev.y;
          p._updateTime = Date.now();
          // Merge: keep metadata (level, hp, max_hp, fame, gold, etc.) from previous batch
          const merged = { ...prev, ...p };
          playerMapRef.current.set(p.id, merged);
        } else {
          playerMapRef.current.set(p.id, p);
        }
      } catch {}
    });

    // Player went offline — remove from map so dot disappears
    es.addEventListener('player-remove', (e) => {
      try {
        markLive();
        const { id } = JSON.parse(e.data);
        playerMapRef.current.delete(id);
        setPlayers(prev => prev.filter(p => p.id !== id));
      } catch {}
    });

    es.addEventListener('me', (e) => {
      try { markLive(); setMe(JSON.parse(e.data)); } catch {}
    });

    es.addEventListener('status', (e) => {
      try {
        markLive();
        const s = JSON.parse(e.data);
        setStatus(s);
        setError(s?.lastError ?? null);
      } catch {}
    });

    es.addEventListener('combat-events', (e) => {
      try { setCombatEvents(JSON.parse(e.data) || []); } catch {}
    });

    es.addEventListener('combat-event', (e) => {
      try {
        const incoming = JSON.parse(e.data);
        setCombatEvents(prev => [incoming, ...prev.filter(item => item.id !== incoming.id)].slice(0, 30));
      } catch {}
    });

    es.addEventListener('tiles', (e) => {
      try {
        markLive();
        const incoming = JSON.parse(e.data);
        if (!Array.isArray(incoming) || !incoming.length) return;
        // Merge by "x,y" key — server now sends deltas (new tiles) instead of
        // the full cache each cycle. Initial connect still sends a full snapshot,
        // which merges cleanly into an empty map.
        setTiles((prev) => {
          const map = new Map(prev.map((t) => [`${t.x},${t.y}`, t]));
          for (const t of incoming) map.set(`${t.x},${t.y}`, t);
          return [...map.values()];
        });
      } catch {}
    });

    es.onerror = () => {
      setConnected(false);
      setError('Reconnecting…');
    };

    return () => es.close();
  }, []);

  return { players, me, status, tiles, combatEvents, error, connected, lastEventAt, playerMapRef };
}

/* ─── Canvas Map ─── */

function GameMap({ players, me, tiles, playerMapRef }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const camRef = useRef({ zoom: 1, offsetX: 0, offsetY: 0 });
  const animRef = useRef(null);
  const tilesRef = useRef([]);
  const playersRef = useRef([]);
  const meRef = useRef(null);

  useEffect(() => { tilesRef.current = tiles; }, [tiles]);
  useEffect(() => {
    // Merge: use React state for structure, but override positions from per-player SSE map
    const map = playerMapRef?.current;
    if (map && map.size > 0) {
      playersRef.current = players.map(p => {
        const updated = map.get(p.id);
        return updated ? { ...p, x: updated.x, y: updated.y, nx: updated.nx, ny: updated.ny, state: updated.state } : p;
      });
    } else {
      playersRef.current = players;
    }
  }, [players, playerMapRef]);
  useEffect(() => { meRef.current = me; }, [me]);

  const movementRef = useRef(new Map()); // id -> {dx, dy, time} for arrow direction

  // ─── Smooth movement: per-frame exponential smoothing ───
  // Each frame the render position eases toward the latest target (player.x/y).
  // Continuous by construction — a new target arriving mid-motion never teleports
  // the dot, which is what caused the old fixed-duration ease-out to stutter.
  const renderPosRef = useRef(new Map()); // id -> {x, y} smoothed display position
  const lastFrameRef = useRef(0);
  const SMOOTH_TAU_MS = 220;    // lower = snappier, higher = smoother/laggier
  const SMOOTH_SNAP_TILES = 25; // jumps larger than this = teleport/respawn → snap

  const advanceSmoothing = useCallback((list, dt) => {
    const rp = renderPosRef.current;
    const seen = new Set();
    const alpha = dt > 0 ? 1 - Math.exp(-dt / SMOOTH_TAU_MS) : 0;
    for (const p of list) {
      seen.add(p.id);
      const r = rp.get(p.id);
      if (!r) { rp.set(p.id, { x: p.x, y: p.y }); continue; }
      if (alpha === 0) continue;
      const d = Math.hypot(p.x - r.x, p.y - r.y);
      if (d > SMOOTH_SNAP_TILES) { r.x = p.x; r.y = p.y; continue; }
      r.x += (p.x - r.x) * alpha;
      r.y += (p.y - r.y) * alpha;
    }
    for (const id of rp.keys()) if (!seen.has(id)) rp.delete(id);
  }, []);

  const getDisplayPos = useCallback((player) => {
    const r = renderPosRef.current.get(player.id);
    return r ? { x: r.x, y: r.y } : { x: player.x, y: player.y };
  }, []);

  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, camStartX: 0, camStartY: 0 });
  const [hovered, setHovered] = useState(null);
  const hoveredRef = useRef(null); // mirror of hovered for canvas draw loop (avoids stale closure)
  const [pinned, setPinned] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [mouseHex, setMouseHex] = useState({ q: 0, r: 0 });
  const [zoomPercent, setZoomPercent] = useState(100);
  const [inventoryData, setInventoryData] = useState(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const inventoryCacheRef = useRef(new Map()); // id -> data
  const stackedBubblesRef = useRef([]); // [{sx, sy, w, h, players, rowPositions}] for stacked hit-testing
  const stackedHoverRef = useRef({ bubbleIdx: -1, rowIdx: -1 }); // hovered row in stacked panel
  const followingRef = useRef(false); // true = camera locked on Namri, zoom stays centered on him
  const zoomAnchorRef = useRef(null); // {x, y} world coords — zoom anchor point (set on center/click)

  const sizeRef = useRef({ w: 800, h: 600 });

  const toScreen = useCallback((worldX, worldY) => {
    const cam = camRef.current;
    const { w, h } = sizeRef.current;
    return {
      x: w / 2 + cam.offsetX + worldX * cam.zoom,
      y: h / 2 + cam.offsetY - worldY * cam.zoom,
    };
  }, []);

  const toWorld = useCallback((sx, sy) => {
    const cam = camRef.current;
    const { w, h } = sizeRef.current;
    return {
      x: (sx - w / 2 - cam.offsetX) / cam.zoom,
      y: -(sy - h / 2 - cam.offsetY) / cam.zoom,
    };
  }, []);

  const centerOn = useCallback((worldX, worldY, follow = false) => {
    const cam = camRef.current;
    const targetOffsetX = -worldX * cam.zoom;
    const targetOffsetY = worldY * cam.zoom;
    const startX = cam.offsetX;
    const startY = cam.offsetY;
    const duration = 600;
    const start = performance.now();
    followingRef.current = follow;
    zoomAnchorRef.current = { x: worldX, y: worldY }; // zoom anchor = center target
    function animate(now) {
      const t = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      cam.offsetX = startX + (targetOffsetX - startX) * ease;
      cam.offsetY = startY + (targetOffsetY - startY) * ease;
      if (t < 1) requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  }, []);

  // Resize
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { w: rect.width, h: rect.height };
    }
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // Center on Namri
  useEffect(() => {
    if (me && me.x != null && me.y != null) {
      centerOn(me.x * TILE_SIZE_BASE, me.y * TILE_SIZE_BASE, true);
    }
  }, [me?.id]);

  // ─── Draw ───
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    function draw() {
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      const tileSize = TILE_SIZE_BASE * cam.zoom;
      const currentTiles = tilesRef.current;
      const currentMe = playerMapRef?.current?.get(NAMRI_ID) ?? meRef.current;
      // Read directly from playerMapRef (real-time on-chain updates)
      // Fall back to playersRef (React state) for players not yet in map
      const pMap = playerMapRef?.current;
      let currentPlayers;
      if (pMap && pMap.size > 0) {
        // Build from map — this is the source of truth
        currentPlayers = [...pMap.values()];
      } else {
        currentPlayers = playersRef.current;
      }

      // Advance smoothed render positions once per frame, before any getDisplayPos read.
      const nowT = performance.now();
      const dt = lastFrameRef.current ? nowT - lastFrameRef.current : 0;
      lastFrameRef.current = nowT;
      const smoothList = (currentMe && !currentPlayers.some(p => p.id === currentMe.id))
        ? [...currentPlayers, currentMe]
        : currentPlayers;
      advanceSmoothing(smoothList, dt);

      // Follow Namri — keep camera centered on him when following
      if (followingRef.current && currentMe) {
        const pos = getDisplayPos(currentMe);
        cam.offsetX = -pos.x * TILE_SIZE_BASE * cam.zoom;
        cam.offsetY = pos.y * TILE_SIZE_BASE * cam.zoom;
      }

      const tileMap = new Map();
      for (const t of currentTiles) {
        tileMap.set(`${t.x},${t.y}`, t);
      }

      // Background
      ctx.fillStyle = MAP_BG;
      ctx.fillRect(0, 0, w, h);

      // ─── Base grid ───
      const worldTL = toWorld(0, 0);
      const worldBR = toWorld(w, h);
      const tileStep = TILE_SIZE_BASE;
      const worldMinX = Math.min(worldTL.x, worldBR.x);
      const worldMaxX = Math.max(worldTL.x, worldBR.x);
      const worldMinY = Math.min(worldTL.y, worldBR.y);
      const worldMaxY = Math.max(worldTL.y, worldBR.y);
      const qMin = Math.floor(worldMinX / tileStep) - 2;
      const qMax = Math.ceil(worldMaxX / tileStep) + 2;
      const rMin = Math.floor(worldMinY / tileStep) - 2;
      const rMax = Math.ceil(worldMaxY / tileStep) + 2;

      const tileToWorld = (q, r) => ({
        x: q * tileStep,
        y: r * tileStep,
      });

      // ─── Death Zone box ───
      // Ground-truth death-zone tile range from user-provided coordinates:
      // (13, 24), (-23, 24), (-23, -24), (13, -24)
      // Draw on the OUTER grid lines, not through tile centers.
      const dzLeft = (-23 - 0.5) * tileStep;
      const dzRight = (13 + 0.5) * tileStep;
      const dzTop = (24 + 0.5) * tileStep;
      const dzBottom = (-24 - 0.5) * tileStep;
      const dzShape = [
        { x: dzRight, y: dzTop },
        { x: dzLeft, y: dzTop },
        { x: dzLeft, y: dzBottom },
        { x: dzRight, y: dzBottom },
      ].map((p) => toScreen(p.x, p.y));

      for (let q = qMin; q <= qMax; q++) {
        for (let r = rMin; r <= rMax; r++) {
          const { x: wx, y: wy } = tileToWorld(q, r);
          const { x: sx, y: sy } = toScreen(wx, wy);
          if (sx < -tileSize * 2 || sx > w + tileSize * 2 || sy < -tileSize * 2 || sy > h + tileSize * 2) continue;

          // Square tile grid. Tile interior stays black; only the line is light gray.
          ctx.strokeStyle = GRID_LINE;
          ctx.lineWidth = Math.max(0.45, 0.65 * cam.zoom);
          ctx.strokeRect(sx - tileSize / 2, sy - tileSize / 2, tileSize, tileSize);
        }
      }

      // Draw death-zone border after the grid so it sits exactly on top of the outer grid lines.
      // Subtle pulse animation for visibility
      const dzPulse = 0.75 + 0.2 * Math.sin(Date.now() / 800);
      ctx.save();
      ctx.strokeStyle = DZ_BORDER;
      ctx.lineWidth = Math.max(2.5, 3.5 * cam.zoom);
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
      ctx.globalAlpha = dzPulse;
      ctx.beginPath();
      ctx.moveTo(dzShape[0].x, dzShape[0].y);
      for (let i = 1; i < dzShape.length; i++) ctx.lineTo(dzShape[i].x, dzShape[i].y);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();

      // ─── Settlement markers ───
      for (const s of SETTLEMENTS) {
        const wx = s.x * tileStep;
        const wy = s.y * tileStep;
        const { x: sx, y: sy } = toScreen(wx, wy);
        if (sx < -80 || sx > w + 80 || sy < -80 || sy > h + 80) continue;

        // Building shape: capital = bigger house, sub-settlement = smaller outpost.
        // Drawn before players so Namri/player dots stay visible on city tiles.
        const sz = s.capital ? 7 : 5;
        const bodyAlpha = s.capital ? 0.82 : 0.52;
        const roofAlpha = s.capital ? 0.88 : 0.58;
        const labelAlpha = s.capital ? 0.92 : 0.68;
        ctx.save();
        ctx.fillStyle = `rgba(100, 180, 220, ${bodyAlpha})`;
        ctx.strokeStyle = s.capital ? 'rgba(60, 130, 170, 0.9)' : 'rgba(60, 130, 170, 0.55)';
        ctx.lineWidth = s.capital ? 1.2 : 0.9;
        ctx.fillRect(sx - sz, sy - sz * 0.4, sz * 2, sz * 1.2);
        ctx.strokeRect(sx - sz, sy - sz * 0.4, sz * 2, sz * 1.2);
        ctx.fillStyle = `rgba(70, 140, 180, ${roofAlpha})`;
        ctx.beginPath();
        ctx.moveTo(sx - sz - 2, sy - sz * 0.4);
        ctx.lineTo(sx, sy - sz * 1.3);
        ctx.lineTo(sx + sz + 2, sy - sz * 0.4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.font = s.capital ? '700 11px sans-serif' : '650 9px sans-serif';
        ctx.fillStyle = s.capital ? '#8cd4ee' : '#77bdd3';
        ctx.globalAlpha = labelAlpha;
        ctx.textAlign = 'center';
        ctx.strokeStyle = 'rgba(0,0,0,0.72)';
        ctx.lineWidth = s.capital ? 2.5 : 2.0;
        ctx.strokeText(s.name, sx, sy - sz * 1.3 - 5);
        ctx.fillText(s.name, sx, sy - sz * 1.3 - 5);
        ctx.restore();
      }

      // ─── Movement arrows ───
      const ARROW_MAX_AGE = 25000;
      const movMap = movementRef.current;
      const CHEVRON_COLOR = '#ffe600';

      // Helper: resolve arrow direction for a player
      function getPlayerArrow(player) {
        // Priority 1: server says in transit (nx/ny differ from x/y)
        if (player.nx != null && player.ny != null && (player.nx !== player.x || player.ny !== player.y)) {
          return { dx: player.nx - player.x, dy: player.ny - player.y };
        }
        // Priority 2: on-chain detected movement (dx/dy from player-update)
        if (player.dx != null && player.dy != null && (player.dx !== 0 || player.dy !== 0)) {
          const age = player._updateTime ? Date.now() - player._updateTime : Infinity;
          if (age < ARROW_MAX_AGE) return { dx: player.dx, dy: player.dy };
        }
        // Priority 3: client-detected recent movement (from position tracking useEffect)
        const mov = movMap.get(player.id);
        if (mov && (Date.now() - mov.time < ARROW_MAX_AGE) && (mov.dx !== 0 || mov.dy !== 0)) {
          return { dx: mov.dx, dy: mov.dy };
        }
        return null;
      }

      // Draw arrows for all visible players (below dots so dots stay on top)
      const allDrawable = [
        ...currentPlayers.filter(p => p.id !== NAMRI_ID),
        ...(currentMe ? [currentMe] : []),
      ];
      for (const player of allDrawable) {
        const pos = getDisplayPos(player);
        const wx = pos.x * tileStep;
        const wy = pos.y * tileStep;
        const { x: sx, y: sy } = toScreen(wx, wy);
        if (sx < -80 || sx > w + 80 || sy < -80 || sy > h + 80) continue;
        const arrow = getPlayerArrow(player);
        if (arrow) drawChevron(ctx, sx, sy, arrow.dx, arrow.dy, CHEVRON_COLOR);
      }

      // ─── Players ───
      // Label visibility thresholds
      const LABEL_ZOOM_MIN = 0.7;  // solo label hidden below this zoom
      const showSoloLabels = cam.zoom >= LABEL_ZOOM_MIN;

      // Group close-by players in screen-space so nearby badges/labels collapse instead of overlapping.
      const CLUSTER_SCREEN_R = cam.zoom < 0.7 ? 22 : 16;
      const screenGroups = [];
      for (const player of currentPlayers) {
        if (player.id === NAMRI_ID) continue;
        const pos = getDisplayPos(player);
        const wx = pos.x * tileStep;
        const wy = pos.y * tileStep;
        const { x: sx, y: sy } = toScreen(wx, wy);
        if (sx < -80 || sx > w + 80 || sy < -80 || sy > h + 80) continue;

        let target = null;
        for (const g of screenGroups) {
          if (Math.hypot(sx - g.sx, sy - g.sy) <= CLUSTER_SCREEN_R) { target = g; break; }
        }
        if (target) {
          target.players.push(player);
          const n = target.players.length;
          target.sx += (sx - target.sx) / n;
          target.sy += (sy - target.sy) / n;
        } else {
          screenGroups.push({ players: [player], sx, sy });
        }
      }

      // Precompute bubble dimensions for hit-testing
      const computedBubbles = [];
      const drawnLabelRects = [];
      const collides = (a) => drawnLabelRects.some(b => !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2));

      for (const groupInfo of screenGroups) {
        const group = groupInfo.players;
        if (group.length === 1) {
          // Solo player — dot always, label only when zoomed in/hovered and not colliding
          const player = group[0];
          const sx = groupInfo.sx;
          const sy = groupInfo.sy;

          const dotSize = 6;
          const playerColor = getKingdomColor(player.kingdom_id);

          ctx.save();
          ctx.shadowColor = playerColor;
          ctx.shadowBlur = 7;
          ctx.fillStyle = playerColor;
          ctx.globalAlpha = 0.98;
          ctx.beginPath();
          ctx.arc(sx, sy, dotSize, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = 'rgba(0,0,0,0.55)';
          ctx.stroke();
          ctx.restore();

          const isHoveredSolo = hoveredRef.current?.id === player.id;
          if (showSoloLabels || isHoveredSolo) {
            const fontSize = Math.max(10, Math.min(14, 10 + (cam.zoom - 1) * 2));
            ctx.save();
            ctx.font = `700 ${fontSize}px sans-serif`;
            const textW = ctx.measureText(player.name).width;
            const tx = sx;
            const ty = sy - dotSize - 5;
            const rect = { x1: tx - textW / 2 - 3, y1: ty - fontSize - 3, x2: tx + textW / 2 + 3, y2: ty + 3 };
            const showLabel = isHoveredSolo || !collides(rect);
            if (showLabel) {
              drawnLabelRects.push(rect);
              ctx.fillStyle = '#ffffff';
              ctx.globalAlpha = 1;
              ctx.textAlign = 'center';
              ctx.strokeStyle = 'rgba(0,0,0,0.65)';
              ctx.lineWidth = 3;
              ctx.strokeText(player.name, tx, ty);
              ctx.fillText(player.name, tx, ty);
            }
            ctx.restore();
          }
        } else {
          // Stacked/nearby players — dot + badge always; name panel only on hover
          const sx = groupInfo.sx;
          const sy = groupInfo.sy;
          if (sx < -60 || sx > w + 60 || sy < -60 || sy > h + 60) continue;

          // Single dot — white to indicate mixed kingdoms
          const dotSize = 6;
          ctx.save();
          ctx.shadowColor = '#ffffff';
          ctx.shadowBlur = 8;
          ctx.fillStyle = '#ffffff';
          ctx.globalAlpha = 0.95;
          ctx.beginPath();
          ctx.arc(sx, sy, dotSize, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = 'rgba(0,0,0,0.55)';
          ctx.stroke();
          ctx.restore();

          // Count badge (top-right of dot)
          const badgeR = 7;
          ctx.save();
          ctx.fillStyle = 'rgba(255, 75, 75, 0.9)';
          ctx.beginPath();
          ctx.arc(sx + dotSize - 1, sy - dotSize + 1, badgeR, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = '800 8px sans-serif';
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(group.length), sx + dotSize - 1, sy - dotSize + 1);
          ctx.restore();

          // Names panel — only render when this cluster is hovered
          const hoverInfo = stackedHoverRef.current;
          const thisBubbleIdx = computedBubbles.length; // index this bubble will have
          const isThisPanelHovered = hoverInfo.bubbleIdx === thisBubbleIdx;

          // Always register bubble for hit-testing (dot area), panel dims computed lazily
          const fontSize = Math.max(9, Math.min(12, 9 + (cam.zoom - 1) * 1.5));
          ctx.font = `600 ${fontSize}px sans-serif`;
          const lineH = fontSize + 3;
          const padX = 7, padY = 5;
          let maxTextW = 0;
          for (const p of group) maxTextW = Math.max(maxTextW, ctx.measureText(p.name).width);
          const panelW = maxTextW + padX * 2;
          const panelH = lineH * group.length + padY * 2;
          const gapFromDot = 8;
          const panelX = sx + dotSize + gapFromDot;
          const panelY = sy - panelH / 2;

          const rowPositions = group.map((p, i) => ({
            y: panelY + padY + i * lineH,
            h: lineH,
            player: p,
          }));

          computedBubbles.push({ sx: panelX, sy: panelY, w: panelW, h: panelH, players: group, rowPositions, dotSx: sx, dotSy: sy, dotR: dotSize + badgeR });

          if (!isThisPanelHovered) continue; // collapsed — skip panel draw

          const hoveredRowIdx = hoverInfo.rowIdx;

          // Panel background
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.5)';
          ctx.shadowBlur = 10;
          ctx.shadowOffsetX = 2;
          ctx.shadowOffsetY = 2;
          ctx.fillStyle = 'rgba(10, 11, 16, 0.88)';
          ctx.strokeStyle = 'rgba(255,255,255,0.35)';
          ctx.lineWidth = 1;
          const r = 4;
          ctx.beginPath();
          ctx.moveTo(panelX + r, panelY);
          ctx.lineTo(panelX + panelW - r, panelY);
          ctx.quadraticCurveTo(panelX + panelW, panelY, panelX + panelW, panelY + r);
          ctx.lineTo(panelX + panelW, panelY + panelH - r);
          ctx.quadraticCurveTo(panelX + panelW, panelY + panelH, panelX + panelW - r, panelY + panelH);
          ctx.lineTo(panelX + r, panelY + panelH);
          ctx.quadraticCurveTo(panelX, panelY + panelH, panelX, panelY + panelH - r);
          ctx.lineTo(panelX, panelY + r);
          ctx.quadraticCurveTo(panelX, panelY, panelX + r, panelY);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();

          // Draw names with hover highlight
          ctx.save();
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          for (let i = 0; i < group.length; i++) {
            const p = group[i];
            const isHoveredRow = hoveredRowIdx === i;
            if (isHoveredRow) {
              ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
              ctx.fillRect(panelX + 1, rowPositions[i].y, panelW - 2, rowPositions[i].h);
            }
            const nameColor = getKingdomColor(p.kingdom_id);
            ctx.font = isHoveredRow ? `800 ${fontSize}px sans-serif` : `600 ${fontSize}px sans-serif`;
            ctx.fillStyle = nameColor;
            ctx.globalAlpha = isHoveredRow ? 1 : 0.85;
            ctx.fillText(p.name, panelX + padX, panelY + padY + i * lineH);
          }
          ctx.restore();
        }
      }

      // Save for findPlayerAt hit-testing
      stackedBubblesRef.current = computedBubbles;

      // ─── Namri ───
      if (currentMe) {
        const mePos = getDisplayPos(currentMe);
        const wx = mePos.x * tileStep;
        const wy = mePos.y * tileStep;
        const { x: sx, y: sy } = toScreen(wx, wy);

        const meColor = getKingdomColor(currentMe.kingdom_id);

        // Simple ring
        ctx.save();
        ctx.strokeStyle = meColor;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        ctx.arc(sx, sy, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        // Dot
        ctx.save();
        ctx.shadowColor = meColor;
        ctx.shadowBlur = 10;
        ctx.fillStyle = meColor;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(sx, sy, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.stroke();
        ctx.restore();

        // Label
        ctx.save();
        ctx.font = '800 14px sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 1;
        ctx.textAlign = 'center';
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 3;
        ctx.strokeText('Namri', sx, sy - 20);
        ctx.fillText('Namri', sx, sy - 20);
        ctx.restore();
      }

      // ─── Boss monster markers ───
      const bossPulse = 0.65 + 0.35 * Math.sin(Date.now() / 600);
      for (const boss of BOSS_MARKERS) {
        const wx = boss.x * tileStep;
        const wy = boss.y * tileStep;
        const { x: sx, y: sy } = toScreen(wx, wy);
        if (sx < -80 || sx > w + 80 || sy < -80 || sy > h + 80) continue;

        const sz = boss.primary ? 20 : 14;

        // Outer pulse ring for primary boss
        if (boss.primary) {
          ctx.save();
          ctx.strokeStyle = 'rgba(220, 60, 40, 0.45)';
          ctx.lineWidth = 1;
          ctx.globalAlpha = bossPulse * 0.5;
          ctx.beginPath();
          ctx.arc(sx, sy, sz + 5 + bossPulse * 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }

        // Crosshair marker — pulsing opacity
        ctx.save();
        ctx.strokeStyle = boss.primary ? 'rgba(220, 60, 40, 0.9)' : 'rgba(220, 80, 60, 0.78)';
        ctx.lineWidth = boss.primary ? 2 : 1.5;
        ctx.globalAlpha = boss.primary ? bossPulse : 0.75 + 0.2 * Math.sin(Date.now() / 700 + 1);
        ctx.beginPath();
        ctx.moveTo(sx - sz, sy); ctx.lineTo(sx + sz, sy);
        ctx.moveTo(sx, sy - sz); ctx.lineTo(sx, sy + sz);
        ctx.stroke();
        ctx.restore();

        // Label
        ctx.save();
        const label = boss.name.toUpperCase();
        ctx.font = boss.primary ? '800 12px sans-serif' : '750 10px sans-serif';
        ctx.fillStyle = boss.primary ? '#ff6b5a' : '#e07868';
        ctx.globalAlpha = boss.primary ? 0.95 : 0.82;
        ctx.textAlign = 'center';
        ctx.strokeStyle = 'rgba(0,0,0,0.72)';
        ctx.lineWidth = boss.primary ? 3 : 2.5;
        ctx.strokeText(label, sx, sy - sz - 6);
        ctx.fillText(label, sx, sy - sz - 6);
        ctx.restore();
      }

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [tiles, players, me, toScreen, toWorld]);

  // ─── Mouse hit-test ───
  const findPlayerAt = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const cam = camRef.current;
    const hitR = Math.max(10, 8 * cam.zoom);
    const tileStep = TILE_SIZE_BASE;

    // Read from playerMapRef (real-time) not playersRef (stale batch)
    const pMap = playerMapRef?.current;
    const allPlayers = pMap && pMap.size > 0 ? [...pMap.values()] : playersRef.current;

    // Check Namri first
    const me = pMap?.get(NAMRI_ID) ?? meRef.current;
    if (me) {
      const pos = getDisplayPos(me);
      const wx = pos.x * tileStep;
      const wy = pos.y * tileStep;
      const { x: psx, y: psy } = toScreen(wx, wy);
      if (Math.hypot(sx - psx, sy - psy) < hitR + 6) return me;
    }
    for (const player of allPlayers) {
      if (player.id === NAMRI_ID) continue;
      const pos = getDisplayPos(player);
      const wx = pos.x * tileStep;
      const wy = pos.y * tileStep;
      const { x: psx, y: psy } = toScreen(wx, wy);
      if (Math.hypot(sx - psx, sy - psy) < hitR) return player;
    }
    // Check stacked bubble panels — per-row hit
    for (let bi = 0; bi < stackedBubblesRef.current.length; bi++) {
      const bubble = stackedBubblesRef.current[bi];
      if (sx >= bubble.sx && sx <= bubble.sx + bubble.w && sy >= bubble.sy && sy <= bubble.sy + bubble.h) {
        for (let ri = 0; ri < bubble.rowPositions.length; ri++) {
          const row = bubble.rowPositions[ri];
          if (sy >= row.y && sy <= row.y + row.h) return row.player;
        }
        return bubble.players[0]; // fallback
      }
    }
    return null;
  }, [toScreen, getDisplayPos, playerMapRef]);

  // ─── Handlers ───
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    followingRef.current = false; // break follow on drag
    zoomAnchorRef.current = null; // clear anchor — zoom follows cursor after drag
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, camStartX: camRef.current.offsetX, camStartY: camRef.current.offsetY };
  }, []);

  const handleMouseMove = useCallback((e) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) {
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = toWorld(sx, sy);
      const tileStep = TILE_SIZE_BASE;
      const hq = Math.round(world.x / tileStep);
      const hr = Math.round(world.y / tileStep);
      setMouseHex({ q: hq, r: hr });
    }
    if (dragRef.current.dragging) {
      camRef.current.offsetX = dragRef.current.camStartX + (e.clientX - dragRef.current.startX);
      camRef.current.offsetY = dragRef.current.camStartY + (e.clientY - dragRef.current.startY);
      setHovered(null);
      return;
    }
    // Detect stacked panel row hover — also trigger on cluster dot area
    const rect2 = canvasRef.current?.getBoundingClientRect();
    if (rect2) {
      const msx = e.clientX - rect2.left;
      const msy = e.clientY - rect2.top;
      let foundBubble = -1, foundRow = -1;
      for (let bi = 0; bi < stackedBubblesRef.current.length; bi++) {
        const b = stackedBubblesRef.current[bi];
        // Hit-test: cluster dot area OR expanded panel area
        const onDot = Math.hypot(msx - b.dotSx, msy - b.dotSy) <= (b.dotR ?? 13);
        const onPanel = msx >= b.sx && msx <= b.sx + b.w && msy >= b.sy && msy <= b.sy + b.h;
        if (onDot || onPanel) {
          foundBubble = bi;
          if (onPanel) {
            for (let ri = 0; ri < b.rowPositions.length; ri++) {
              const row = b.rowPositions[ri];
              if (msy >= row.y && msy <= row.y + row.h) { foundRow = ri; break; }
            }
          }
          break;
        }
      }
      const prev = stackedHoverRef.current;
      if (prev.bubbleIdx !== foundBubble || prev.rowIdx !== foundRow) {
        stackedHoverRef.current = { bubbleIdx: foundBubble, rowIdx: foundRow };
        canvasRef.current.style.cursor = foundRow >= 0 ? 'pointer' : (foundBubble >= 0 ? 'default' : 'grab');
      }
    }

    const player = findPlayerAt(e.clientX, e.clientY);
    if (player) { hoveredRef.current = player; setHovered(player); setTooltipPos({ x: e.clientX, y: e.clientY }); }
    else { hoveredRef.current = null; setHovered(null); }
  }, [findPlayerAt, toWorld]);

  const handleMouseUp = useCallback(() => {
    dragRef.current.dragging = false;
    stackedHoverRef.current = { bubbleIdx: -1, rowIdx: -1 };
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
  }, []);

  const handleClick = useCallback((e) => {
    const player = findPlayerAt(e.clientX, e.clientY);
    if (player) {
      setPinned((prev) => {
        if (prev && prev.id === player.id) {
          setInventoryData(null);
          return null;
        }
        return player;
      });
      setTooltipPos({ x: e.clientX, y: e.clientY });
      // Set zoom anchor to clicked player so +/- buttons zoom relative to them
      const pos = getDisplayPos(player);
      zoomAnchorRef.current = { x: pos.x * TILE_SIZE_BASE, y: pos.y * TILE_SIZE_BASE };
    } else {
      setPinned(null);
      setInventoryData(null);
      // Set zoom anchor to clicked tile position
      const rect = canvasRef.current.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = toWorld(sx, sy);
      zoomAnchorRef.current = { x: world.x, y: world.y };
    }
  }, [findPlayerAt, getDisplayPos, toWorld]);

  // Fetch inventory when pinned player changes
  useEffect(() => {
    if (!pinned) { setInventoryData(null); setInventoryLoading(false); return; }
    const cached = inventoryCacheRef.current.get(pinned.id);
    if (cached) { setInventoryData(cached); return; }
    let cancelled = false;
    setInventoryLoading(true);
    setInventoryData(null);
    fetch(`/api/player/${pinned.id}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (cancelled) return;
        if (!data) { setInventoryLoading(false); return; } // clear spinner on non-2xx / empty
        inventoryCacheRef.current.set(pinned.id, data);
        setInventoryData(data);
        setInventoryLoading(false);
      })
      .catch(() => { if (!cancelled) setInventoryLoading(false); });
    return () => { cancelled = true; };
  }, [pinned?.id]);

  const handleDoubleClick = useCallback((e) => {
    const player = findPlayerAt(e.clientX, e.clientY);
    if (player) {
      const pos = getDisplayPos(player);
      const isNamri = player.id === NAMRI_ID;
      centerOn(pos.x * TILE_SIZE_BASE, pos.y * TILE_SIZE_BASE, isNamri);
    }
  }, [findPlayerAt, centerOn, getDisplayPos]);

  const handleWheelRef = useRef(null);

  useEffect(() => {
    handleWheelRef.current = (e) => {
      e.preventDefault();
      const rect = canvasRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const cam = camRef.current;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * factor));

      if (followingRef.current) {
        const meP = playerMapRef?.current?.get(NAMRI_ID) ?? meRef.current;
        if (meP) {
          const pos = getDisplayPos(meP);
          cam.zoom = newZoom;
          cam.offsetX = -pos.x * TILE_SIZE_BASE * cam.zoom;
          cam.offsetY = pos.y * TILE_SIZE_BASE * cam.zoom;
        } else {
          cam.zoom = newZoom;
        }
      } else if (zoomAnchorRef.current) {
        const anchor = zoomAnchorRef.current;
        cam.zoom = newZoom;
        cam.offsetX = -anchor.x * cam.zoom;
        cam.offsetY = anchor.y * cam.zoom;
      } else {
        const { w, h } = sizeRef.current;
        const worldBefore = toWorld(mouseX, mouseY);
        cam.zoom = newZoom;
        cam.offsetX = mouseX - w / 2 - worldBefore.x * cam.zoom;
        cam.offsetY = mouseY - h / 2 - worldBefore.y * cam.zoom;
      }
      setZoomPercent(Math.round(cam.zoom * 100));
    };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e) => handleWheelRef.current?.(e);
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, []);

  const handleCenterNamri = useCallback(() => {
    if (meRef.current) {
      const p = meRef.current;
      const pos = getDisplayPos(p);
      centerOn(pos.x * TILE_SIZE_BASE, pos.y * TILE_SIZE_BASE, true);
    }
  }, [centerOn, getDisplayPos]);

  const handleZoomStep = useCallback((direction) => {
    const cam = camRef.current;
    const factor = direction === 'in' ? 1.12 : 1 / 1.12;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * factor));

    if (followingRef.current) {
      const meP = playerMapRef?.current?.get(NAMRI_ID) ?? meRef.current;
      if (meP) {
        const pos = getDisplayPos(meP);
        cam.zoom = newZoom;
        cam.offsetX = -pos.x * TILE_SIZE_BASE * cam.zoom;
        cam.offsetY = pos.y * TILE_SIZE_BASE * cam.zoom;
      } else {
        cam.zoom = newZoom;
      }
    } else if (zoomAnchorRef.current) {
      const anchor = zoomAnchorRef.current;
      cam.zoom = newZoom;
      cam.offsetX = -anchor.x * cam.zoom;
      cam.offsetY = anchor.y * cam.zoom;
    } else {
      // No anchor — zoom from canvas center
      const { w, h } = sizeRef.current;
      const worldCenter = toWorld(w / 2, h / 2);
      cam.zoom = newZoom;
      cam.offsetX = w / 2 - worldCenter.x * cam.zoom;
      cam.offsetY = h / 2 + worldCenter.y * cam.zoom;
    }
    setZoomPercent(Math.round(cam.zoom * 100));
  }, [toWorld, getDisplayPos]);

  // Touch
  const touchRef = useRef({ lastDist: 0 });
  const handleTouchStart = useCallback((e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      dragRef.current = { dragging: true, startX: t.clientX, startY: t.clientY, camStartX: camRef.current.offsetX, camStartY: camRef.current.offsetY };
    } else if (e.touches.length === 2) {
      touchRef.current.lastDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
  }, []);
  const handleTouchMove = useCallback((e) => {
    e.preventDefault();
    if (e.touches.length === 1 && dragRef.current.dragging) {
      followingRef.current = false; // break follow on touch drag
      zoomAnchorRef.current = null;
      const t = e.touches[0];
      camRef.current.offsetX = dragRef.current.camStartX + (t.clientX - dragRef.current.startX);
      camRef.current.offsetY = dragRef.current.camStartY + (t.clientY - dragRef.current.startY);
    } else if (e.touches.length === 2) {
      const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const factor = dist / (touchRef.current.lastDist || dist);
      const cam = camRef.current;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * factor));

      if (followingRef.current) {
        const meP = playerMapRef?.current?.get(NAMRI_ID) ?? meRef.current;
        if (meP) {
          const pos = getDisplayPos(meP);
          cam.zoom = newZoom;
          cam.offsetX = -pos.x * TILE_SIZE_BASE * cam.zoom;
          cam.offsetY = pos.y * TILE_SIZE_BASE * cam.zoom;
        } else {
          cam.zoom = newZoom;
        }
      } else if (zoomAnchorRef.current) {
        const anchor = zoomAnchorRef.current;
        cam.zoom = newZoom;
        cam.offsetX = -anchor.x * cam.zoom;
        cam.offsetY = anchor.y * cam.zoom;
      } else {
        cam.zoom = newZoom;
      }

      setZoomPercent(Math.round(cam.zoom * 100));
      touchRef.current.lastDist = dist;
    }
  }, [getDisplayPos]);
  const handleTouchEnd = useCallback(() => { dragRef.current.dragging = false; }, []);

  const handleSearchJump = useCallback((x, y) => {
    centerOn(x * TILE_SIZE_BASE, y * TILE_SIZE_BASE, false);
  }, [centerOn]);

  // Read from playerMapRef for search — most up-to-date positions
  const searchPlayers = useCallback(() => {
    const pMap = playerMapRef?.current;
    return pMap && pMap.size > 0 ? [...pMap.values()] : players;
  }, [players, playerMapRef]);

  const activePlayer = pinned || hovered;

  return (
    <div className="map-container" ref={containerRef}>
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ cursor: 'grab', touchAction: 'none' }}
      />
      <SearchBar players={searchPlayers()} me={me} onJump={handleSearchJump} />
      <div className="coords-display">
        ({mouseHex.q}, {mouseHex.r})
      </div>
      <div className="zoom-display">
        <button className="zoom-btn" onClick={() => handleZoomStep('out')} title="Zoom out">−</button>
        <span className="zoom-label">Zoom {zoomPercent}%</span>
        <button className="zoom-btn" onClick={() => handleZoomStep('in')} title="Zoom in">+</button>
      </div>
      {me && (
        <button className="center-btn" onClick={handleCenterNamri}>
          ◎ Namri
        </button>
      )}
      {activePlayer && (
        <Tooltip
          player={activePlayer}
          pos={tooltipPos}
          pinned={!!pinned}
          inventoryData={inventoryData}
          inventoryLoading={inventoryLoading}
        />
      )}
    </div>
  );
}

/* ─── Search Bar ─── */

function SearchBar({ players, me, onJump }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  const allTargets = useCallback(() => {
    const list = [...(players || [])];
    if (me) list.push(me);
    // Add settlements + bosses as searchable
    for (const s of SETTLEMENTS) list.push({ id: `s-${s.id}`, name: s.name, x: s.x, y: s.y, _type: 'settlement' });
    for (const b of BOSS_MARKERS) list.push({ id: `b-${b.id}`, name: b.name, x: b.x, y: b.y, _type: 'boss' });
    return list;
  }, [players, me]);

  const handleChange = useCallback((e) => {
    const q = e.target.value;
    setQuery(q);
    setSelectedIdx(-1);
    if (!q.trim()) { setResults([]); setOpen(false); return; }

    // Coordinate input: "x,y" or "x y"
    const coordMatch = q.trim().match(/^(-?\d+)\s*[,\s]\s*(-?\d+)$/);
    if (coordMatch) {
      const cx = parseInt(coordMatch[1]), cy = parseInt(coordMatch[2]);
      setResults([{ id: '__coord', name: `Go to (${cx}, ${cy})`, x: cx, y: cy, _type: 'coord' }]);
      setOpen(true);
      return;
    }

    const lower = q.toLowerCase();
    const matched = allTargets()
      .filter(t => t.name && t.name.toLowerCase().includes(lower))
      .slice(0, 8);
    setResults(matched);
    setOpen(matched.length > 0);
  }, [allTargets]);

  const jump = useCallback((target) => {
    if (!target) return;
    onJump(target.x, target.y);
    setQuery('');
    setResults([]);
    setOpen(false);
    inputRef.current?.blur();
  }, [onJump]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIdx >= 0 && results[selectedIdx]) jump(results[selectedIdx]);
      else if (results.length > 0) jump(results[0]);
    }
    else if (e.key === 'Escape') { setOpen(false); setQuery(''); inputRef.current?.blur(); }
  }, [results, selectedIdx, jump]);

  return (
    <div className="search-bar">
      <input
        ref={inputRef}
        type="text"
        className="search-input"
        placeholder="Search player, place, or x,y…"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (results.length) setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && results.length > 0 && (
        <div className="search-results">
          {results.map((r, i) => (
            <div
              key={r.id}
              className={`search-result-row ${i === selectedIdx ? 'search-result-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); jump(r); }}
            >
              <span className="search-result-icon">
                {r._type === 'settlement' ? '🏠' : r._type === 'boss' ? '✕' : r._type === 'coord' ? '📍' : '●'}
              </span>
              <span className="search-result-name">{r.name}</span>
              <span className="search-result-pos">({r.x}, {r.y})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Tooltip ─── */

const TIER_COLORS = {
  1: '#8b8b8b', 2: '#6aaa64', 3: '#4a90d9', 4: '#9b59b6',
  5: '#e6a817', 6: '#e05858', 7: '#ff6b5a',
};

function Tooltip({ player, pos, pinned, inventoryData, inventoryLoading }) {
  const ref = useRef(null);
  const [adjusted, setAdjusted] = useState(pos);

  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = pos.x + 14;
    let y = pos.y - 10;
    if (x + rect.width > vw - 10) x = pos.x - rect.width - 14;
    if (y + rect.height > vh - 10) y = pos.y - rect.height - 10;
    if (y < 10) y = 10;
    setAdjusted({ x, y });
  }, [pos.x, pos.y, inventoryData, inventoryLoading]);

  const isNamri = player.id === NAMRI_ID;
  const hp = `${player.hp ?? '?'} / ${player.max_hp ?? '?'}`;

  return (
    <div
      ref={ref}
      className={`tooltip ${pinned ? 'tooltip-pinned' : ''}`}
      style={pinned ? { right: 12, top: 86, maxWidth: 340 } : { left: adjusted.x, top: adjusted.y }}
    >
      <div className="tooltip-name">
        {player.name}
        {isNamri && <span className="badge badge-namri">YOU</span>}
      </div>
      <div className="tooltip-row"><span>Lv</span><strong>{player.level}</strong></div>
      <div className="tooltip-row"><span>Kingdom</span><strong>{['Wild','Sylvanreach','Misthaven','Everfrost','Sunscar'][player.kingdom_id] || '?'}</strong></div>
      <div className="tooltip-row"><span>Pos</span><strong>({player.x}, {player.y})</strong></div>
      <div className="tooltip-row"><span>HP</span><strong>{hp}</strong></div>
      <div className="tooltip-row"><span>Fame</span><strong>{player.fame ?? 0}</strong></div>

      {pinned && (
        <div className="tooltip-inventory">
          {inventoryLoading && <div className="inv-loading">Loading inventory…</div>}
          {inventoryData && <InventoryPanel data={inventoryData} />}
          {!inventoryLoading && !inventoryData && <div className="inv-loading">No data</div>}
        </div>
      )}

      {pinned && <div className="tooltip-hint">Click elsewhere to close</div>}
    </div>
  );
}

function InventoryPanel({ data }) {
  const { wearing, equipped, tools, items, weight, stats } = data;

  return (
    <div className="inv-panel">
      {/* Stats summary */}
      <div className="inv-stats-row">
        <span>ATK {stats?.atk ?? '—'}</span>
        <span>DEF {stats?.def ?? '—'}</span>
        <span>AGI {stats?.agi ?? '—'}</span>
      </div>
      <div className="inv-stats-row">
        <span>Weight {weight?.current ?? '?'}/{weight?.max ?? '?'}</span>
      </div>

      {/* Currently wearing */}
      {wearing && wearing.length > 0 && (
        <div className="inv-section">
          <div className="inv-section-title">🛡 Wearing</div>
          {wearing.map((eq, idx) => (
            <div key={eq.instanceId ?? idx} className="inv-equip-row">
              <span className="inv-slot-label">{eq.slotName}</span>
              <span className="inv-item-name" style={{ color: TIER_COLORS[eq.tier] || '#ccc' }}>
                {eq.name}
              </span>
              {eq.typeName && <span className="inv-type-label">{eq.typeName}</span>}
              {eq.level > 1 && <span className="inv-item-level">+{eq.level}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Equipment in inventory */}
      {equipped && equipped.length > 0 && (
        <div className="inv-section">
          <div className="inv-section-title">⚔ Equipment</div>
          {equipped.map((eq, idx) => (
            <div key={eq.instanceId ?? idx} className="inv-equip-row">
              <span className="inv-slot-label">{eq.slotName}</span>
              <span className="inv-item-name" style={{ color: TIER_COLORS[eq.tier] || '#ccc' }}>
                {eq.name}
              </span>
              {eq.typeName && <span className="inv-type-label">{eq.typeName}</span>}
              {eq.level > 1 && <span className="inv-item-level">+{eq.level}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Tools */}
      {tools && tools.length > 0 && (
        <div className="inv-section">
          <div className="inv-section-title">🔧 Tools</div>
          {tools.map((t) => (
            <div key={t.id} className="inv-equip-row">
              <span className="inv-item-name" style={{ color: TIER_COLORS[t.tier] || '#ccc' }}>
                {t.name}
              </span>
              <span className="inv-durability">dur {t.durability}</span>
            </div>
          ))}
        </div>
      )}

      {/* Items */}
      {items && items.length > 0 && (
        <div className="inv-section">
          <div className="inv-section-title">🎒 Items</div>
          {items.map((i) => (
            <div key={i.id} className="inv-equip-row">
              <span className="inv-item-name" style={{ color: TIER_COLORS[i.tier] || '#ccc' }}>
                {i.name}
              </span>
              <span className="inv-item-amount">×{i.amount}</span>
            </div>
          ))}
        </div>
      )}

      {(!equipped || equipped.length === 0) && (!tools || tools.length === 0) && (!items || items.length === 0) && (
        <div className="inv-loading">Empty inventory</div>
      )}
    </div>
  );
}

/* ─── Stats Panel ─── */

function StatsPanel({ players, me, status, connected, lastEventAt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ageSec = lastEventAt ? Math.floor((now - lastEventAt) / 1000) : null;
  const stale = connected && ageSec != null && ageSec > 30;
  const liveClass = connected ? (stale ? 'live-stale' : 'live-on') : 'live-off';
  const liveText = connected ? (stale ? `● Stale ${ageSec}s` : '● SSE') : '○ Reconnecting…';

  return (
    <div className="stats-panel">
      <div className="stat-row" title="Players active within the last 24 hours (not necessarily online right now)"><span>Active 24h</span><strong>{players.length}</strong></div>
      <div className="stat-row"><span>Tiles</span><strong>{status?.tilesScanned ?? 0}</strong></div>
      <div className="stat-row"><span>Namri</span><strong>{me ? `(${me.x}, ${me.y})` : '…'}</strong></div>
      <div className="stat-row"><span>Live</span><strong className={liveClass}>{liveText}</strong></div>
    </div>
  );
}

/* ─── Legend ─── */

function Legend() {
  return (
    <div className="legend">
      <div className="legend-row">
        <span className="legend-dot" style={{ background: KINGDOM_COLORS[3] }} />
        <span>Everfrost</span>
      </div>
      <div className="legend-row">
        <span className="legend-dot" style={{ background: KINGDOM_COLORS[1] }} />
        <span>Sylvanreach</span>
      </div>
      <div className="legend-row">
        <span className="legend-dot" style={{ background: KINGDOM_COLORS[2] }} />
        <span>Misthaven</span>
      </div>
      <div className="legend-row">
        <span className="legend-dot" style={{ background: KINGDOM_COLORS[4] }} />
        <span>Sunscar</span>
      </div>
      <div className="legend-row legend-sep">
        <span className="legend-shape legend-dz" />
        <span>Death zone</span>
      </div>
      <div className="legend-row">
        <span className="legend-shape legend-boss" />
        <span>Boss</span>
      </div>
      <div className="legend-row">
        <span className="legend-shape legend-settle" />
        <span>Settlement</span>
      </div>
    </div>
  );
}

function CombatEvents({ events }) {
  return <div className="combat-events"><div className="combat-events-title">Events</div>{events.slice(0, 8).map((event) => {
    const defeated = event.hps?.some((hp) => hp === 0);
    const attacker = event.attacker_name || `#${event.attacker_id}`;
    const defender = event.defender_name || `#${event.defender_id}`;
    const hp = event.hps?.[1] ?? null;
    const time = event.timestamp ? new Date(event.timestamp * 1000).toLocaleTimeString() : '—';
    return <div className="combat-event" key={event.id}><span className="combat-event-time">{time}</span><span>{defeated ? '🩸' : '⚔️'} {attacker} {defeated ? 'pwned' : 'attacked'} {defender}{hp != null ? ` (${hp} HP)` : ''}</span>{event.location && <span className="combat-event-location">@ {event.location.x},{event.location.y}</span>}</div>;
  })}</div>;
}

/* ─── App ─── */

function App() {
  const { players, me, status, tiles, combatEvents, error, connected, lastEventAt, playerMapRef } = useRadarData();

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="title-block">
          <h1>FTK RADAR</h1>
        </div>
      </header>

      {error && <div className="error">⚠ {error}</div>}

      <section className="map-card">
        <GameMap players={players} me={me} tiles={tiles} playerMapRef={playerMapRef} />
        <StatsPanel players={players} me={me} status={status} connected={connected} lastEventAt={lastEventAt} />
        <Legend />
        <CombatEvents events={combatEvents} />
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
