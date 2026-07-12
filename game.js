/* ============================================================================
   RYTÍŘI A NEMRTVÍ — herní logika, stavový automat, ovládání, HUD, smyčka.
   Závisí na data.js (obsah) a engine.js (jádro).
   ========================================================================== */

/* ---------- Stav ---------- */
let state = 'menu';   // menu | class | shop | build | combat | roundEnd | gameOver
let profile = loadProfile();
muted = profile.settings.muted;
let run = null;       // aktuální hra (viz newRun)
const players = [];
let enemies = [], walls = [], turrets = [], traps = [], warriors = [];

/* ---------- Co-op / síť ---------- */
// role: null = solo; 'host' = hostitel (počítá simulaci); 'guest' = připojený druhý hráč (jen vykresluje)
const net = { mode: 'solo', role: null, connected: false, dc: null, pc: null, hostClass: null, guestClass: null };
let readyHost = false, readyGuest = false;
// Lokální vstup tohoto zařízení (ovládací prvky píšou sem; loop ho aplikuje/odešle).
const myInput = { mx: 0, my: 0, aiming: false, aimAngle: -Math.PI / 2 };
function localPlayer() { return net.role === 'guest' ? players[1] : players[0]; }
function isCoop() { return net.role === 'host' || net.role === 'guest'; }
// Nejlepší pasiva napříč týmem (vyšší = lepší, např. warriorBuff)
function teamMax(key) { let m = 0; for (const p of players) { const v = (p.passive && p.passive[key]) || 0; if (v > m) m = v; } return m; }
// Nejlepší „rate" pasiva (nižší = rychlejší, např. emitterRate)
function teamRate(key) { let m = 1; for (const p of players) { const v = p.passive && p.passive[key]; if (v != null && v < m) m = v; } return m; }
// Aplikuj lokální vstup na vlastního hráče (host/solo). Guest vstup jen odesílá.
function applyLocalInput() {
  if (net.role === 'guest') return;
  const p = players[0]; if (!p) return;
  p.input.mx = myInput.mx; p.input.my = myInput.my; p.input.aiming = myInput.aiming;
  if (myInput.aiming) p.aimAngle = myInput.aimAngle;
}
let bullets = [], eBullets = [], groundFx = [], particles = [], effects = [];
let lastTime = performance.now();
let shake = 0, flash = 0, banner = null;
let wave = null;      // stav probíhající vlny

const overlay = document.getElementById('overlay');
const ovContent = document.getElementById('ovContent');

/* ---------- Layout HUD ---------- */
const STICK_R = 50;
function inArena(y) { return y < ARENA_H; }
const BTN = {
  weapon:   { x: 6,      y: ARENA_H + 8,  w: 150, h: 38 },
  autofire: { x: 164,    y: ARENA_H + 8,  w: 120, h: 38 },
  pause:    { x: W - 60, y: ARENA_H + 8,  w: 54,  h: 38 },
  switch2:  { x: 6,      y: ARENA_H + 52, w: 150, h: 36 },   // přepínač zbraní zpět
  start:    { x: W - 132,y: ARENA_H + 50, w: 126, h: 40 },   // start vlny (build)
};
function inRect(px, py, r) { return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h; }

/* ---------- Nová hra / třída ---------- */
// classIds: string (solo) nebo pole tříd (co-op, index 0 = hostitel).
function newRun(classIds) {
  if (typeof classIds === 'string') classIds = [classIds];
  const first = CLASSES[classIds[0]];
  run = {
    classId: classIds[0], class: first,
    gems: classIds.reduce((s, cid) => s + CLASSES[cid].startGems, 0), // sdílený rozpočet
    lives: 20,
    wave: 0,
    ownedWeapons: [],
    ammo: {},
    owned: {},          // stavební inventář: id -> počet
    score: 0,
  };
  for (const k in AMMO) run.ammo[k] = 0;
  // sdílené vlastněné zbraně = sjednocení startovních zbraní hráčů
  for (const cid of classIds) for (const wid of CLASSES[cid].start) if (!run.ownedWeapons.includes(wid)) run.ownedWeapons.push(wid);
  for (const wid of run.ownedWeapons) grantAmmoFor(wid, 2);
  enemies = []; walls = []; turrets = []; traps = []; warriors = [];
  bullets = []; eBullets = []; groundFx = []; particles = []; effects = [];
  buildArena();
  flowDirty = true;
  players.length = 0;
  const cx = (CORE.tx + CORE.w / 2) * TILE;
  classIds.forEach((cid, i) => {
    const p = makePlayer(CLASSES[cid], cid);
    p.x = cx + (i === 0 ? -20 : 20);
    players.push(p);
  });
  readyHost = false; readyGuest = false;
}
function makePlayer(cls, classId) {
  const pas = cls.passive || {};
  return {
    classId, class: cls, color: cls.color,
    x: (CORE.tx + CORE.w / 2) * TILE, y: (CORE.ty - 1) * TILE, r: 12,
    hpMax: Math.round(120 * cls.hpMod), hp: Math.round(120 * cls.hpMod),
    baseSpeed: 2.6 * cls.spdMod * (pas.moveSpeed || 1),
    weaponId: cls.start[0], cool: 0, aimAngle: -Math.PI / 2, inv: 0, downed: false,
    manaMax: Math.round(100 * (pas.manaMax || 1)), mana: Math.round(100 * (pas.manaMax || 1)),
    manaRegen: 0.28 * (pas.manaRegen || 1),
    passive: pas,
    input: { mx: 0, my: 0, aiming: false },
  };
}
function grantAmmoFor(wid, bundles) {
  const w = WEAPONS[wid];
  if (!w || w.ammo === 'melee' || w.ammo === 'mana') return;
  run.ammo[w.ammo] = (run.ammo[w.ammo] || 0) + AMMO[w.ammo].bundle * bundles;
}

/* ---------- Cena s třídním násobičem ---------- */
function costOf(cost, cat) {
  // nejlepší (nejnižší) sleva napříč týmem
  let mul = 1;
  const src = players.length ? players.map(p => p.class) : [run.class];
  for (const c of src) { const m = c.costMul && c.costMul[cat]; if (m != null && m < mul) mul = m; }
  return Math.max(1, Math.round(cost * mul));
}

/* ============================================================================
   STAVOVÝ AUTOMAT + OVERLAY UI
   ========================================================================== */
function setState(s) {
  state = s;
  if (s === 'menu' || s === 'class' || s === 'shop' || s === 'roundEnd' || s === 'gameOver' || s === 'host' || s === 'join') {
    overlay.classList.remove('hidden');
  } else {
    overlay.classList.add('hidden');
  }
  if (s === 'menu') renderMenu();
  else if (s === 'class') renderClassSelect();
  else if (s === 'shop') renderShop();
  else if (s === 'roundEnd') renderRoundEnd();
  else if (s === 'gameOver') renderGameOver();
  else if (s === 'host' && typeof renderHostLobby === 'function') renderHostLobby();
  else if (s === 'join' && typeof renderJoinLobby === 'function') renderJoinLobby();
  else if (s === 'build') { banner = { text: 'FÁZE STAVĚNÍ', t: 90 }; }
  // hostitel po každém přechodu okamžitě sesynchronizuje guesta
  if (typeof netPush === 'function' && net.role === 'host' && net.connected) netPush();
}

function renderMenu() {
  const scores = loadScores();
  const board = scores.length
    ? scores.map((r, i) => `<div class="row"><span class="rank">${i + 1}.</span><span class="nm">${escapeHtml(r.name)}</span><span class="sc">vlna ${r.wave} · ${r.score}</span></div>`).join('')
    : '<div class="empty">Zatím žádné skóre — buď první!</div>';
  ovContent.innerHTML = `
    <h2>⚔ RYTÍŘI A NEMRTVÍ ⚔</h2>
    <p>Braň hradní bránu před vlnami nemrtvých. Nakupuj zbraně, stav pasti, zdi a věže,
    najmi spojence a přežij co nejdéle. Úroveň profilu: <b>${profile.playerLevel}</b> (odemyká zbraně).</p>
    <div class="board"><h3>NEJLEPŠÍ SKÓRE</h3>${board}</div>
    <button data-act="play">Hrát sám</button>
    <button data-act="hostgame" class="ghost">Hostovat co-op (2 hráči)</button>
    <button data-act="joingame" class="ghost">Připojit se ke hře</button>`;
}

function renderClassSelect() {
  const cards = Object.keys(CLASSES).map(id => {
    const c = CLASSES[id];
    return `<div class="card class-card" data-act="pickclass" data-id="${id}" style="border-color:${c.color}55">
      <div class="ci" style="color:${c.color}">${c.icon}</div>
      <div class="cn">${c.name}</div>
      <div class="cd">${c.desc}</div>
      <div class="cs">💎 ${c.startGems} · ❤ ${Math.round(120 * c.hpMod)}</div>
    </div>`;
  }).join('');
  ovContent.innerHTML = `<h2>Vyber třídu</h2><div class="grid">${cards}</div>
    <button data-act="menu" class="ghost">Zpět</button>`;
}

function shopCard(id, name, cost, cat, extra, act, disabled) {
  return `<div class="card shop-card ${disabled ? 'dis' : ''}" ${disabled ? '' : `data-act="${act}" data-id="${id}"`}>
    <div class="scn">${name}</div>
    <div class="scd">${extra || ''}</div>
    <div class="scc">${disabled || '💎 ' + cost}</div>
  </div>`;
}
function renderShop() {
  const lvl = profile.playerLevel;
  // Zbraně (nevlastněné)
  const weaponCards = Object.keys(WEAPONS).filter(id => !run.ownedWeapons.includes(id) && WEAPONS[id].cost > 0).map(id => {
    const w = WEAPONS[id];
    const locked = lvl < w.unlock;
    const cost = costOf(w.cost, w.cat === 'melee' ? 'melee' : 'ranged');
    const cant = locked ? `🔒 úroveň ${w.unlock}` : (run.gems < cost ? 'málo 💎' : null);
    const tag = w.cat === 'melee' ? '🗡' : '🏹';
    return shopCard(id, `${tag} ${w.name}`, cost, null, `dmg ${w.dmg} · ${w.arch === 'MELEE_SWING' ? 'zblízka' : 'dálka'}`, 'buyweapon', cant);
  }).join('');
  // Munice
  const ammoCards = Object.keys(AMMO).map(id => {
    const a = AMMO[id];
    const cost = costOf(a.cost, 'ammo');
    return shopCard(id, `🎯 ${a.name}`, cost, 'ammo', `+${a.bundle} · máš ${run.ammo[id] || 0}`, 'buyammo', run.gems < cost ? 'málo 💎' : null);
  }).join('');
  // Pasti a věže
  const trapCards = Object.keys(TRAPS).map(id => {
    const t = TRAPS[id];
    const cost = costOf(t.cost, 'trap');
    return shopCard(id, `🪤 ${t.name}`, cost, 'trap', `máš ${run.owned[id] || 0}`, 'buybuild', run.gems < cost ? 'málo 💎' : null);
  }).join('');
  // Zdi
  const wallCards = Object.keys(STRUCTURES).map(id => {
    const s = STRUCTURES[id];
    const cost = costOf(s.cost, 'wall');
    return shopCard(id, `🧱 ${s.name}`, cost, 'wall', `HP ${Math.round(s.hp * (teamMax('wallHp') || 1))} · máš ${run.owned[id] || 0}`, 'buybuild', run.gems < cost ? 'málo 💎' : null);
  }).join('');
  // Válečníci
  const warCards = Object.keys(WARRIORS).map(id => {
    const w = WARRIORS[id];
    const cost = costOf(w.cost, 'warrior');
    return shopCard(id, `🛡 ${w.name}`, cost, 'warrior', `HP ${w.hp} · máš ${run.owned[id] || 0}`, 'buybuild', run.gems < cost ? 'málo 💎' : null);
  }).join('');
  // Životy jádra
  const lifeCost = 40;
  const lifeCard = shopCard('life', '❤ Život brány (+5)', lifeCost, 'ammo', `jádro: ${run.lives}`, 'buylife', run.gems < lifeCost ? 'málo 💎' : null);

  ovContent.innerHTML = `
    <h2>Obchod · vlna ${run.wave + 1}</h2>
    <div class="wallet">💎 ${run.gems} &nbsp; ❤ ${run.lives} &nbsp; 🏰 ${players.map(p => p.class.name).join(' + ')}</div>
    <div class="shop">
      <h3>Zbraně</h3><div class="grid">${weaponCards || '<div class="empty">Vše koupeno</div>'}</div>
      <h3>Munice a život</h3><div class="grid">${ammoCards}${lifeCard}</div>
      <h3>Pasti a věže</h3><div class="grid">${trapCards}</div>
      <h3>Zdi</h3><div class="grid">${wallCards}</div>
      <h3>Spojenci</h3><div class="grid">${warCards}</div>
    </div>
    <button data-act="tobuild">Dál → stavění</button>`;
}

function renderRoundEnd() {
  const r = (wave && wave.reward) || { gems: 0, kills: 0, xp: 0 };
  ovContent.innerHTML = `
    <h2>Vlna ${run.wave} přežita!</h2>
    <div class="wallet">Zabito: <b>${r.kills}</b> · Získáno 💎 <b>${r.gems}</b> · XP <b>+${r.xp}</b></div>
    <p>Jádro brány má ještě <b>${run.lives}</b> životů. Připrav se na další vlnu.</p>
    <button data-act="toshop">Do obchodu</button>`;
}

function renderGameOver() {
  const score = run ? run.score || 0 : 0;
  ovContent.innerHTML = `
    <h2>Brána padla</h2>
    <div class="wallet">Dosažená vlna: <b>${run.wave}</b> · Skóre: <b>${score}</b></div>
    <div class="board"><h3>NEJLEPŠÍ SKÓRE</h3>${loadScores().map((r, i) => `<div class="row"><span class="rank">${i + 1}.</span><span class="nm">${escapeHtml(r.name)}</span><span class="sc">vlna ${r.wave} · ${r.score}</span></div>`).join('') || '<div class="empty">—</div>'}</div>
    <button data-act="menu">Zpět do menu</button>`;
}

// Delegované klikání v overlay
overlay.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  initAudio();
  // --- lobby / co-op ---
  if (act === 'play') { net.role = null; net.mode = 'solo'; setState('class'); return; }
  if (act === 'hostgame') { net.role = 'host'; net.mode = 'coop'; setState('host'); if (typeof netHost === 'function') netHost(); return; }
  if (act === 'joingame') { net.role = 'guest'; net.mode = 'coop'; setState('join'); return; }
  if (act === 'menu') { if (typeof netClose === 'function') netClose(); net.role = null; net.mode = 'solo'; setState('menu'); return; }
  if (act === 'copycode') { if (typeof netCopy === 'function') netCopy(el.dataset.which, el); return; }
  if (act === 'genanswer') { if (typeof netJoinAccept === 'function') netJoinAccept(); return; }
  if (act === 'hostaccept') { if (typeof netHostAccept === 'function') netHostAccept(); return; }
  if (act === 'pickclass') { pickClass(id); return; }
  // --- guest: ekonomika a tok = příkazy hostiteli ---
  if (net.role === 'guest') {
    if (['buyweapon', 'buyammo', 'buybuild', 'buylife', 'tobuild', 'toshop'].includes(act)) { netSend({ t: 'cmd', act, id }); return; }
    return;
  }
  // --- host / solo ---
  if (act === 'buyweapon') buyWeapon(id);
  else if (act === 'buyammo') buyAmmo(id);
  else if (act === 'buybuild') buyBuild(id);
  else if (act === 'buylife') { if (run.gems >= 40) { run.gems -= 40; run.lives += 5; sfx.buy(); renderShop(); } }
  else if (act === 'tobuild') { startBuildPhase(); }
  else if (act === 'toshop') { setState('shop'); }
});

// Výběr třídy (solo i co-op)
function pickClass(id) {
  if (!isCoop()) { newRun(id); setState('shop'); return; }
  if (net.role === 'host') {
    net.hostClass = id;
    if (net.guestClass) startCoop();
    else ovContent.innerHTML = `<h2>Volba třídy</h2><p>Vybráno: <b>${CLASSES[id].name}</b>.<br>Čekání na volbu spoluhráče…</p><button data-act="menu" class="ghost">Zrušit</button>`;
  } else {
    net.guestClass = id;
    netSend({ t: 'class', classId: id });
    ovContent.innerHTML = `<h2>Volba třídy</h2><p>Vybráno: <b>${CLASSES[id].name}</b>.<br>Čekání na hostitele…</p><button data-act="menu" class="ghost">Zrušit</button>`;
  }
}
// Host spustí sdílený běh a rozešle stav (guest ho zrcadlí přes snímky).
function startCoop() {
  newRun([net.hostClass, net.guestClass]);
  setState('shop');
  if (typeof netPush === 'function') netPush();
}

function buyWeapon(id) {
  const w = WEAPONS[id];
  if (profile.playerLevel < w.unlock) return;
  const cost = costOf(w.cost, w.cat === 'melee' ? 'melee' : 'ranged');
  if (run.gems < cost) return;
  run.gems -= cost; run.ownedWeapons.push(id); grantAmmoFor(id, 2);
  sfx.buy(); renderShop();
}
function buyAmmo(id) {
  const cost = costOf(AMMO[id].cost, 'ammo');
  if (run.gems < cost) return;
  run.gems -= cost; run.ammo[id] += AMMO[id].bundle; sfx.buy(); renderShop();
}
function buyBuild(id) {
  const def = TRAPS[id] || STRUCTURES[id] || WARRIORS[id];
  const cost = costOf(def.cost, def.cat);
  if (run.gems < cost) return;
  run.gems -= cost; run.owned[id] = (run.owned[id] || 0) + 1; sfx.buy(); renderShop();
}

/* ============================================================================
   FÁZE STAVĚNÍ
   ========================================================================== */
let buildSel = null;   // vybraná položka z palety
function startBuildPhase() {
  // vyléčit a oživit hráče na začátku přípravy
  for (const p of players) { p.hp = p.hpMax; p.downed = false; p.inv = 0; }
  buildSel = null;
  readyHost = false; readyGuest = false;
  setState('build');
}
function paletteItems() {
  return Object.keys(run.owned).filter(id => run.owned[id] > 0);
}
function defOf(id) { return TRAPS[id] || STRUCTURES[id] || WARRIORS[id]; }
function placeAt(tx, ty) {
  if (!buildSel || (run.owned[buildSel] || 0) <= 0) return;
  if (!inBounds(tx, ty)) return;
  const i = tileIndex(tx, ty);
  if (grid.tiles[i] === 1 || grid.coreTiles.includes(i)) return;
  const def = defOf(buildSel);
  const x = (tx + 0.5) * TILE, y = (ty + 0.5) * TILE;
  if (STRUCTURES[buildSel] || (TRAPS[buildSel] && TRAPS[buildSel].arch === 'EMITTER')) {
    // blokující stavba — nesmí být obsazená a nesmí zapečetit jádro
    if (grid.structures[i] !== null) return;
    if (!pathExistsWith(tx, ty)) { banner = { text: 'ZAPEČETILO BY JÁDRO!', t: 60, warn: true }; return; }
    const hp = Math.round(def.hp * (STRUCTURES[buildSel] ? (teamMax('wallHp') || 1) : 1));
    const obj = { def, defId: buildSel, tx, ty, x, y, r: 15, hp, hpMax: hp, wallCool: 0, fireCool: 0, flash: 0 };
    grid.structures[i] = obj;
    (STRUCTURES[buildSel] ? walls : turrets).push(obj);
    flowDirty = true;
  } else if (TRAPS[buildSel]) {
    // pozemní past (neblokuje)
    if (traps.some(t => t.tx === tx && t.ty === ty)) return;
    traps.push({ def, defId: buildSel, tx, ty, x, y, charges: def.charges || 0, hp: def.hp || 0, dur: def.dur || Infinity, cool: 0, hitCd: 0 });
  } else if (WARRIORS[buildSel]) {
    warriors.push({ def, defId: buildSel, x, y, r: 12, hp: def.hp, hpMax: def.hp, homeX: x, homeY: y, cool: 0, aim: 0, flash: 0 });
  }
  run.owned[buildSel]--;
  if (run.owned[buildSel] <= 0) buildSel = null;
  sfx.place();
  if (navigator.vibrate && profile.settings.haptics) navigator.vibrate(15);
}
function sellAt(tx, ty) {
  const i = tileIndex(tx, ty);
  // struktura/věž
  const s = grid.structures[i];
  if (s) {
    grid.structures[i] = null;
    walls = walls.filter(w => w !== s); turrets = turrets.filter(w => w !== s);
    refund(s.defId); flowDirty = true; return true;
  }
  const ti = traps.findIndex(t => t.tx === tx && t.ty === ty);
  if (ti >= 0) { refund(traps[ti].defId); traps.splice(ti, 1); return true; }
  const wi = warriors.findIndex(w => Math.floor(w.x / TILE) === tx && Math.floor(w.y / TILE) === ty);
  if (wi >= 0) { refund(warriors[wi].defId); warriors.splice(wi, 1); return true; }
  return false;
}
function refund(id) {
  const def = defOf(id);
  run.gems += Math.round(costOf(def.cost, def.cat) * 0.5);
  sfx.buy();
}

/* ============================================================================
   VLNY
   ========================================================================== */
function startWave() {
  run.wave++;
  const wv = run.wave;
  const boss = isBossWave(wv);
  const queue = [];
  if (boss) {
    queue.push('nekromant');
    const minions = 6 + wv;
    const comp = waveComposition(wv);
    for (let k = 0; k < minions; k++) queue.push(pickWeighted(comp));
  } else {
    const comp = waveComposition(wv);
    const n = waveCount(wv);
    for (let k = 0; k < n; k++) queue.push(pickWeighted(comp));
  }
  wave = { queue, spawned: 0, total: queue.length, spawnCool: 20, boss,
           kills: 0, reward: { gems: 0, kills: 0, xp: 0 } };
  flowDirty = true;
  setState('combat');
  banner = { text: boss ? '⚠ BOSS: NEKROMANT ⚠' : 'VLNA ' + wv, t: 100, warn: boss };
  if (boss) sfx.boss(); else sfx.waveStart();
}
function pickWeighted(weights) {
  let total = 0; for (const k in weights) total += weights[k];
  let r = Math.random() * total;
  for (const k in weights) { r -= weights[k]; if (r <= 0) return k; }
  return 'chodec';
}
function spawnEnemy(typeId) {
  const base = ENEMIES[typeId];
  const sc = enemyScale(run.wave);
  const s = SPAWNS[(Math.random() * SPAWNS.length) | 0];
  // boss škáluje HP podle pořadí boss vlny (5., 10., 15. …), ostatní podle vlny
  const bossNum = Math.max(1, Math.floor(run.wave / 5));
  const hp = Math.round(base.hp * (base.arch === 'BOSS' ? (1 + 0.25 * (bossNum - 1)) : sc.hp));
  const e = {
    typeId, arch: base.arch, def: base,
    x: s.x, y: s.y, r: base.size / 2,
    hp, hpMax: hp,
    speed: base.speed * sc.spd,
    dmg: base.dmg * sc.dmg,
    atkRate: base.atkRate, atkCool: 0, fireCool: 60, wallCool: 0,
    color: base.color, flash: 0,
    slowMul: 1, slowTimer: 0, dotDps: 0, dotTimer: 0,
    summonCool: base.summonRate || 0,
  };
  enemies.push(e);
}

/* ============================================================================
   BOJ — zbraně
   ========================================================================== */
function activeWeapon(p) { return WEAPONS[p.weaponId]; }
function rateMod(p, w) {
  if (w.cat === 'ranged' && p.passive.rangedRate) return p.passive.rangedRate;
  return 1;
}
function rangeMod(p, w) {
  if (w.cat === 'ranged' && p.passive.rangedRange) return p.passive.rangedRange;
  return 1;
}
function weaponDmg(p, w) {
  let d = w.dmg;
  const pas = p.passive;
  if (w.cat === 'melee') d *= (pas.meleeDmg || 1);
  if (w.ammo === 'mana') d *= (pas.magicDmg || 1);
  if (w.arch === 'THROWN_AOE') d *= (pas.aoeDmg || 1);
  d *= (pas.holyDmg || 1);
  // berserk: čím méně HP, tím víc poškození (do +40 %)
  if (pas.berserk) d *= 1 + 0.4 * (1 - p.hp / p.hpMax);
  if (pas.crit && Math.random() < pas.crit) { d *= (pas.critMul || 2); }
  return d;
}
function consumeAmmo(p, w) {
  if (w.ammo === 'melee') return true;
  if (w.ammo === 'mana') { if (p.mana < w.ammoPerShot) return false; p.mana -= w.ammoPerShot; return true; }
  const need = w.ammoPerShot || 1;
  if ((run.ammo[w.ammo] || 0) < need) return false;
  run.ammo[w.ammo] -= need; return true;
}
function fireWeapon(p, w, aim) {
  if (!consumeAmmo(p, w)) return false;
  const range = w.range * rangeMod(p, w);
  const dmg = weaponDmg(p, w);
  if (w.arch === 'MELEE_SWING') {
    meleeSwing(p, w, aim, range, dmg); sfx.swing();
  } else if (w.arch === 'PROJECTILE') {
    spawnBullet(p, w, aim, range, dmg); rangedSound(w);
  } else if (w.arch === 'MULTISHOT') {
    const n = w.shots || 3;
    for (let i = 0; i < n; i++) {
      const a = aim + (i - (n - 1) / 2) * (w.spread || 0.3);
      spawnBullet(p, w, a, range, dmg);
    }
    rangedSound(w);
  } else if (w.arch === 'HITSCAN') {
    hitscan(p, w, aim, range, dmg); rangedSound(w);
  } else if (w.arch === 'THROWN_AOE') {
    spawnThrown(p, w, aim, range, dmg); sfx.throwsnd();
  }
  return true;
}
function rangedSound(w) {
  if (w.ammo === 'mana') sfx.magic();
  else if (w.ammo === 'prach') sfx.gun();
  else if (w.ammo === 'sipka') sfx.crossbow();
  else sfx.bow();
}
function meleeSwing(p, w, aim, range, dmg) {
  effects.push({ type: 'swing', x: p.x, y: p.y, aim, range, spread: w.spread, t: 8, color: w.color });
  const cand = enemyHash.query(p.x, p.y, range + 20);
  let hitAny = false;
  for (const e of cand) {
    if (e.dead) continue;
    const dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy);
    if (d > range + e.r) continue;
    let ad = Math.atan2(dy, dx) - aim;
    while (ad > Math.PI) ad -= Math.PI * 2; while (ad < -Math.PI) ad += Math.PI * 2;
    if (Math.abs(ad) > w.spread) continue;
    damageEnemy(e, dmg, w, p);
    if (w.knockback) { e.x += Math.cos(aim) * w.knockback; e.y += Math.sin(aim) * w.knockback; }
    hitAny = true;
  }
  if (hitAny && p.passive.lifesteal) p.hp = Math.min(p.hpMax, p.hp + dmg * p.passive.lifesteal);
}
function spawnBullet(p, w, aim, range, dmg) {
  bullets.push({
    x: p.x + Math.cos(aim) * p.r, y: p.y + Math.sin(aim) * p.r,
    vx: Math.cos(aim) * w.projSpeed, vy: Math.sin(aim) * w.projSpeed,
    r: 4, dmg, pierce: w.pierce || 0, range, traveled: 0,
    dot: w.dot, slow: w.slow, knockback: w.knockback || 0,
    color: w.color, hitIds: [], owner: p,
  });
}
function spawnThrown(p, w, aim, range, dmg) {
  const rad = (w.aoeRadius || 50) * (p.passive.aoeRadius || 1);
  bullets.push({
    x: p.x + Math.cos(aim) * p.r, y: p.y + Math.sin(aim) * p.r,
    vx: Math.cos(aim) * w.projSpeed, vy: Math.sin(aim) * w.projSpeed,
    r: 6, dmg, pierce: 0, range, traveled: 0, thrown: true, aoeRadius: rad,
    dot: w.dot, color: w.color, hitIds: [], owner: p,
  });
}
function hitscan(p, w, aim, range, dmg) {
  let hx = p.x, hy = p.y;
  const step = 8;
  const hitList = [];
  let cur = { x: p.x, y: p.y, a: aim };
  const chain = w.chain || 1;
  const already = new Set();
  for (let c = 0; c < chain; c++) {
    let found = null, foundDist = Infinity, ex = cur.x, ey = cur.y;
    const maxR = c === 0 ? range : 120;
    for (let d = step; d <= maxR; d += step) {
      const px = cur.x + Math.cos(cur.a) * d, py = cur.y + Math.sin(cur.a) * d;
      ex = px; ey = py;
      const { tx, ty } = tileOf(px, py);
      if (blocksProjectile(tx, ty)) break;
      const near = enemyHash.query(px, py, 14);
      for (const e of near) {
        if (e.dead || already.has(e)) continue;
        if (dist(px, py, e.x, e.y) < e.r + 6) { found = e; break; }
      }
      if (found) { ex = found.x; ey = found.y; break; }
    }
    effects.push({ type: 'beam', x1: cur.x, y1: cur.y, x2: ex, y2: ey, t: 6, color: w.color });
    if (!found) break;
    already.add(found);
    damageEnemy(found, dmg, w, p);
    if (w.knockback) { found.x += Math.cos(cur.a) * w.knockback; found.y += Math.sin(cur.a) * w.knockback; }
    // pro řetězení: další cíl = nejbližší jiný nepřítel
    const nxt = nearestEnemyExcluding(found.x, found.y, 120, already);
    if (!nxt) break;
    cur = { x: found.x, y: found.y, a: Math.atan2(nxt.y - found.y, nxt.x - found.x) };
  }
}

function damageEnemy(e, dmg, w, p) {
  e.hp -= dmg;
  e.flash = 5;
  if (w && w.dot) { e.dotDps = Math.max(e.dotDps, w.dot.dps * ((p && p.passive.dotDmg) || 1)); e.dotTimer = w.dot.dur; }
  if (w && w.slow) { e.slowMul = w.slow.mul; e.slowTimer = w.slow.dur; }
  burst(e.x, e.y, '#ffd0d0', 3);
  sfx.hitFlesh();
  if (e.hp <= 0) killEnemy(e);
}
function killEnemy(e) {
  if (e.dead) return;
  e.dead = true;
  const gems = Math.round((e.def.bounty || 4) * GEMS_PER_KILL_MUL);
  run.gems += gems; run.score = (run.score || 0) + (e.def.score || 10);
  if (wave) { wave.kills++; wave.reward.kills++; }
  addXp(xpForKill(e.def));
  explode(e.x, e.y, e.color, e.arch === 'TANK' || e.arch === 'BOSS' ? 26 : 12);
  sfx.enemyDie();
  shake = Math.min(8, shake + (e.arch === 'BOSS' ? 8 : e.arch === 'TANK' ? 3 : 1));
}
function addXp(n) {
  profile.xp += n;
  while (profile.xp >= xpToLevel(profile.playerLevel)) {
    profile.xp -= xpToLevel(profile.playerLevel);
    profile.playerLevel++;
    banner = { text: 'ÚROVEŇ ' + profile.playerLevel + '!', t: 90 };
    sfx.levelUp();
  }
  saveProfile(profile);
}

/* ---------- Cílení ---------- */
function nearestEnemy(x, y, range) {
  let best = null, bd = range * range;
  const cand = enemyHash.query(x, y, range);
  for (const e of cand) { if (e.dead) continue; const dx = e.x - x, dy = e.y - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = e; } }
  return best;
}
function nearestEnemyExcluding(x, y, range, ex) {
  let best = null, bd = range * range;
  const cand = enemyHash.query(x, y, range);
  for (const e of cand) { if (e.dead || ex.has(e)) continue; const dx = e.x - x, dy = e.y - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = e; } }
  return best;
}
function nearestPlayer(x, y) {
  let best = null, bd = Infinity;
  for (const p of players) { const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < bd) { bd = d; best = p; } }
  return best;
}

/* ============================================================================
   EFEKTY / ČÁSTICE
   ========================================================================== */
function burst(x, y, color, n = 10) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = Math.random() * 3 + 0.5;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, decay: 0.03 + Math.random() * 0.03, size: 2 + Math.random() * 2, color });
  }
}
function explode(x, y, color, n = 14) {
  burst(x, y, color, n);
  particles.push({ x, y, ring: true, r: 3, rMax: 20 + n, life: 1, decay: 0.07, color });
}
function aoeExplosion(x, y, radius, dmg, dot, srcColor) {
  explode(x, y, srcColor || '#ff8a3a', 24);
  particles.push({ x, y, ring: true, r: 6, rMax: radius, life: 1, decay: 0.05, color: '#ffd0a0' });
  const cand = enemyHash.query(x, y, radius);
  for (const e of cand) {
    if (e.dead) continue;
    if (dist(x, y, e.x, e.y) <= radius + e.r) {
      damageEnemy(e, dmg, dot ? { dot } : null, null);
    }
  }
  if (dot) groundFx.push({ x, y, radius, dps: dot.dps, dur: dot.dur, color: srcColor || '#ff7b3a' });
  sfx.boom(); shake = Math.min(9, shake + 4);
}

/* ============================================================================
   UPDATE (per stav)
   ========================================================================== */
function update(dt) {
  if (banner && (banner.t -= dt) <= 0) banner = null;
  if (shake > 0) shake = Math.max(0, shake - 0.5 * dt);
  if (flash > 0) flash = Math.max(0, flash - 0.05 * dt);
  if (state === 'combat') updateCombat(dt);
  else if (state === 'build') updateBuild(dt);
}

function updateBuild(dt) {
  updateParticles(dt);
}

function updateCombat(dt) {
  if (flowDirty) buildFlowField();
  // rebuild spatial hash nepřátel
  enemyHash.clear();
  for (const e of enemies) enemyHash.insert(e);

  updatePlayers(dt);
  updateEnemies(dt);
  updateWarriors(dt);
  updateTurrets(dt);
  updateTraps(dt);
  updateGroundFx(dt);
  updateBullets(dt);
  updateEnemyBullets(dt);
  updateParticles(dt);
  updateEffects(dt);

  // spawn z fronty
  if (wave.spawned < wave.total) {
    wave.spawnCool -= dt;
    if (wave.spawnCool <= 0) {
      spawnEnemy(wave.queue[wave.spawned++]);
      wave.spawnCool = Math.max(10, 40 - run.wave * 1.2);
    }
  }
  // konec vlny
  enemies = enemies.filter(e => !e.dead);
  if (wave.spawned >= wave.total && enemies.length === 0) return endWave();
  // konec hry jen když padne brána (padlí hráči se oživí další vlnu)
  if (run.lives <= 0) return doGameOver();
}

function endWave() {
  wave.reward.gems = waveReward(run.wave) + Math.round(run.gems * 0); // bonus
  run.gems += wave.reward.gems;
  wave.reward.xp = wave.kills * 3;
  setState('roundEnd');
  sfx.waveWin();
}
function doGameOver() {
  const name = (profile.settings.name) || 'Rytíř';
  addScore(name, run.wave, run.score || 0);
  saveProfile(profile);
  sfx.gameOver();
  setState('gameOver');
}

/* ---------- Hráč ---------- */
function updatePlayers(dt) {
  for (const p of players) {
    if (p.downed) continue;   // padlý hráč čeká na oživení (další fáze stavění)
    if (p.inv > 0) p.inv -= dt;
    if (p.mana < p.manaMax) p.mana = Math.min(p.manaMax, p.mana + p.manaRegen * dt);
    // léčivá aura (kněz)
    if (p.passive.healAura) p.hp = Math.min(p.hpMax, p.hp + p.passive.healAura * dt);
    // pohyb
    let sp = p.baseSpeed;
    if (p.passive.berserk && p.hp < p.hpMax * 0.35) sp *= 1.3;
    const nx = p.x + p.input.mx * sp * dt, ny = p.y + p.input.my * sp * dt;
    moveEntity(p, nx, ny);
    p.x = clamp(p.x, p.r, ARENA_W - p.r); p.y = clamp(p.y, p.r, ARENA_H - p.r);
    // střelba
    updatePlayerCombat(p, dt);
  }
}
function updatePlayerCombat(p, dt) {
  p.cool -= dt;
  const w = activeWeapon(p);
  const range = w.range * rangeMod(p, w);
  let aim = p.aimAngle, wantFire = false;
  if (p.input.aiming) { aim = p.aimAngle; wantFire = true; }
  else if (profile.settings.autofire) {
    const tgt = nearestEnemy(p.x, p.y, range);
    if (tgt) { aim = Math.atan2(tgt.y - p.y, tgt.x - p.x); wantFire = true; }
  }
  if (wantFire && p.cool <= 0) {
    if (fireWeapon(p, w, aim)) { p.cool = w.rate * rateMod(p, w); p.aimAngle = aim; }
    else p.cool = 20; // prázdno – krátká prodleva
  }
}
function damagePlayer(p, amount) {
  if (p.inv > 0) return;
  if (p.passive.dodge && Math.random() < p.passive.dodge) { effects.push({ type: 'text', x: p.x, y: p.y - 20, txt: 'úhyb', t: 30, color: '#c8c85c' }); return; }
  let dmg = amount;
  if (p.passive.block && Math.random() < p.passive.block) dmg *= 0.4;
  p.hp -= dmg; p.inv = 45;
  flash = 0.5; shake = Math.min(9, shake + 5); sfx.hurt();
  burst(p.x, p.y, '#ff6a6a', 12);
  if (navigator.vibrate && profile.settings.haptics) navigator.vibrate(40);
  if (p.hp <= 0) {
    p.hp = 0; p.downed = true;
    p.input.mx = 0; p.input.my = 0; p.input.aiming = false;
    explode(p.x, p.y, p.color, 20);
    banner = { text: (isCoop() ? (p === players[0] ? 'Hostitel padl!' : 'Spoluhráč padl!') : 'Padl jsi!') + ' Oživení další vlnu.', t: 90, warn: true };
  }
}

/* ---------- Kolize s dlaždicemi ---------- */
function circleBlocked(x, y, r) {
  const minx = Math.floor((x - r) / TILE), maxx = Math.floor((x + r) / TILE);
  const miny = Math.floor((y - r) / TILE), maxy = Math.floor((y + r) / TILE);
  for (let tx = minx; tx <= maxx; tx++)
    for (let ty = miny; ty <= maxy; ty++) {
      if (!inBounds(tx, ty)) continue;              // mimo mapu neblokuje (kraje)
      const i = tileIndex(tx, ty);
      if (grid.tiles[i] === 1 || grid.structures[i] !== null) return true;
    }
  return false;
}
function moveEntity(e, nx, ny) {
  const r = e.r;
  const wantX = nx - e.x, wantY = ny - e.y;
  const blockedX = circleBlocked(nx, e.y, r);
  const blockedY = circleBlocked(e.x, ny, r);
  if (!blockedX) e.x = nx;
  if (!blockedY) e.y = ny;
  // Odseknutí rohu: pokud je HLAVNÍ směr pohybu (podle flow-fieldu) zablokovaný
  // kvůli tomu, že kruh zavadil o roh překážky ve vedlejší dlaždici, srovnej
  // entitu ke středu dlaždice v kolmé ose — příště roh mine a projde dál.
  if (Math.abs(wantY) >= Math.abs(wantX)) {
    if (blockedY && Math.abs(wantY) > 0.01) {
      const cx = (Math.floor(e.x / TILE) + 0.5) * TILE;
      const sx = clamp(cx - e.x, -1.0, 1.0);
      if (Math.abs(sx) > 0.05 && !circleBlocked(e.x + sx, e.y, r)) e.x += sx;
    }
  } else if (blockedX && Math.abs(wantX) > 0.01) {
    const cy = (Math.floor(e.y / TILE) + 0.5) * TILE;
    const sy = clamp(cy - e.y, -1.0, 1.0);
    if (Math.abs(sy) > 0.05 && !circleBlocked(e.x, e.y + sy, r)) e.y += sy;
  }
}

// Vyprostí zaseknutého nepřítele: posune ho ke středu nejlepší (nejnižší
// flowDist) průchozí sousední dlaždice, i za cenu drobného průniku.
function escapeStuck(e) {
  const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE);
  let bestD = Infinity, bx = null, by = null;
  for (const [ox, oy] of NEI) {
    const nx = tx + ox, ny = ty + oy;
    if (!inBounds(nx, ny) || isBlocked(nx, ny)) continue;
    const d = flowDist[tileIndex(nx, ny)];
    if (d < bestD) { bestD = d; bx = nx; by = ny; }
  }
  if (bx === null) { by = Math.min(ROWS - 1, ty + 1); bx = tx; }   // fallback: dolů
  const cx = (bx + 0.5) * TILE, cy = (by + 0.5) * TILE;
  const a = Math.atan2(cy - e.y, cx - e.x);
  e.x += Math.cos(a) * 3; e.y += Math.sin(a) * 3;
}

/* ---------- Nepřátelé ---------- */
function updateEnemies(dt) {
  for (const e of enemies) {
    if (e.dead) continue;
    // status: dot & slow
    if (e.dotTimer > 0) { e.hp -= e.dotDps * dt / 60; e.dotTimer -= dt; if (e.hp <= 0) { killEnemy(e); continue; } }
    if (e.slowTimer > 0) e.slowTimer -= dt; else e.slowMul = 1;
    if (e.flash > 0) e.flash -= dt;

    // směr pohybu: agro na hráče poblíž, jinak flow k jádru
    let dx = 0, dy = 0;
    const pl = nearestPlayer(e.x, e.y);
    const aggro = 150;
    if (pl && dist(e.x, e.y, pl.x, pl.y) < aggro) {
      dx = pl.x - e.x; dy = pl.y - e.y; const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
    } else {
      const f = sampleFlow(e.x, e.y);
      if (f.x || f.y) { dx = f.x; dy = f.y; }
      else { // bez cesty → přímo k jádru
        const cx = (CORE.tx + CORE.w / 2) * TILE, cy = (CORE.ty + CORE.h / 2) * TILE;
        dx = cx - e.x; dy = cy - e.y; const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
      }
    }

    // RANGED (plivač): drží si odstup a střílí
    if (e.arch === 'RANGED' && pl) {
      const d = dist(e.x, e.y, pl.x, pl.y);
      if (d < e.def.keepDist) { dx = -(pl.x - e.x); dy = -(pl.y - e.y); const dd = Math.hypot(dx, dy) || 1; dx /= dd; dy /= dd; }
      e.fireCool -= dt;
      if (e.fireCool <= 0 && d < e.def.keepDist * 1.6) {
        const a = Math.atan2(pl.y - e.y, pl.x - e.x);
        eBullets.push({ x: e.x, y: e.y, vx: Math.cos(a) * e.def.projSpeed, vy: Math.sin(a) * e.def.projSpeed, r: 5, dmg: e.dmg, color: '#8affb0' });
        e.fireCool = e.atkRate;
      }
    }
    // BOSS: přivolává + střílí vějíř
    if (e.arch === 'BOSS') {
      e.summonCool -= dt;
      // přivolávej jen když není přemíra nemrtvých (strop proti nekonečné vlně)
      const minions = enemies.reduce((n, o) => n + (o.arch !== 'BOSS' && !o.dead ? 1 : 0), 0);
      if (e.summonCool <= 0 && minions < 10) { spawnEnemy(e.def.summon); e.summonCool = e.def.summonRate; }
      else if (e.summonCool <= 0) { e.summonCool = 40; }
      e.fireCool -= dt;
      if (e.fireCool <= 0 && pl) {
        const base = Math.atan2(pl.y - e.y, pl.x - e.x);
        for (let i = -2; i <= 2; i++) {
          const a = base + i * 0.24;
          eBullets.push({ x: e.x, y: e.y, vx: Math.cos(a) * 4, vy: Math.sin(a) * 4, r: 6, dmg: e.dmg * 0.5, color: '#d09aff' });
        }
        e.fireCool = e.atkRate;
      }
    }

    // separace od ostatních nepřátel (aby se nehromadili)
    const near = enemyHash.query(e.x, e.y, e.r * 2);
    for (const o of near) {
      if (o === e || o.dead) continue;
      const ox = e.x - o.x, oy = e.y - o.y, od = Math.hypot(ox, oy);
      if (od > 0 && od < e.r + o.r) { dx += ox / od * 0.5; dy += oy / od * 0.5; }
    }

    const spd = e.speed * e.slowMul;
    // past „smola" pod nohama
    const trap = traps.find(t => t.def.arch === 'SLOW' && t.tx === Math.floor(e.x / TILE) && t.ty === Math.floor(e.y / TILE));
    const slowField = trap ? trap.def.slow.mul : 1;
    const nx = e.x + dx * spd * slowField * dt, ny = e.y + dy * spd * slowField * dt;

    // útok na zeď/věž v cestě
    const ahead = tileOf(e.x + dx * (e.r + 4), e.y + dy * (e.r + 4));
    if (inBounds(ahead.tx, ahead.ty)) {
      const st = grid.structures[tileIndex(ahead.tx, ahead.ty)];
      if (st) {
        e.wallCool -= dt;
        if (e.wallCool <= 0) { damageStructure(st, e.dmg * (e.arch === 'BOSS' ? 2 : 0.5)); e.wallCool = 30; }
      }
    }
    // Boss je obr — prodírá se přímo za cílem (ignoruje kolize s dlaždicemi,
    // jinak by se v úzké aréně zasekl). Míří na hráče (agro) nebo jádro.
    const sx0 = e.x, sy0 = e.y;
    if (e.arch === 'BOSS') {
      const cx = (CORE.tx + CORE.w / 2) * TILE, cy = (CORE.ty + CORE.h / 2) * TILE;
      const tp = (pl && dist(e.x, e.y, pl.x, pl.y) < 420) ? pl : { x: cx, y: cy };
      const a = Math.atan2(tp.y - e.y, tp.x - e.x);
      e.x = clamp(e.x + Math.cos(a) * spd * slowField * dt, e.r, ARENA_W - e.r);
      e.y = clamp(e.y + Math.sin(a) * spd * slowField * dt, e.r, ARENA_H - e.r);
    } else {
      moveEntity(e, nx, ny);
      // Robustní vyproštění: chtěl se hýbat, ale skoro se nepohnul → počítej.
      const wanted = Math.hypot(dx, dy) * spd * dt;
      const moved = Math.hypot(e.x - sx0, e.y - sy0);
      if (wanted > 0.15 && moved < 0.15 * wanted) {
        e.stuckT = (e.stuckT || 0) + dt;
        if (e.stuckT > 14) { escapeStuck(e); e.stuckT = 0; }
      } else e.stuckT = 0;
    }

    // kontakt s hráčem
    if (pl && hitCircle(e, pl, 2)) {
      e.atkCool -= dt;
      if (e.arch === 'EXPLODER') { explodeEnemy(e, pl); continue; }
      if (e.atkCool <= 0) { damagePlayer(pl, e.dmg); e.atkCool = e.atkRate || 40; }
    }
    // kontakt s válečníkem
    for (const wr of warriors) {
      if (hitCircle(e, wr, 2)) {
        e.atkCool2 = (e.atkCool2 || 0) - dt;
        if (e.atkCool2 <= 0) { wr.hp -= e.dmg; wr.flash = 5; e.atkCool2 = e.atkRate || 40; if (wr.hp <= 0) burst(wr.x, wr.y, wr.def.color, 12); }
      }
    }
    // dosažení jádra → únik (ztráta životů)
    const cx = Math.floor(e.x / TILE), cy = Math.floor(e.y / TILE);
    if (cx >= CORE.tx && cx < CORE.tx + CORE.w && cy >= CORE.ty && cy < CORE.ty + CORE.h) {
      run.lives -= e.def.leak || 1; e.dead = true;
      flash = 0.4; shake = Math.min(9, shake + 4); sfx.coreHit();
      burst(e.x, e.y, '#ff5c5c', 16);
      if (navigator.vibrate && profile.settings.haptics) navigator.vibrate(60);
    }
  }
  warriors = warriors.filter(w => w.hp > 0);
}
function explodeEnemy(e, target) {
  e.dead = true;
  aoeExplosion(e.x, e.y, e.def.aoeRadius, 0, null, '#ff6a4a');
  // zásah hráče/válečníků v dosahu
  if (dist(e.x, e.y, target.x, target.y) <= e.def.aoeRadius + target.r) damagePlayer(target, e.dmg);
  for (const wr of warriors) if (dist(e.x, e.y, wr.x, wr.y) <= e.def.aoeRadius) wr.hp -= e.dmg;
}
function damageStructure(s, dmg) {
  s.hp -= dmg; s.flash = 5;
  if (s.hp <= 0) {
    const i = tileIndex(s.tx, s.ty);
    if (grid.structures[i] === s) grid.structures[i] = null;
    walls = walls.filter(w => w !== s); turrets = turrets.filter(w => w !== s);
    flowDirty = true; burst(s.x, s.y, s.def.color, 16);
  }
}

/* ---------- Válečníci ---------- */
function updateWarriors(dt) {
  for (const wr of warriors) {
    if (wr.flash > 0) wr.flash -= dt;
    const def = wr.def;
    const buff = teamMax('warriorBuff') || 1;
    const tgt = nearestEnemy(wr.x, wr.y, def.seek);
    if (tgt) {
      const d = dist(wr.x, wr.y, tgt.x, tgt.y);
      wr.aim = Math.atan2(tgt.y - wr.y, tgt.x - wr.x);
      if (d > def.range * 0.8) {
        const nx = wr.x + Math.cos(wr.aim) * def.speed * dt, ny = wr.y + Math.sin(wr.aim) * def.speed * dt;
        moveEntity(wr, nx, ny);
      }
      wr.cool -= dt;
      if (wr.cool <= 0 && d <= def.range + tgt.r) {
        if (def.arch === 'MELEE') { damageEnemy(tgt, def.dmg * buff, null, null); effects.push({ type: 'swing', x: wr.x, y: wr.y, aim: wr.aim, range: def.range, spread: 0.8, t: 6, color: def.color }); }
        else { bullets.push({ x: wr.x, y: wr.y, vx: Math.cos(wr.aim) * def.projSpeed, vy: Math.sin(wr.aim) * def.projSpeed, r: 3, dmg: def.dmg * buff, pierce: 0, range: def.range, traveled: 0, color: def.color, hitIds: [], owner: null }); }
        wr.cool = def.rate;
      }
    } else {
      // návrat domů
      const d = dist(wr.x, wr.y, wr.homeX, wr.homeY);
      if (d > 6) { const a = Math.atan2(wr.homeY - wr.y, wr.homeX - wr.x); moveEntity(wr, wr.x + Math.cos(a) * def.speed * dt, wr.y + Math.sin(a) * def.speed * dt); }
    }
  }
}

/* ---------- Věže (EMITTER) ---------- */
function updateTurrets(dt) {
  for (const t of turrets) {
    if (t.flash > 0) t.flash -= dt;
    t.fireCool -= dt;
    const def = t.def;
    const rate = def.rate * teamRate('emitterRate');
    if (t.fireCool <= 0) {
      const tgt = nearestEnemy(t.x, t.y, def.range);
      if (tgt) {
        const a = Math.atan2(tgt.y - t.y, tgt.x - t.x);
        bullets.push({ x: t.x, y: t.y, vx: Math.cos(a) * def.projSpeed, vy: Math.sin(a) * def.projSpeed, r: 4, dmg: def.dmg, pierce: def.pierce || 0, range: def.range, traveled: 0, color: '#ffe08a', hitIds: [], owner: null });
        t.fireCool = rate; sfx.crossbow();
      }
    }
  }
}

/* ---------- Pozemní pasti ---------- */
function updateTraps(dt) {
  for (const t of traps) {
    const def = t.def;
    if (def.arch === 'ONESHOT') {
      t.hitCd -= dt;
      if (t.charges > 0 && t.hitCd <= 0) {
        const cand = enemyHash.query(t.x, t.y, TILE * 0.7);
        for (const e of cand) {
          if (e.dead) continue;
          if (dist(t.x, t.y, e.x, e.y) < TILE * 0.6 + e.r) {
            damageEnemy(e, def.dmg, null, null); t.charges--; t.hitCd = 12;
            burst(t.x, t.y, '#ffffff', 8);
            break;
          }
        }
      }
    } else if (def.arch === 'DOT_AOE') {
      t.dur -= dt;
      const cand = enemyHash.query(t.x, t.y, def.radius);
      for (const e of cand) { if (!e.dead && dist(t.x, t.y, e.x, e.y) <= def.radius + e.r) { e.hp -= def.dps * dt / 60; if (e.hp <= 0) killEnemy(e); } }
      if (Math.random() < 0.3) burst(t.x + (Math.random() - 0.5) * def.radius, t.y + (Math.random() - 0.5) * def.radius, def.color, 1);
    }
    // SLOW se aplikuje v updateEnemies
  }
  traps = traps.filter(t => !(t.def.arch === 'ONESHOT' && t.charges <= 0) && !(t.def.arch === 'DOT_AOE' && t.dur <= 0));
}
function updateGroundFx(dt) {
  for (const g of groundFx) {
    g.dur -= dt;
    const cand = enemyHash.query(g.x, g.y, g.radius);
    for (const e of cand) { if (!e.dead && dist(g.x, g.y, e.x, e.y) <= g.radius + e.r) { e.hp -= g.dps * dt / 60; if (e.hp <= 0) killEnemy(e); } }
    if (Math.random() < 0.4) burst(g.x + (Math.random() - 0.5) * g.radius, g.y + (Math.random() - 0.5) * g.radius, g.color, 1);
  }
  groundFx = groundFx.filter(g => g.dur > 0);
}

/* ---------- Střely ---------- */
function updateBullets(dt) {
  for (const b of bullets) {
    const mvx = b.vx * dt, mvy = b.vy * dt;
    b.x += mvx; b.y += mvy; b.traveled += Math.hypot(mvx, mvy);
    // zeď?
    const { tx, ty } = tileOf(b.x, b.y);
    if (blocksProjectile(tx, ty)) { if (b.thrown) aoeExplosion(b.x, b.y, b.aoeRadius, b.dmg, b.dot, b.color); b.dead = true; continue; }
    if (b.traveled > b.range || b.x < -20 || b.x > ARENA_W + 20 || b.y < -20 || b.y > ARENA_H + 20) {
      if (b.thrown) aoeExplosion(b.x, b.y, b.aoeRadius, b.dmg, b.dot, b.color);
      b.dead = true; continue;
    }
    const cand = enemyHash.query(b.x, b.y, b.r + 24);
    for (const e of cand) {
      if (e.dead || b.hitIds.includes(e)) continue;
      if (dist(b.x, b.y, e.x, e.y) < e.r + b.r) {
        if (b.thrown) { aoeExplosion(b.x, b.y, b.aoeRadius, b.dmg, b.dot, b.color); b.dead = true; break; }
        damageEnemy(e, b.dmg, b, b.owner); b.hitIds.push(e);
        if (b.knockback) { const a = Math.atan2(b.vy, b.vx); e.x += Math.cos(a) * b.knockback; e.y += Math.sin(a) * b.knockback; }
        if (b.owner && b.owner.passive && b.owner.passive.lifesteal) b.owner.hp = Math.min(b.owner.hpMax, b.owner.hp + b.dmg * b.owner.passive.lifesteal);
        if (b.pierce > 0) b.pierce--; else { b.dead = true; break; }
      }
    }
  }
  bullets = bullets.filter(b => !b.dead);
}
function updateEnemyBullets(dt) {
  for (const b of eBullets) {
    b.x += b.vx * dt; b.y += b.vy * dt;
    const { tx, ty } = tileOf(b.x, b.y);
    if (blocksProjectile(tx, ty)) { b.dead = true; continue; }
    if (b.x < -20 || b.x > ARENA_W + 20 || b.y < -20 || b.y > ARENA_H + 20) { b.dead = true; continue; }
    for (const p of players) {
      if (p.inv <= 0 && hitCircle(b, p)) { damagePlayer(p, b.dmg); b.dead = true; break; }
    }
    for (const wr of warriors) { if (hitCircle(b, wr)) { wr.hp -= b.dmg; wr.flash = 5; b.dead = true; break; } }
  }
  eBullets = eBullets.filter(b => !b.dead);
}
function updateParticles(dt) {
  for (const p of particles) {
    if (p.ring) { p.r += (p.rMax - p.r) * 0.2 * dt; p.life -= p.decay * dt; continue; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; p.life -= p.decay * dt;
  }
  particles = particles.filter(p => p.life > 0);
}
function updateEffects(dt) {
  for (const e of effects) e.t -= dt;
  effects = effects.filter(e => e.t > 0);
}

/* ============================================================================
   RENDER
   ========================================================================== */
function render() {
  ctx.clearRect(0, 0, W, H);
  if (state === 'menu' || state === 'class') { drawMenuBg(); return; }
  ctx.save();
  if (shake > 0.2) ctx.translate((Math.random() - 0.5) * shake * 2, (Math.random() - 0.5) * shake * 2);
  applyCamera();
  drawArena();
  drawTraps();
  drawStructures();
  drawGroundFx();
  drawWarriors();
  drawEnemies();
  drawBullets();
  drawEffects();
  drawPlayers();
  if (state === 'build') drawBuildGhost();
  drawParticles();
  ctx.restore();

  // HUD (bez otřesu)
  if (state === 'combat' || state === 'build') drawHud();
  if (banner) drawBanner();
  if (flash > 0.01) { ctx.fillStyle = `rgba(255,40,40,${flash})`; ctx.fillRect(0, 0, W, ARENA_H); }
}

function drawMenuBg() {
  ctx.fillStyle = '#1a2a18';
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.25;
  for (let ty = 0; ty < ROWS; ty++) for (let tx = 0; tx < COLS; tx++) {
    ctx.fillStyle = (tx + ty) % 2 ? '#24361f' : '#20301c';
    ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
  }
  ctx.globalAlpha = 1;
}
function drawArena() {
  for (let ty = 0; ty < ROWS; ty++)
    for (let tx = 0; tx < COLS; tx++) {
      ctx.fillStyle = (tx + ty) % 2 ? '#2c4224' : '#284020';
      ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
    }
  // překážky (skály)
  for (const [tx, ty] of OBSTACLES) {
    ctx.fillStyle = '#5a5f66';
    roundRect(tx * TILE + 3, ty * TILE + 3, TILE - 6, TILE - 6, 6); ctx.fill();
    ctx.fillStyle = '#6f757d';
    roundRect(tx * TILE + 7, ty * TILE + 6, TILE - 16, TILE - 16, 4); ctx.fill();
  }
  // spawn brány
  for (const s of SPAWNS) {
    ctx.fillStyle = 'rgba(150,40,60,0.5)';
    ctx.beginPath(); ctx.arc(clamp(s.x, 6, ARENA_W - 6), clamp(s.y, 6, ARENA_H - 6), 10, 0, Math.PI * 2); ctx.fill();
  }
  // jádro (brána hradu)
  const cx = CORE.tx * TILE, cy = CORE.ty * TILE, cw = CORE.w * TILE, ch = CORE.h * TILE;
  ctx.fillStyle = '#6a5030'; roundRect(cx + 2, cy + 2, cw - 4, ch - 4, 6); ctx.fill();
  ctx.fillStyle = '#8a6a40'; roundRect(cx + 6, cy + 6, cw - 12, ch - 12, 4); ctx.fill();
  ctx.fillStyle = '#c8a45c'; ctx.font = 'bold 22px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🏰', cx + cw / 2, cy + ch / 2);
  ctx.textBaseline = 'alphabetic';
}
function drawStructures() {
  for (const s of [...walls, ...turrets]) {
    ctx.fillStyle = s.flash > 0 ? '#fff' : s.def.color;
    roundRect(s.tx * TILE + 2, s.ty * TILE + 2, TILE - 4, TILE - 4, 5); ctx.fill();
    if (s.def.arch === 'EMITTER') {
      ctx.fillStyle = '#3a2f1f'; ctx.beginPath(); ctx.arc(s.x, s.y, 8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#d0b060'; ctx.lineWidth = 3;
      const tgt = nearestEnemy(s.x, s.y, s.def.range);
      const a = tgt ? Math.atan2(tgt.y - s.y, tgt.x - s.x) : -Math.PI / 2;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + Math.cos(a) * 12, s.y + Math.sin(a) * 12); ctx.stroke();
    }
    // HP proužek
    if (s.hp < s.hpMax) {
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(s.tx * TILE + 3, s.ty * TILE - 1, TILE - 6, 3);
      ctx.fillStyle = '#5cff8a'; ctx.fillRect(s.tx * TILE + 3, s.ty * TILE - 1, (TILE - 6) * (s.hp / s.hpMax), 3);
    }
  }
}
function drawTraps() {
  for (const t of traps) {
    const d = t.def;
    if (d.arch === 'ONESHOT') {
      ctx.fillStyle = '#3a3a42'; roundRect(t.tx * TILE + 4, t.ty * TILE + 4, TILE - 8, TILE - 8, 3); ctx.fill();
      ctx.fillStyle = '#c8ccd4';
      for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.moveTo(t.tx * TILE + 8 + k * 8, t.ty * TILE + TILE - 6); ctx.lineTo(t.tx * TILE + 11 + k * 8, t.ty * TILE + 8); ctx.lineTo(t.tx * TILE + 14 + k * 8, t.ty * TILE + TILE - 6); ctx.fill(); }
    } else if (d.arch === 'SLOW') {
      ctx.fillStyle = '#241f14'; roundRect(t.tx * TILE + 2, t.ty * TILE + 2, TILE - 4, TILE - 4, 6); ctx.fill();
      ctx.fillStyle = 'rgba(60,50,30,.8)'; ctx.beginPath(); ctx.arc(t.x, t.y, 8, 0, Math.PI * 2); ctx.fill();
    } else if (d.arch === 'DOT_AOE') {
      ctx.fillStyle = 'rgba(255,120,40,.15)'; ctx.beginPath(); ctx.arc(t.x, t.y, d.radius, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff7b3a'; ctx.beginPath(); ctx.arc(t.x, t.y, 7, 0, Math.PI * 2); ctx.fill();
    }
  }
}
function drawGroundFx() {
  for (const g of groundFx) {
    ctx.fillStyle = 'rgba(255,110,40,.12)'; ctx.beginPath(); ctx.arc(g.x, g.y, g.radius, 0, Math.PI * 2); ctx.fill();
  }
}
function drawWarriors() {
  for (const wr of warriors) {
    ctx.fillStyle = wr.flash > 0 ? '#fff' : wr.def.color;
    ctx.beginPath(); ctx.arc(wr.x, wr.y, wr.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffffff88'; ctx.lineWidth = 2; ctx.stroke();
    // HP
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(wr.x - 12, wr.y - wr.r - 7, 24, 3);
    ctx.fillStyle = '#5cff8a'; ctx.fillRect(wr.x - 12, wr.y - wr.r - 7, 24 * (wr.hp / wr.hpMax), 3);
  }
}
function drawEnemies() {
  for (const e of enemies) {
    ctx.save(); ctx.translate(e.x, e.y);
    const col = e.flash > 0 ? '#ffffff' : e.color;
    if (e.arch === 'TANK' || e.arch === 'BOSS') {
      ctx.fillStyle = col; roundRect(-e.r, -e.r, e.r * 2, e.r * 2, 6); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.25)'; roundRect(-e.r + 4, -e.r + 4, e.r * 2 - 8, e.r * 2 - 8, 4); ctx.fill();
    } else {
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, 0, e.r, 0, Math.PI * 2); ctx.fill();
    }
    // oči
    ctx.fillStyle = e.arch === 'EXPLODER' ? '#ffec6a' : '#2a0000';
    ctx.beginPath(); ctx.arc(-e.r * 0.35, -e.r * 0.15, e.r * 0.16, 0, Math.PI * 2); ctx.arc(e.r * 0.35, -e.r * 0.15, e.r * 0.16, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // HP proužek
    if (e.hp < e.hpMax) {
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(e.x - e.r, e.y - e.r - 6, e.r * 2, 3);
      ctx.fillStyle = e.arch === 'BOSS' ? '#ff5c8a' : '#ff8a4a'; ctx.fillRect(e.x - e.r, e.y - e.r - 6, e.r * 2 * (e.hp / e.hpMax), 3);
    }
  }
}
function drawBullets() {
  for (const b of bullets) {
    ctx.fillStyle = b.color || '#ffe08a';
    if (b.thrown) { ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill(); }
    else { ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(Math.atan2(b.vy, b.vx)); ctx.fillRect(-5, -1.5, 10, 3); ctx.restore(); }
  }
  for (const b of eBullets) { ctx.fillStyle = b.color || '#8affb0'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill(); }
}
function drawEffects() {
  for (const e of effects) {
    if (e.type === 'swing') {
      ctx.globalAlpha = clamp(e.t / 8, 0, 0.8);
      ctx.strokeStyle = e.color || '#fff'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.range * 0.8, e.aim - e.spread, e.aim + e.spread); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (e.type === 'beam') {
      ctx.globalAlpha = clamp(e.t / 6, 0, 1);
      ctx.strokeStyle = e.color || '#9ad0ff'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (e.type === 'text') {
      ctx.globalAlpha = clamp(e.t / 30, 0, 1); ctx.fillStyle = e.color; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(e.txt, e.x, e.y - (30 - e.t) * 0.5); ctx.globalAlpha = 1; ctx.textAlign = 'left';
    }
  }
}
function drawPlayers() {
  const lp = localPlayer();
  for (const p of players) {
    // padlý hráč = poloprůhledný duch (čeká na oživení)
    if (p.downed) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff'; ctx.font = '12px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('✝', p.x, p.y - p.r - 4); ctx.textAlign = 'left';
      continue;
    }
    if (p.inv > 0 && Math.floor(p.inv / 5) % 2) continue;
    // označení vlastního hráče (kroužek)
    if (isCoop() && p === lp) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 5, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    // tělo
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 2; ctx.stroke();
    // směr / zbraň
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.cos(p.aimAngle) * (p.r + 8), p.y + Math.sin(p.aimAngle) * (p.r + 8)); ctx.stroke();
  }
}
function drawBuildGhost() {
  if (!buildSel) return;
  // ghost pod „posledním dotykem" — použijeme uložený hover
  if (buildHover) {
    const { tx, ty } = buildHover;
    const i = tileIndex(tx, ty);
    let ok = inBounds(tx, ty) && grid.tiles[i] !== 1 && !grid.coreTiles.includes(i);
    if (STRUCTURES[buildSel] || (TRAPS[buildSel] && TRAPS[buildSel].arch === 'EMITTER')) ok = ok && grid.structures[i] === null && pathExistsWith(tx, ty);
    ctx.globalAlpha = 0.5; ctx.fillStyle = ok ? '#5cff8a' : '#ff5c5c';
    roundRect(tx * TILE + 2, ty * TILE + 2, TILE - 4, TILE - 4, 5); ctx.fill();
    ctx.globalAlpha = 1;
  }
}
function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life);
    if (p.ring) { ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.stroke(); }
    else { ctx.fillStyle = p.color; const s = p.size || 3; ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s); }
  }
  ctx.globalAlpha = 1;
}

/* ---------- HUD ---------- */
function drawButton(r, label, active) {
  ctx.fillStyle = active ? '#3a5a34' : '#20261c';
  roundRect(r.x, r.y, r.w, r.h, 8); ctx.fill();
  ctx.strokeStyle = '#4a5a3a'; ctx.lineWidth = 1.5; roundRect(r.x, r.y, r.w, r.h, 8); ctx.stroke();
  ctx.fillStyle = '#e8ecd8'; ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}
function drawHud() {
  // horní info
  ctx.fillStyle = '#e8ecd8'; ctx.font = 'bold 15px system-ui'; ctx.textAlign = 'left';
  ctx.fillText('💎 ' + run.gems, 8, 22);
  ctx.fillText('❤ ' + run.lives, 8, 42);
  ctx.textAlign = 'center'; ctx.fillStyle = '#f0e0a0';
  ctx.fillText((wave && wave.boss ? 'BOSS ' : 'VLNA ') + run.wave, W / 2, 22);
  if (state === 'combat' && wave) {
    ctx.fillStyle = 'rgba(255,255,255,.15)'; roundRect(W / 2 - 70, 30, 140, 6, 3); ctx.fill();
    const prog = (wave.total - enemies.length - (wave.total - wave.spawned)) / wave.total;
    ctx.fillStyle = '#5cff8a'; roundRect(W / 2 - 70, 30, 140 * clamp(prog, 0, 1), 6, 3); ctx.fill();
  }
  // HUD pás pozadí
  ctx.fillStyle = '#12160e'; ctx.fillRect(0, ARENA_H, W, HUD_H);
  ctx.strokeStyle = '#2a331f'; ctx.beginPath(); ctx.moveTo(0, ARENA_H); ctx.lineTo(W, ARENA_H); ctx.stroke();

  if (state === 'combat') {
    const w = activeWeapon(players[0]);
    const ammoTxt = w.ammo === 'melee' ? '∞' : (w.ammo === 'mana' ? Math.floor(players[0].mana) + '⚡' : (run.ammo[w.ammo] || 0));
    drawButton(BTN.weapon, (w.cat === 'melee' ? '🗡 ' : '🏹 ') + w.name, false);
    ctx.fillStyle = '#b0c090'; ctx.font = '11px system-ui'; ctx.textAlign = 'left';
    ctx.fillText('munice: ' + ammoTxt, BTN.weapon.x + 6, BTN.weapon.y + BTN.weapon.h - 3);
    drawButton(BTN.switch2, '⇄ přepnout zbraň', false);
    drawButton(BTN.autofire, profile.settings.autofire ? '🎯 auto: ZAP' : '🎯 auto: VYP', profile.settings.autofire);
    drawButton(BTN.pause, '⏸', false);
    // mana proužek
    if (w.ammo === 'mana') { ctx.fillStyle = 'rgba(120,180,255,.3)'; ctx.fillRect(BTN.weapon.x, BTN.weapon.y - 5, BTN.weapon.w, 3); ctx.fillStyle = '#8fbaff'; ctx.fillRect(BTN.weapon.x, BTN.weapon.y - 5, BTN.weapon.w * (players[0].mana / players[0].manaMax), 3); }
    // HP hráče
    ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(8, ARENA_H - 10, W - 16, 5);
    ctx.fillStyle = '#ff6a6a'; ctx.fillRect(8, ARENA_H - 10, (W - 16) * (players[0].hp / players[0].hpMax), 5);
    // joysticky
    drawStick(moveStick, '#8fd08f'); drawStick(aimStick, '#f0c060');
  } else if (state === 'build') {
    drawBuildBar();
  }
}
function drawStick(s, color) {
  if (!s.active) return;
  ctx.globalAlpha = 0.5; ctx.strokeStyle = color; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(s.ox, s.oy, STICK_R, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(s.ox + s.dx, s.oy + s.dy, 18, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
}
function drawBuildBar() {
  const items = paletteItems();
  ctx.fillStyle = '#e8ecd8'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'left';
  ctx.fillText('💎 ' + run.gems + '  ·  Klepni na položku, pak na mapu. (Klepni na hotovou stavbu = prodej)', 8, ARENA_H + 20);
  const size = 40, gap = 6; let x = 8, y = ARENA_H + 28;
  paletteRects = [];
  for (const id of items) {
    const def = defOf(id);
    const r = { x, y, w: size, h: size, id };
    paletteRects.push(r);
    ctx.fillStyle = buildSel === id ? '#3a5a34' : '#20261c';
    roundRect(x, y, size, size, 6); ctx.fill();
    ctx.strokeStyle = buildSel === id ? '#8fd08f' : '#3a442c'; ctx.lineWidth = 2; roundRect(x, y, size, size, 6); ctx.stroke();
    ctx.fillStyle = def.color; roundRect(x + 8, y + 6, size - 16, size - 20, 3); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'right';
    ctx.fillText('×' + run.owned[id], x + size - 3, y + size - 3);
    x += size + gap;
    if (x + size > W - 140) { x = 8; y += size + gap; }
  }
  if (!items.length) { ctx.fillStyle = '#8a9070'; ctx.font = '12px system-ui'; ctx.fillText('Nemáš co stavět — nakup v obchodu.', 8, ARENA_H + 50); }
  const meReady = net.role === 'guest' ? readyGuest : readyHost;
  const label = !isCoop() ? '▶ START VLNY' : (meReady ? '✔ PŘIPRAVEN' : '▶ PŘIPRAVEN?');
  drawButton(BTN.start, label, meReady);
  if (isCoop()) {
    const other = net.role === 'guest' ? readyHost : readyGuest;
    ctx.fillStyle = other ? '#8fd08f' : '#c0a060'; ctx.font = '11px system-ui'; ctx.textAlign = 'right';
    ctx.fillText(other ? 'spoluhráč připraven ✔' : 'spoluhráč staví…', W - 6, ARENA_H + 46); ctx.textAlign = 'left';
  }
}
let paletteRects = [];
function drawBanner() {
  ctx.globalAlpha = clamp(banner.t / 40, 0, 1); ctx.textAlign = 'center';
  ctx.fillStyle = banner.warn ? '#ff5c8a' : '#f0e0a0'; ctx.font = 'bold 28px system-ui';
  ctx.fillText(banner.text, W / 2, ARENA_H / 2);
  ctx.globalAlpha = 1; ctx.textAlign = 'left';
}

/* ============================================================================
   OVLÁDÁNÍ (touch twin-stick + build + klávesnice/myš fallback)
   ========================================================================== */
const moveStick = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
const aimStick = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
let buildHover = null;

function evtPos(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return { x: (clientX - r.left) * (W / r.width), y: (clientY - r.top) * (H / r.height) };
}
function hudTap(x, y) {
  if (state === 'combat') {
    if (inRect(x, y, BTN.pause)) { togglePause(); return true; }
    if (inRect(x, y, BTN.autofire)) { profile.settings.autofire = !profile.settings.autofire; saveProfile(profile); return true; }
    if (inRect(x, y, BTN.weapon) || inRect(x, y, BTN.switch2)) { localCycleWeapon(); return true; }
    return true; // klik do HUD pásu neřeší stick
  }
  if (state === 'build') {
    if (inRect(x, y, BTN.start)) { toggleReady(); return true; }
    for (const r of paletteRects) if (inRect(x, y, r)) { buildSel = (buildSel === r.id ? null : r.id); return true; }
    return true;
  }
  return true;
}
function cycleWeapon(p) {
  p = p || localPlayer();
  if (!p) return;
  const list = run.ownedWeapons;
  const i = list.indexOf(p.weaponId);
  p.weaponId = list[(i + 1) % list.length];
  sfx.place();
}
function localCycleWeapon() {
  if (net.role === 'guest') { netSend({ t: 'cmd', act: 'cycle' }); return; }
  cycleWeapon(players[0]);
}
// „START VLNY" = potvrzení připravenosti; v co-op se čeká na oba.
function toggleReady() {
  if (!isCoop()) { startWave(); return; }
  if (net.role === 'guest') {
    readyGuest = !readyGuest;
    netSend({ t: 'cmd', act: readyGuest ? 'ready' : 'unready' });
    banner = { text: readyGuest ? 'Připraven — čekáš na hostitele' : 'Připravenost zrušena', t: 60 };
    return;
  }
  readyHost = !readyHost;
  if (readyHost && readyGuest) startWave();
  else banner = { text: readyHost ? 'Připraven — čekáš na spoluhráče' : 'Připravenost zrušena', t: 60 };
}
function togglePause() {
  if (state === 'combat') { state = 'paused'; }
  else if (state === 'paused') { state = 'combat'; lastTime = performance.now(); }
}

canvas.addEventListener('touchstart', e => {
  e.preventDefault(); initAudio();
  for (const t of e.changedTouches) {
    const pos = evtPos(t.clientX, t.clientY);
    if (state === 'paused') { togglePause(); continue; }
    if (!inArena(pos.y)) { hudTap(pos.x, pos.y); continue; }
    if (state === 'build') { handleBuildTap(pos.x, pos.y); continue; }
    if (state === 'combat') {
      if (pos.x < W / 2 && !moveStick.active) startStick(moveStick, t.identifier, pos);
      else startStick(aimStick, t.identifier, pos);
    }
  }
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const pos = evtPos(t.clientX, t.clientY);
    if (moveStick.id === t.identifier) moveStickUpdate(moveStick, pos);
    else if (aimStick.id === t.identifier) moveStickUpdate(aimStick, pos);
    else if (state === 'build') buildHover = tileOf(pos.x, pos.y);
  }
}, { passive: false });
canvas.addEventListener('touchend', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (moveStick.id === t.identifier) endStick(moveStick);
    else if (aimStick.id === t.identifier) endStick(aimStick);
  }
}, { passive: false });
canvas.addEventListener('touchcancel', e => {
  for (const t of e.changedTouches) { if (moveStick.id === t.identifier) endStick(moveStick); else if (aimStick.id === t.identifier) endStick(aimStick); }
}, { passive: false });

function startStick(s, id, pos) { s.active = true; s.id = id; s.ox = pos.x; s.oy = pos.y; s.dx = 0; s.dy = 0; applyStick(s); }
function moveStickUpdate(s, pos) {
  let dx = pos.x - s.ox, dy = pos.y - s.oy; const d = Math.hypot(dx, dy);
  if (d > STICK_R) { dx = dx / d * STICK_R; dy = dy / d * STICK_R; }
  s.dx = dx; s.dy = dy; applyStick(s);
}
function endStick(s) {
  s.active = false; s.id = null; s.dx = 0; s.dy = 0;
  if (s === moveStick) { myInput.mx = 0; myInput.my = 0; }
  else { myInput.aiming = false; }
}
function applyStick(s) {
  if (s === moveStick) { myInput.mx = s.dx / STICK_R; myInput.my = s.dy / STICK_R; }
  else if (Math.hypot(s.dx, s.dy) > 8) { myInput.aimAngle = Math.atan2(s.dy, s.dx); myInput.aiming = true; }
}
function handleBuildTap(x, y) {
  const { tx, ty } = tileOf(x, y);
  buildHover = { tx, ty };
  if (net.role === 'guest') {
    // guest neřeší lokálně — pošle příkaz hostiteli
    if (buildSel) netSend({ t: 'cmd', act: 'place', sel: buildSel, tx, ty });
    else netSend({ t: 'cmd', act: 'sell', tx, ty });
    return;
  }
  if (!buildSel && sellAt(tx, ty)) return;
  if (buildSel) placeAt(tx, ty);
  else sellAt(tx, ty);
}

/* ---------- Klávesnice + myš (desktop) ---------- */
const keys = {};
window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase(); keys[k] = true;
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
  if (k === 'p') togglePause();
  if (k === 'm') { muted = !muted; profile.settings.muted = muted; saveProfile(profile); if (!muted) initAudio(); }
  if (k === 'q' && run) localCycleWeapon();
});
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
canvas.addEventListener('mousemove', e => {
  const pos = evtPos(e.clientX, e.clientY);
  const lp = localPlayer();
  if (state === 'combat' && lp) { myInput.aimAngle = Math.atan2(pos.y - lp.y, pos.x - lp.x); if (mouseDown) myInput.aiming = true; }
  if (state === 'build') buildHover = tileOf(pos.x, pos.y);
});
canvas.addEventListener('mousedown', e => {
  initAudio(); const pos = evtPos(e.clientX, e.clientY);
  if (state === 'paused') { togglePause(); return; }
  if (!inArena(pos.y)) { hudTap(pos.x, pos.y); return; }
  if (state === 'build') { handleBuildTap(pos.x, pos.y); return; }
  if (state === 'combat') myInput.aiming = true;
});
canvas.addEventListener('mouseup', () => { myInput.aiming = false; });
// Klávesnicový pohyb píše do myInput (host/solo ho aplikuje, guest odesílá).
function keyboardMove() {
  if (state !== 'combat') return;
  let mx = 0, my = 0;
  if (keys['a'] || keys['arrowleft']) mx -= 1;
  if (keys['d'] || keys['arrowright']) mx += 1;
  if (keys['w'] || keys['arrowup']) my -= 1;
  if (keys['s'] || keys['arrowdown']) my += 1;
  if (mx || my) { const d = Math.hypot(mx, my); myInput.mx = mx / d; myInput.my = my / d; }
  else if (!moveStick.active) { myInput.mx = 0; myInput.my = 0; }
  if (keys[' ']) myInput.aiming = true;
}
let mouseDown = false;
canvas.addEventListener('mousedown', () => mouseDown = true);
window.addEventListener('mouseup', () => mouseDown = false);

/* ============================================================================
   SMYČKA
   ========================================================================== */
function loop(now) {
  try {
    const dt = Math.min(3, (now - lastTime) / 16.67);
    lastTime = now;
    if (net.role === 'guest') {
      // guest nepočítá simulaci — jen posílá vstup a vykresluje poslední přijatý snímek
      if (state === 'combat') keyboardMove();
      if (typeof netSendInput === 'function') netSendInput();
      render();
    } else {
      if (state === 'combat') { keyboardMove(); applyLocalInput(); }
      if (state !== 'paused') update(dt);
      render();
      if (net.role === 'host' && net.connected && typeof netSendState === 'function') netSendState();
    }
    if (state === 'paused') { ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#fff'; ctx.font = 'bold 26px system-ui'; ctx.textAlign = 'center'; ctx.fillText('PAUZA', W / 2, H / 2); ctx.font = '13px system-ui'; ctx.fillStyle = '#b0c090'; ctx.fillText('Klepni pro pokračování', W / 2, H / 2 + 26); ctx.textAlign = 'left'; }
  } catch (err) {
    showFatal((err && err.message) || String(err));
  }
  requestAnimationFrame(loop);
}

/* ---------- Boot ---------- */
buildArena();
fitCanvas();
setState('menu');
requestAnimationFrame(loop);

// Service worker (PWA)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
