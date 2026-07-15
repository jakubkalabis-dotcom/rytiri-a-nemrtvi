/* ============================================================================
   RYTÍŘI A NEMRTVÍ — engine (jádro nezávislé na konkrétní herní logice)
   Grid + flow-field pathfinding, spatial hash, object pooly, kamera, kolizní
   helpery, audio syntéza, persistence, fitCanvas. Čte konstanty z data.js.
   ========================================================================== */

/* ---------- Plátno ---------- */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;   // 480 × 800
// zaoblený obdélník + výplň (helper pro hladké tvary entit)
function rrect(x, y, w, h, r, col) { if (col) ctx.fillStyle = col; roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); ctx.fill(); }

/* ---------- Viditelné hlášení chyb (diagnostika na mobilu) ---------- */
function showFatal(msg) {
  let d = document.getElementById('errbox');
  if (!d) {
    d = document.createElement('div');
    d.id = 'errbox';
    d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:45%;overflow:auto;'
      + 'background:#3a0d18;color:#ffd0d8;font:12px monospace;padding:10px;z-index:9999;white-space:pre-wrap;';
    document.body.appendChild(d);
  }
  d.textContent = 'CHYBA: ' + msg;
}
window.addEventListener('error', e => showFatal((e.message || 'neznámá') + '  @řádek ' + (e.lineno || '?')));
window.addEventListener('unhandledrejection', e => showFatal('promise: ' + ((e.reason && e.reason.message) || e.reason)));

/* ---------- Kreslicí helpery ---------- */
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
// Kolize dvou kruhových entit (mají .x,.y,.r)
function hitCircle(a, b, extra = 0) {
  const dx = a.x - b.x, dy = a.y - b.y, rr = a.r + b.r + extra;
  return dx * dx + dy * dy < rr * rr;
}
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* ---------- Kamera (pro MVP statická, připravená na scrollování) ---------- */
const camera = { x: 0, y: 0, zoom: 1 };
function applyCamera() { ctx.translate(-Math.round(camera.x), -Math.round(camera.y)); }
function screenToWorld(sx, sy) { return { x: sx + camera.x, y: sy + camera.y }; }
// Kamera plynule sleduje cíl (střed hráče) a je omezená na hranice mapy.
function updateCamera(tx, ty, dt, snap) {
  const gx = clamp(tx - VIEWW / 2, 0, Math.max(0, ARENA_W - VIEWW));
  const gy = clamp(ty - VIEWH / 2, 0, Math.max(0, ARENA_H - VIEWH));
  if (snap) { camera.x = gx; camera.y = gy; }
  else { const k = Math.min(1, 0.15 * (dt || 1)); camera.x += (gx - camera.x) * k; camera.y += (gy - camera.y) * k; }
}
// Je bod na obrazovce (s okrajem)? Pro culling.
function onScreen(x, y, m) { m = m || 40; return x > camera.x - m && x < camera.x + VIEWW + m && y > camera.y - m && y < camera.y + VIEWH + m; }
// Udrž kameru v hranicích mapy (po ručním posunu ve fázi stavění).
function clampCamera() { camera.x = clamp(camera.x, 0, Math.max(0, ARENA_W - VIEWW)); camera.y = clamp(camera.y, 0, Math.max(0, ARENA_H - VIEWH)); }

/* ---------- Mřížka / dlaždice ---------- */
// tiles: 0 = tráva, 1 = statická překážka. structures[i] = objekt zdi/null.
const grid = {
  tiles: new Uint8Array(COLS * ROWS),
  structures: new Array(COLS * ROWS).fill(null),
  coreTiles: [],
};
// Přenačte mapu i: rozměry, pole, překážky, terén. (0-based index.)
function loadMap(i) {
  currentMap = clampIdx(i);
  applyMapDims(currentMap);
  const n = COLS * ROWS;
  grid.tiles = new Uint8Array(n);
  grid.structures = new Array(n).fill(null);
  flowDist = new Float32Array(n); flowX = new Float32Array(n); flowY = new Float32Array(n); _bfsQueue = new Int32Array(n);
  genObstacles(MAPS[currentMap].seed, currentMap);
  buildArena();
  flowDirty = true;
}
// Boční barikády (koridor uprostřed) + chokepointy uvnitř; roste s pořadím mapy.
function genObstacles(seed, mapIdx) {
  const rnd = mulberry32(seed);
  OBSTACLES = [];
  const blocked = new Set();
  const key = (tx, ty) => tx + ',' + ty;
  const isCore = (tx, ty) => tx >= CORE.tx - 1 && tx <= CORE.tx + CORE.w && ty >= CORE.ty - 1 && ty <= CORE.ty + CORE.h;
  const addRaw = (tx, ty) => { if (!inBounds(tx, ty) || isCore(tx, ty) || blocked.has(key(tx, ty))) return; blocked.add(key(tx, ty)); OBSTACLES.push([tx, ty]); };
  const side = corridorSide();
  const L = side, R = COLS - side - 1;                 // průchozí koridor = sloupce [L..R]
  // BOČNÍ BARIKÁDY — plné sloupce po stranách (nedá se tudy chodit)
  for (let ty = 0; ty < ROWS; ty++) { for (let tx = 0; tx < L; tx++) addRaw(tx, ty); for (let tx = R + 1; tx < COLS; tx++) addRaw(tx, ty); }
  const put = (tx, ty) => { if (tx < L || tx > R || ty < 2 || ty >= ROWS - 3) return; addRaw(tx, ty); };
  // vodorovné hradby v koridoru s mezerou (chokepoint)
  const bands = 2 + Math.min(4, Math.floor(mapIdx / 2));
  for (let b = 0; b < bands; b++) {
    const ty = 3 + Math.floor((ROWS - 8) * (b + 1) / (bands + 1)) + Math.floor((rnd() - 0.5) * 2);
    const gapCols = new Set(); const gaps = 1 + Math.floor(rnd() * 2);
    for (let g = 0; g < gaps; g++) gapCols.add(L + Math.floor(rnd() * (R - L + 1)));
    for (let tx = L; tx <= R; tx++) { let near = false; for (const gc of gapCols) if (Math.abs(tx - gc) <= 1) near = true; if (!near && rnd() < 0.8) put(tx, ty); }
  }
  // shluky balvanů v koridoru
  const clusters = 2 + Math.floor(mapIdx / 3) + Math.floor(rnd() * 2);
  for (let c = 0; c < clusters; c++) {
    const cx = L + Math.floor(rnd() * (R - L + 1)), cy = 3 + Math.floor(rnd() * (ROWS - 8)), s = 1 + Math.floor(rnd() * 2);
    for (let dx = 0; dx <= s; dx++) for (let dy = 0; dy <= s; dy++) if (rnd() < 0.55) put(cx + dx, cy + dy);
  }
}
function tileIndex(tx, ty) { return ty * COLS + tx; }
function inBounds(tx, ty) { return tx >= 0 && ty >= 0 && tx < COLS && ty < ROWS; }
function tileOf(x, y) { return { tx: Math.floor(x / TILE), ty: Math.floor(y / TILE) }; }
// Blokuje daná stavba pohyb? Věže (EMITTER) jsou PRŮCHOZÍ — jen zdi/barikády blokují.
function structBlocks(o) { return !!o && !(o.def && o.def.arch === 'EMITTER'); }
// Blokuje pohyb? (mimo mapu / překážka / blokující zeď — věže NE)
function isBlocked(tx, ty) {
  if (!inBounds(tx, ty)) return true;
  const i = tileIndex(tx, ty);
  return grid.tiles[i] === 1 || structBlocks(grid.structures[i]);
}
// Blokuje střely? (překážka nebo zeď s blocksProj)
function blocksProjectile(tx, ty) {
  if (!inBounds(tx, ty)) return false;
  const i = tileIndex(tx, ty);
  if (grid.tiles[i] === 1) return true;
  const s = grid.structures[i];
  return !!(s && s.def.blocksProj);
}
function buildArena() {
  grid.tiles.fill(0);
  grid.structures.fill(null);
  for (const [tx, ty] of OBSTACLES) if (inBounds(tx, ty)) grid.tiles[tileIndex(tx, ty)] = 1;
  grid.coreTiles = [];
  for (let dy = 0; dy < CORE.h; dy++)
    for (let dx = 0; dx < CORE.w; dx++)
      grid.coreTiles.push(tileIndex(CORE.tx + dx, CORE.ty + dy));
  buildTerrain();
}

/* ---------- Procedurální terén (offscreen cache) ---------- */
// Deterministický PRNG, aby dekorace seděly stejně u hostitele i guesta.
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let terrainCanvas = null, decor = [];
function buildTerrain() {
  const rnd = mulberry32(20260712);
  // dekorace na volných dlaždicích
  decor = [];
  for (let ty = 0; ty < ROWS; ty++) for (let tx = 0; tx < COLS; tx++) {
    const i = tileIndex(tx, ty);
    if (grid.tiles[i] === 1) continue;
    const isCore = tx >= CORE.tx && tx < CORE.tx + CORE.w && ty >= CORE.ty && ty < CORE.ty + CORE.h;
    if (isCore) continue;
    const r = rnd();
    const x = (tx + rnd()) * TILE, y = (ty + rnd()) * TILE;
    if (r < 0.05 && (ty < 3 || tx < 2 || tx > COLS - 3)) decor.push({ t: 'tree', x, y, s: 9 + rnd() * 5 });
    else if (r < 0.12) decor.push({ t: 'bush', x, y, s: 4 + rnd() * 3 });
    else if (r < 0.30) decor.push({ t: 'tuft', x, y, s: 3 + rnd() * 2, d: rnd() });
    else if (r < 0.36) decor.push({ t: 'flower', x, y, hue: (rnd() * 360) | 0 });
    else if (r < 0.40) decor.push({ t: 'pebble', x, y, s: 2 + rnd() * 2 });
  }
  // render do offscreen (velikost dle aktuální mapy)
  let cnv = terrainCanvas;
  if (!cnv) { cnv = document.createElement('canvas'); terrainCanvas = cnv; }
  cnv.width = ARENA_W; cnv.height = ARENA_H;
  const g = cnv.getContext('2d');
  g.clearRect(0, 0, ARENA_W, ARENA_H);
  const pal = (MAPS[currentMap] && MAPS[currentMap].pal) || ['#284020', '#2c4224', '#5a5f66', '#3f7030'];
  const c0 = hexRGB(pal[0]), c1 = hexRGB(pal[1]), acc = hexRGB(pal[3]);
  const CP = 4, N = TILE / CP;   // 4px „pixely" → 8×8 na dlaždici
  const lerp = (a, b, t) => a + (b - a) * t;
  for (let ty = 0; ty < ROWS; ty++) for (let tx = 0; tx < COLS; tx++) {
    const ox = tx * TILE, oy = ty * TILE;
    // hladká nízkofrekvenční variace mezi c0/c1 → organické skvrny, ŽÁDNÁ šachovnice
    const nv = clamp((Math.sin(tx * 0.55 + ty * 0.17) * 0.5 + 0.5) * 0.55 + (Math.sin(ty * 0.5 - tx * 0.23 + 1.3) * 0.5 + 0.5) * 0.45, 0, 1);
    const base = [lerp(c0[0], c1[0], nv) | 0, lerp(c0[1], c1[1], nv) | 0, lerp(c0[2], c1[2], nv) | 0];
    g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`; g.fillRect(ox, oy, TILE, TILE);
    // jemná organická textura (pár tmavších/světlejších/akcentních pixelů)
    const rs = mulberry32(((tx * 92821) ^ (ty * 68917) ^ (currentMap * 40503)) >>> 0);
    for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
      const v = rs(); if (v < 0.70) continue;
      let r = base[0], gg = base[1], b = base[2];
      if (v > 0.965) { r = acc[0]; gg = acc[1]; b = acc[2]; }        // stéblo/akcent
      else { const j = v > 0.85 ? 10 : -13; r += j; gg += j; b += j; }
      g.fillStyle = `rgb(${clamp(r, 0, 255)},${clamp(gg, 0, 255)},${clamp(b, 0, 255)})`;
      g.fillRect(ox + gx * CP, oy + gy * CP, CP, CP);
    }
  }
  for (const d of decor) terrainDecor(g, d, pal);
  for (const [tx, ty] of OBSTACLES) terrainRock(g, tx, ty, pal);
  // mlha / atmosféra biomu
  const fog = MAPS[currentMap] && MAPS[currentMap].fog;
  if (fog) { g.fillStyle = fog; g.fillRect(0, 0, ARENA_W, ARENA_H); }
}
function hexRGB(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
function terrainDecor(g, d, pal) {
  const acc = pal[3] || '#3f7030'; const ac = hexRGB(acc);
  const dark = `rgb(${clamp(ac[0] - 28, 0, 255)},${clamp(ac[1] - 28, 0, 255)},${clamp(ac[2] - 28, 0, 255)})`;
  const X = d.x | 0, Y = d.y | 0;
  if (d.t === 'tuft') {
    g.fillStyle = acc; g.fillRect(X - 3, Y - 2, 2, 4); g.fillRect(X, Y - 4, 2, 6); g.fillRect(X + 3, Y - 2, 2, 4);
  } else if (d.t === 'flower') {
    g.fillStyle = dark; g.fillRect(X, Y - 2, 2, 4);
    g.fillStyle = `hsl(${d.hue},70%,62%)`; g.fillRect(X - 2, Y - 6, 6, 4); g.fillStyle = '#ffe860'; g.fillRect(X, Y - 4, 2, 2);
  } else if (d.t === 'pebble') {
    g.fillStyle = pal[2]; g.fillRect(X - 2, Y - 2, 5, 4);
  } else if (d.t === 'bush') {
    const s = Math.round(d.s); g.fillStyle = dark; g.fillRect(X - s, Y - s, s * 2, s * 2);
    g.fillStyle = acc; g.fillRect(X - s + 2, Y - s + 2, s * 2 - 4, s * 2 - 4);
  } else if (d.t === 'tree') {
    const s = Math.round(d.s);
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(X - s, Y + s - 2, s * 2, 5);              // stín
    g.fillStyle = '#4a3018'; g.fillRect(X - 2, Y - 2, 5, s + 4);                            // kmen
    g.fillStyle = dark; g.fillRect(X - s, Y - s * 2, s * 2, s * 2);                          // koruna (blok)
    g.fillStyle = acc; g.fillRect(X - s + 3, Y - s * 2 + 3, s * 2 - 6, s * 2 - 6);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(X - s + 3, Y - s * 2 + 3, 4, 4);      // lesk
  }
}
function terrainRock(g, tx, ty, pal) {
  const x = tx * TILE, y = ty * TILE; const c = hexRGB(pal[2] || '#5a5f66');
  const CP = 4, N = TILE / CP;
  const rs = mulberry32(((tx * 12347) ^ (ty * 65413)) >>> 0);
  for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
    const v = rs(); const j = Math.floor((v - 0.5) * 30);
    // spáry dlažby (tmavší mřížka)
    const seam = (gx % 4 === 0 || gy % 4 === 0);
    const k = seam ? -34 : j;
    g.fillStyle = `rgb(${clamp(c[0] + k, 0, 255)},${clamp(c[1] + k, 0, 255)},${clamp(c[2] + k, 0, 255)})`;
    g.fillRect(x + gx * CP, y + gy * CP, CP, CP);
  }
}
// roundRect na libovolný ctx
function roundRectOn(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
// stín pod entitou
function drawShadow(x, y, r) {
  const cy = y + r * 0.72;   // měkký dvouvrstvý stín (líp ukotví postavu na tmavé zemi)
  ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.beginPath(); ctx.ellipse(x, cy, r * 1.18, r * 0.52, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.26)'; ctx.beginPath(); ctx.ellipse(x, cy, r * 0.8, r * 0.36, 0, 0, Math.PI * 2); ctx.fill();
}
// Rim-light shora (jednotné světlo měsíce) — tenký světelný okraj, aby postava vystoupla z tmy.
function rimLight(x, y, r) {
  ctx.strokeStyle = 'rgba(255,238,206,0.28)'; ctx.lineWidth = Math.max(1.5, r * 0.13);
  ctx.beginPath(); ctx.arc(x, y, r * 0.66, Math.PI * 1.16, Math.PI * 1.84); ctx.stroke();
}

/* ---------- Flow-field pathfinding (BFS distanční pole od jádra) ---------- */
// dist = počet kroků do jádra; flowX/flowY = jednotkový vektor k dalšímu kroku.
let flowDirty = true;
let flowDist = new Float32Array(COLS * ROWS);
let flowX = new Float32Array(COLS * ROWS);
let flowY = new Float32Array(COLS * ROWS);
let _bfsQueue = new Int32Array(COLS * ROWS);
const NEI = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

function buildFlowField() {
  flowDist.fill(Infinity);
  let head = 0, tail = 0;
  for (const ci of grid.coreTiles) {
    if (structBlocks(grid.structures[ci]) || grid.tiles[ci] === 1) continue;   // věže jsou průchozí
    flowDist[ci] = 0;
    _bfsQueue[tail++] = ci;
  }
  while (head < tail) {
    const i = _bfsQueue[head++];
    const tx = i % COLS, ty = (i / COLS) | 0;
    const nd = flowDist[i] + 1;
    for (let k = 0; k < 4; k++) {           // 4-směr pro pole (diagonály řeší steering)
      const nx = tx + NEI[k][0], ny = ty + NEI[k][1];
      if (!inBounds(nx, ny)) continue;
      const ni = tileIndex(nx, ny);
      if (isBlocked(nx, ny)) continue;
      if (nd < flowDist[ni]) { flowDist[ni] = nd; _bfsQueue[tail++] = ni; }
    }
  }
  // Z distančního pole spočítej směr k sousedovi s nejnižší vzdáleností (8 směrů).
  for (let ty = 0; ty < ROWS; ty++) {
    for (let tx = 0; tx < COLS; tx++) {
      const i = tileIndex(tx, ty);
      flowX[i] = 0; flowY[i] = 0;
      if (!isFinite(flowDist[i])) continue;
      let best = flowDist[i], bx = 0, by = 0;
      for (let k = 0; k < 8; k++) {
        const nx = tx + NEI[k][0], ny = ty + NEI[k][1];
        if (!inBounds(nx, ny) || isBlocked(nx, ny)) continue;
        // diagonálu povol jen když nesekáme roh o překážku
        if (NEI[k][0] !== 0 && NEI[k][1] !== 0) {
          if (isBlocked(tx + NEI[k][0], ty) || isBlocked(tx, ty + NEI[k][1])) continue;
        }
        const d = flowDist[tileIndex(nx, ny)];
        if (d < best) { best = d; bx = NEI[k][0]; by = NEI[k][1]; }
      }
      const len = Math.hypot(bx, by) || 1;
      flowX[i] = bx / len; flowY[i] = by / len;
    }
  }
  flowDirty = false;
}
// Vrátí směrový vektor k jádru pro světovou pozici (nebo {x:0,y:0} = bez cesty).
function sampleFlow(x, y) {
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  if (!inBounds(tx, ty)) return { x: 0, y: 0 };
  const i = tileIndex(tx, ty);
  return { x: flowX[i], y: flowY[i], reachable: isFinite(flowDist[i]) };
}
// Ověří (na kopii mřížky), že by položení zdi na [tx,ty] nezapečetilo jádro.
function pathExistsWith(blockTx, blockTy) {
  const seen = new Uint8Array(COLS * ROWS);
  let head = 0, tail = 0;
  for (const ci of grid.coreTiles) {
    if (ci === tileIndex(blockTx, blockTy)) continue;
    if (grid.tiles[ci] === 1 || structBlocks(grid.structures[ci])) continue;
    seen[ci] = 1; _bfsQueue[tail++] = ci;
  }
  while (head < tail) {
    const cur = _bfsQueue[head++];
    const tx = cur % COLS, ty = (cur / COLS) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = tx + NEI[k][0], ny = ty + NEI[k][1];
      if (!inBounds(nx, ny)) continue;
      const ni = tileIndex(nx, ny);
      if (seen[ni]) continue;
      if (nx === blockTx && ny === blockTy) continue;
      if (isBlocked(nx, ny)) continue;
      seen[ni] = 1; _bfsQueue[tail++] = ni;
    }
  }
  // dosažitelný alespoň jeden spawn?
  for (const s of SPAWNS) {
    const stx = clamp(Math.floor(s.x / TILE), 0, COLS - 1);
    const sty = clamp(Math.floor(s.y / TILE), 0, ROWS - 1);
    if (seen[tileIndex(stx, sty)]) return true;
  }
  return false;
}

/* ---------- Spatial hash (dynamické entity) ---------- */
function SpatialHash(cell) {
  this.cell = cell; this.map = new Map();
}
SpatialHash.prototype.key = function (cx, cy) { return cx + ',' + cy; };
SpatialHash.prototype.clear = function () { this.map.clear(); };
SpatialHash.prototype.insert = function (e) {
  const cx = Math.floor(e.x / this.cell), cy = Math.floor(e.y / this.cell);
  const k = this.key(cx, cy);
  let arr = this.map.get(k);
  if (!arr) { arr = []; this.map.set(k, arr); }
  arr.push(e);
};
// Vrátí kandidáty v okolí (x,y) do poloměru r (buňka + sousedé).
SpatialHash.prototype.query = function (x, y, r) {
  const out = [];
  const minx = Math.floor((x - r) / this.cell), maxx = Math.floor((x + r) / this.cell);
  const miny = Math.floor((y - r) / this.cell), maxy = Math.floor((y + r) / this.cell);
  for (let cx = minx; cx <= maxx; cx++)
    for (let cy = miny; cy <= maxy; cy++) {
      const arr = this.map.get(this.key(cx, cy));
      if (arr) for (const e of arr) out.push(e);
    }
  return out;
};
const enemyHash = new SpatialHash(TILE);

/* ---------- Object pool ---------- */
function Pool(factory, reset) {
  this.factory = factory; this.reset = reset; this.free = []; this.active = [];
}
Pool.prototype.acquire = function () {
  const o = this.free.pop() || this.factory();
  o.dead = false;
  this.active.push(o);
  return o;
};
Pool.prototype.sweep = function () {
  // přesun mrtvých zpět do free-listu (bez alokace nového pole)
  let n = 0;
  for (let i = 0; i < this.active.length; i++) {
    const o = this.active[i];
    if (o.dead) { if (this.reset) this.reset(o); this.free.push(o); }
    else this.active[n++] = o;
  }
  this.active.length = n;
};

/* ---------- Audio: procedurální syntéza s master řetězcem (reverb + kompresor) ----------
   Cíl: „moderní" prostor a hloubka místo holých pípání. Vše se sbíhá do masteru,
   ten jde přes paralelní reverb a kompresor na výstup. Ambientní dron dělá atmosféru.   */
let actx = null, muted = false, noiseBuf = null, master = null, compNode = null;
function makeImpulse(dur, decay) {
  const rate = actx.sampleRate, len = Math.max(1, Math.floor(rate * dur)), buf = actx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
  return buf;
}
function initAudio() {
  try {
    if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    actx = new AC();
    const len = Math.floor(actx.sampleRate * 0.6);
    noiseBuf = actx.createBuffer(1, len, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    master = actx.createGain(); master.gain.value = 0.82;
    try {
      compNode = actx.createDynamicsCompressor();
      compNode.threshold.value = -16; compNode.knee.value = 22; compNode.ratio.value = 3.2; compNode.attack.value = 0.003; compNode.release.value = 0.2;
      master.connect(compNode); compNode.connect(actx.destination);
      try {   // paralelní reverb (hloubka/prostor)
        const conv = actx.createConvolver(); conv.buffer = makeImpulse(1.7, 3.4);
        const send = actx.createGain(); send.gain.value = 0.17;
        master.connect(send); send.connect(conv); conv.connect(compNode);
      } catch (e) {}
    } catch (e) { master.connect(actx.destination); }   // fallback bez kompresoru
  } catch (err) { actx = null; noiseBuf = null; master = null; }
}
function out() { return master || (actx && actx.destination); }
// tón s krátkým náběhem (bez lupnutí) + volitelný sklouznutí frekvence
function tone(freq, dur, type = 'square', vol = 0.15, slideTo = null) {
  if (!actx || muted) return;
  const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out()); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol = 0.3, filterFreq = 900, hp = 0, filterEnd = 0) {
  if (!actx || muted) return;
  const t = actx.currentTime, s = actx.createBufferSource(); s.buffer = noiseBuf;
  const g = actx.createGain(), f = actx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.setValueAtTime(filterFreq, t);
  if (filterEnd) f.frequency.exponentialRampToValueAtTime(Math.max(60, filterEnd), t + dur);   // sweep = „whoosh"
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let chain = s.connect(f);
  if (hp) { const h = actx.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = hp; chain = chain.connect(h); }
  chain.connect(g).connect(out()); s.start(t); s.stop(t + dur);
}
// akord (více tónů naráz) — pro příjemné UI/level-up zvuky
function chord(freqs, dur, type = 'triangle', vol = 0.1, slide = null) { for (const f of freqs) tone(f, dur, type, vol, slide); }
const sfx = {
  // SEK MEČEM — svištivý whoosh (padající sweep) + kovový svist
  swing()     { noise(0.17, 0.22, 4200, 300, 700); tone(1250, 0.07, 'triangle', 0.05, 480); },
  bow()       { noise(0.05, 0.08, 6000, 2500); tone(560, 0.11, 'triangle', 0.07, 260); },       // luk: tětiva + let šípu
  crossbow()  { tone(340, 0.06, 'square', 0.09, 140); noise(0.07, 0.11, 5000, 1800, 900); },     // kuše: cvak
  gun()       { noise(0.03, 0.6, 7000, 1500); noise(0.3, 0.5, 1300, 0, 400); tone(80, 0.26, 'sawtooth', 0.2, 34); },  // rána: klik+výšleh+dunění
  magic()     { tone(520, 0.18, 'sine', 0.09, 1500); tone(1040, 0.16, 'sine', 0.045, 2400); noise(0.1, 0.05, 6000, 3000); },  // třpyt
  throwsnd()  { noise(0.11, 0.14, 3600, 700, 1200); },                                            // hod: krátký whoosh
  boom()      { tone(150, 0.55, 'sawtooth', 0.2, 34); tone(75, 0.6, 'sine', 0.18, 28); noise(0.55, 0.5, 900, 0, 200); noise(0.05, 0.45, 6000, 1800); },
  // MASITÝ ZÁSAH — tupá rána do těla + čvachtnutí
  hitFlesh()  { noise(0.11, 0.28, 520, 90); tone(130, 0.1, 'sine', 0.09, 62); tone(320, 0.05, 'triangle', 0.03, 150); },
  // SMRT MOBA — čvachtavý splat + nízké klesnutí
  enemyDie()  { noise(0.22, 0.3, 850, 120, 260); tone(115, 0.18, 'sawtooth', 0.09, 44); tone(360, 0.09, 'sine', 0.05, 90); },
  // GROWL zombie — chraplavý mrtvolný sten
  groan()     { tone(78, 0.5, 'sawtooth', 0.07, 52); tone(117, 0.46, 'sawtooth', 0.04, 80); tone(60, 0.55, 'sine', 0.05, 44); noise(0.4, 0.05, 500, 80); },
  growl()     { tone(90 + Math.random() * 20, 0.32, 'sawtooth', 0.055, 60); noise(0.28, 0.04, 420, 70); },  // krátký vrčivý dech (spawn mobů)
  place()     { tone(210, 0.08, 'square', 0.1); setTimeout(() => tone(330, 0.09, 'square', 0.1), 60); noise(0.06, 0.12, 2200, 400); },  // tesání/úder kladiva
  buy()       { chord([523, 784], 0.1, 'triangle', 0.09); setTimeout(() => chord([659, 988], 0.14, 'triangle', 0.09), 85); },
  coreHit()   { tone(170, 0.36, 'sawtooth', 0.2, 55); noise(0.32, 0.26, 440, 0, 160); tone(66, 0.42, 'sine', 0.13, 38); },  // náraz do brány
  waveStart() { chord([294, 370], 0.16, 'triangle', 0.11); setTimeout(() => chord([392, 494], 0.16, 'triangle', 0.11), 130); setTimeout(() => chord([587, 740], 0.26, 'triangle', 0.12), 260); },
  waveWin()   { chord([523, 659], 0.14, 'triangle', 0.12); setTimeout(() => chord([659, 831], 0.14, 'triangle', 0.12), 120); setTimeout(() => chord([784, 1047], 0.28, 'triangle', 0.13), 240); },
  boss()      { tone(56, 1.0, 'sawtooth', 0.22, 38); tone(84, 0.95, 'sawtooth', 0.12, 52); tone(40, 1.1, 'sine', 0.17, 28); noise(1.0, 0.16, 320, 0, 120); tone(210, 0.9, 'sine', 0.05, 800); },
  hurt()      { tone(190, 0.24, 'square', 0.15, 56); noise(0.2, 0.24, 600, 180); tone(150, 0.14, 'sawtooth', 0.05, 80); },
  gameOver()  { chord([330, 415], 0.5, 'sawtooth', 0.16, 220); setTimeout(() => chord([165, 208], 0.8, 'sawtooth', 0.16, 120), 260); },
  heal()      { chord([659, 988], 0.12, 'sine', 0.08); setTimeout(() => chord([880, 1319], 0.18, 'sine', 0.08), 90); },
  levelUp()   { chord([523, 659], 0.1, 'triangle', 0.12); setTimeout(() => chord([659, 784], 0.1, 'triangle', 0.12), 90); setTimeout(() => chord([1047, 1319], 0.24, 'triangle', 0.13), 180); },
};
/* ---------- Ambientní dron (nízký evolující pad během běhu) ---------- */
let droneNodes = null;
function startDrone() {
  if (!actx || muted || droneNodes || !out()) return;
  try {
    const t = actx.currentTime, g = actx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.045, t + 2.5);
    const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380; f.Q.value = 2;
    const lfo = actx.createOscillator(), lfog = actx.createGain(); lfo.frequency.value = 0.05; lfog.gain.value = 200; lfo.connect(lfog); lfog.connect(f.frequency); lfo.start(t);
    const oscs = [];
    for (const [fr, ty, det] of [[55, 'sawtooth', 0], [55, 'sawtooth', 7], [82.41, 'triangle', -5], [110, 'sine', 3]]) { const o = actx.createOscillator(); o.type = ty; o.frequency.value = fr; if (o.detune) o.detune.value = det; o.connect(f); o.start(t); oscs.push(o); }
    f.connect(g).connect(out());
    droneNodes = { g, oscs, lfo };
  } catch (e) {}
}
function stopDrone() {
  if (!droneNodes) return; const dn = droneNodes; droneNodes = null;
  try { const t = actx.currentTime; dn.g.gain.cancelScheduledValues(t); dn.g.gain.setValueAtTime(dn.g.gain.value, t); dn.g.gain.linearRampToValueAtTime(0.0001, t + 1.4); dn.oscs.forEach(o => o.stop(t + 1.5)); dn.lfo.stop(t + 1.5); } catch (e) {}
}

/* ---------- Persistence ---------- */
function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY));
    if (p && typeof p === 'object') return Object.assign(defaultProfile(), p);
  } catch {}
  return defaultProfile();
}
function defaultProfile() {
  return { playerLevel: 1, xp: 0, unlocked: [], souls: 0, meta: {}, settings: { autofire: true, autoaim: true, muted: false, haptics: true } };
}
function saveProfile(p) { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {} }
function loadScores() { try { return JSON.parse(localStorage.getItem(SCORES_KEY)) || []; } catch { return []; } }
function saveScores(s) { try { localStorage.setItem(SCORES_KEY, JSON.stringify(s.slice(0, 7))); } catch {} }
function addScore(name, wave, score) {
  const b = loadScores();
  b.push({ name: (name || 'Hráč').slice(0, 12), wave, score });
  b.sort((a, c) => c.score - a.score);
  const t = b.slice(0, 7);
  saveScores(t);
  return t;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- fitCanvas (responzivní škálování) ---------- */
function fitCanvas() {
  const ratio = W / H;
  const availW = window.innerWidth;
  const availH = window.innerHeight;
  let w = availW, h = w / ratio;
  if (h > availH) { h = availH; w = h * ratio; }
  canvas.style.width = Math.max(160, Math.floor(w)) + 'px';
  canvas.style.height = Math.max(240, Math.floor(h)) + 'px';
}
window.addEventListener('resize', fitCanvas);
window.addEventListener('orientationchange', () => setTimeout(fitCanvas, 200));
