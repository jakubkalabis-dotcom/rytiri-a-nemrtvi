/* ============================================================================
   RYTÍŘI A NEMRTVÍ — engine (jádro nezávislé na konkrétní herní logice)
   Grid + flow-field pathfinding, spatial hash, object pooly, kamera, kolizní
   helpery, audio syntéza, persistence, fitCanvas. Čte konstanty z data.js.
   ========================================================================== */

/* ---------- Plátno ---------- */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;   // 480 × 800

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
function applyCamera() { ctx.translate(-camera.x, -camera.y); }
function screenToWorld(sx, sy) { return { x: sx + camera.x, y: sy + camera.y }; }

/* ---------- Mřížka / dlaždice ---------- */
// tiles: 0 = tráva, 1 = statická překážka. structures[i] = objekt zdi/null.
const grid = {
  tiles: new Uint8Array(COLS * ROWS),
  structures: new Array(COLS * ROWS).fill(null),
  coreTiles: [],
};
function tileIndex(tx, ty) { return ty * COLS + tx; }
function inBounds(tx, ty) { return tx >= 0 && ty >= 0 && tx < COLS && ty < ROWS; }
function tileOf(x, y) { return { tx: Math.floor(x / TILE), ty: Math.floor(y / TILE) }; }
// Blokuje pohyb? (mimo mapu / překážka / zeď)
function isBlocked(tx, ty) {
  if (!inBounds(tx, ty)) return true;
  const i = tileIndex(tx, ty);
  return grid.tiles[i] === 1 || grid.structures[i] !== null;
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
}

/* ---------- Flow-field pathfinding (BFS distanční pole od jádra) ---------- */
// dist = počet kroků do jádra; flowX/flowY = jednotkový vektor k dalšímu kroku.
let flowDirty = true;
const flowDist = new Float32Array(COLS * ROWS);
const flowX = new Float32Array(COLS * ROWS);
const flowY = new Float32Array(COLS * ROWS);
const _bfsQueue = new Int32Array(COLS * ROWS);
const NEI = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

function buildFlowField() {
  flowDist.fill(Infinity);
  let head = 0, tail = 0;
  for (const ci of grid.coreTiles) {
    if (grid.structures[ci] !== null || grid.tiles[ci] === 1) continue;
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
    if (grid.tiles[ci] === 1 || grid.structures[ci] !== null) continue;
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

/* ---------- Audio (vlastní syntéza, středověké zvuky) ---------- */
let actx = null, muted = false, noiseBuf = null;
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
  } catch (err) { actx = null; noiseBuf = null; }
}
function tone(freq, dur, type = 'square', vol = 0.15, slideTo = null) {
  if (!actx || muted) return;
  const t = actx.currentTime;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t); o.stop(t + dur);
}
function noise(dur, vol = 0.3, filterFreq = 900) {
  if (!actx || muted) return;
  const t = actx.currentTime;
  const s = actx.createBufferSource(); s.buffer = noiseBuf;
  const g = actx.createGain(), f = actx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = filterFreq;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(actx.destination);
  s.start(t); s.stop(t + dur);
}
const sfx = {
  swing()     { noise(0.12, 0.14, 2200); tone(300, 0.08, 'triangle', 0.05, 180); },
  bow()       { tone(500, 0.09, 'triangle', 0.07, 220); },
  crossbow()  { tone(360, 0.07, 'square', 0.08, 160); noise(0.05, 0.08, 3000); },
  gun()       { noise(0.22, 0.4, 1400); tone(120, 0.2, 'sawtooth', 0.16, 45); },
  magic()     { tone(680, 0.14, 'sine', 0.1, 1200); },
  throwsnd()  { noise(0.09, 0.1, 2600); },
  boom()      { noise(0.42, 0.4, 900); tone(140, 0.4, 'sawtooth', 0.16, 50); },
  hitFlesh()  { noise(0.1, 0.16, 700); tone(180, 0.08, 'square', 0.06, 90); },
  enemyDie()  { noise(0.16, 0.2, 800); tone(140, 0.14, 'sawtooth', 0.08, 60); },
  groan()     { tone(90, 0.5, 'sawtooth', 0.05, 60); },
  place()     { tone(240, 0.08, 'square', 0.1); setTimeout(() => tone(360, 0.08, 'square', 0.1), 70); },
  buy()       { tone(560, 0.08, 'triangle', 0.12); setTimeout(() => tone(760, 0.1, 'triangle', 0.12), 80); },
  coreHit()   { tone(200, 0.3, 'sawtooth', 0.2, 70); noise(0.25, 0.2, 500); },
  waveStart() { tone(300, 0.14, 'triangle', 0.14); setTimeout(() => tone(450, 0.14, 'triangle', 0.14), 120); setTimeout(() => tone(600, 0.2, 'triangle', 0.15), 240); },
  waveWin()   { tone(520, 0.12, 'triangle', 0.14); setTimeout(() => tone(660, 0.12, 'triangle', 0.14), 110); setTimeout(() => tone(880, 0.22, 'triangle', 0.15), 220); },
  boss()      { tone(70, 0.9, 'sawtooth', 0.22, 45); noise(0.9, 0.12, 260); },
  hurt()      { tone(220, 0.25, 'square', 0.18, 70); noise(0.2, 0.2, 600); },
  gameOver()  { tone(300, 0.6, 'sawtooth', 0.2, 80); setTimeout(() => tone(160, 0.7, 'sawtooth', 0.2, 55), 200); },
  heal()      { tone(600, 0.1, 'sine', 0.1); setTimeout(() => tone(820, 0.14, 'sine', 0.1), 90); },
  levelUp()   { tone(500, 0.1, 'triangle', 0.14); setTimeout(() => tone(700, 0.1, 'triangle', 0.14), 90); setTimeout(() => tone(1000, 0.18, 'triangle', 0.15), 180); },
};

/* ---------- Persistence ---------- */
function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY));
    if (p && typeof p === 'object') return Object.assign(defaultProfile(), p);
  } catch {}
  return defaultProfile();
}
function defaultProfile() {
  return { playerLevel: 1, xp: 0, unlocked: [], settings: { autofire: true, muted: false, haptics: true } };
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
