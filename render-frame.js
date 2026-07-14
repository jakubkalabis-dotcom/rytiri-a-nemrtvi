// Vyrenderuje skutečnou bojovou scénu hry do PNG (přes @napi-rs/canvas) — vývojový nástroj,
// aby šlo VIDĚT arénu a vizuálně na ní iterovat (ne naslepo).
// Setup:  npm i @napi-rs/canvas
// Použití: node render-frame.js [mapIndex 0-14] [out.png]   → pak si PNG prohlédni
const fs = require('fs'), path = require('path'), vm = require('vm');
const { createCanvas } = require('@napi-rs/canvas');
const DIR = __dirname;
const MAP = parseInt(process.argv[2] || '0', 10);
const OUT = process.argv[3] || path.join(__dirname, 'renders', 'arena.png');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const noop = () => undefined;
function realCanvasEl(w, h) { const c = createCanvas(w || 480, h || 800); c.style = {}; c.addEventListener = noop; c.getBoundingClientRect = () => ({ left: 0, top: 0, width: w || 480, height: h || 800 }); c.dataset = {}; return c; }
function fakeEl() { const el = { style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, addEventListener: noop, removeEventListener: noop, appendChild: noop, removeChild: noop, setAttribute: noop, querySelectorAll: () => [], querySelector: () => null, focus: noop, click: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 800 }), remove: noop, getContext: () => createCanvas(10, 10).getContext('2d') }; let h = ''; Object.defineProperty(el, 'innerHTML', { get: () => h, set: v => { h = String(v); } }); return el; }
const gameCanvas = realCanvasEl(480, 800);
const els = { game: gameCanvas };
const store = {};
const sandbox = {
  console,
  document: { getElementById: id => els[id] || (els[id] = id === 'game' ? gameCanvas : fakeEl()), createElement: t => t === 'canvas' ? realCanvasEl() : fakeEl(), querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, body: fakeEl(), documentElement: fakeEl() },
  navigator: { vibrate: noop, userAgent: 'node' }, performance: { now: () => Date.now() },
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  requestAnimationFrame: noop, setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
  Audio: function () { return { play: noop, pause: noop }; },
  AudioContext: function () { return { createOscillator: () => ({ connect: noop, start: noop, stop: noop, frequency: { value: 0, setValueAtTime: noop } }), createGain: () => ({ connect: noop, gain: { value: 0, setValueAtTime: noop, exponentialRampToValueAtTime: noop, linearRampToValueAtTime: noop } }), destination: {}, currentTime: 0 }; },
  Peer: function () { return { on: noop }; }, Image: function () { return {}; },
  Math, Date, JSON, Object, Array, Number, String, Boolean, isNaN, parseInt, parseFloat, Infinity, NaN, undefined,
};
sandbox.window = sandbox; sandbox.addEventListener = noop; sandbox.removeEventListener = noop; sandbox.globalThis = sandbox; sandbox.webkitAudioContext = sandbox.AudioContext;
vm.createContext(sandbox);
let code = '';
for (const f of ['data.js', 'engine.js', 'game.js', 'net.js']) code += `\n/* ${f} */\n` + fs.readFileSync(path.join(DIR, f), 'utf8') + '\n';

code += `
;(function SCENE(){
  profile.settings = profile.settings || {}; profile.settings.haptics = false;
  newRun('rytir');
  // přejdi na zvolenou mapu
  run.wave = ${MAP} * WAVES_PER_MAP; loadMap(${MAP}); currentMap = ${MAP};
  const p = players[0];
  const cx = (CORE.tx + CORE.w/2)*TILE, cy = (CORE.ty)*TILE;
  p.x = cx; p.y = cy + TILE*3;
  // postav trochu obrany pro vizuální bohatost
  function put(arr, defId, def, tx, ty, extra){ const o = Object.assign({def, defId, tx, ty, x:(tx+0.5)*TILE, y:(ty+0.5)*TILE, r:15, hp:def.hp||90, hpMax:def.hp||90, flash:0, fireCool:0}, extra||{}); grid.structures[tileIndex(tx,ty)]=o; arr.push(o); return o; }
  const gx = CORE.tx, gy = CORE.ty;
  put(walls,'kamenna_zed',STRUCTURES.kamenna_zed, gx-2, gy+3);
  put(walls,'kamenna_zed',STRUCTURES.kamenna_zed, gx+CORE.w+1, gy+3);
  put(turrets,'samostril',TRAPS.samostril, gx-1, gy+4);
  put(turrets,'tesla',TRAPS.tesla||TRAPS.samostril, gx+CORE.w, gy+4);
  traps.push({def:TRAPS.hroty||TRAPS.samostril, defId:'hroty', tx:gx+1, ty:gy+5, x:(gx+1.5)*TILE, y:(gy+5.5)*TILE, dur:Infinity, cool:0});
  warriors.push({def:WARRIORS.mecenos, defId:'mecenos', x:cx-40, y:cy+TILE*2, r:12, hp:90,hpMax:90, homeX:cx-40,homeY:cy+TILE*2, cool:0,aim:0,flash:0});
  // rozmísti nepřátele různých typů kolem
  const types=['chodec','behac','ohar','obr','brnenec','plivac','vybusny'];
  let n=0;
  for (const t of types){ if(!ENEMIES[t]) continue; for(let k=0;k<3;k++){ spawnEnemy(t); const e=enemies[enemies.length-1]; e.x=cx+((n%5)-2)*34; e.y=cy - TILE*1 - ((n/5|0))*30 - k*10; e.spawnT=0; n++; } }
  // boss pro boss bar
  spawnEnemy('nekromant'); const b=enemies[enemies.length-1]; b.x=cx; b.y=cy-TILE*3; b.spawnT=0;
  state='combat';
  updateCamera(p.x, p.y, 1, true);
  // pár snímků ať se ustálí kamera/animace (bez pohybu nepřátel k jádru moc daleko)
  for(let f=0; f<3; f++){ animClock+=1; render(); }
  render();
})();
`;
try { vm.runInContext(code, sandbox, { filename: 'bundle.js' }); }
catch (e) { console.error('RENDER FAIL:', e && e.message); console.error((e && e.stack || '').split('\n').slice(1,5).join('\n')); process.exit(1); }
const buf = gameCanvas.toBuffer('image/png');
fs.writeFileSync(OUT, buf);
console.log('wrote', OUT, buf.length, 'bytes');
