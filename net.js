/* ============================================================================
   RYTÍŘI A NEMRTVÍ — co-op síťování (net.js)
   Čisté WebRTC (DataChannel) s RUČNÍM spojovacím kódem — bez serveru i knihovny.
   Model host-authoritative: hostitel počítá simulaci a posílá snímky, guest
   posílá vstup/příkazy a jen vykresluje. Sdílený global scope s game.js.
   ========================================================================== */

/* Signaling přes veřejný broker PeerJS → krátký ČÍSELNÝ kód hry (6 číslic).
   Hostitel si u brokeru zaregistruje kód, spoluhráč zadá jen těch 6 čísel.
   Samotné herní spojení je pořád přímé peer-to-peer (WebRTC DataChannel). */
const PEER_OPTS = { config: { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
] } };
let netFrame = 0, inputFrame = 0;
let netCode = '';        // 6místný kód hry (u hostitele)
let peerObj = null;      // instance PeerJS Peer

function hasPeerJS() { return typeof Peer !== 'undefined'; }
function randCode() { return String(Math.floor(100000 + Math.random() * 900000)); }

/* Napojení PeerJS DataConnection přes shim, aby zbytek net.js (net.dc.send /
   readyState) fungoval beze změny. */
function wireConn(conn) {
  net.conn = conn;
  net.dc = {
    get readyState() { return conn.open ? 'open' : 'connecting'; },
    send: s => { try { conn.send(s); } catch {} },
    close: () => { try { conn.close(); } catch {} },
  };
  conn.on('data', d => {
    try { netDispatch(typeof d === 'string' ? JSON.parse(d) : d); }
    catch (e) { showFatal('net: ' + e.message); }
  });
  conn.on('open', () => {
    net.connected = true;
    net.hostClass = null; net.guestClass = null;
    setState('class');
  });
  conn.on('close', () => netOnDisconnect());
  conn.on('error', () => netOnDisconnect());
}
function netOnDisconnect() {
  if (!net.connected) return;
  net.connected = false;
  if (net.role === 'host') {
    // pokračuj sólo
    if (players.length > 1) players.length = 1;
    net.role = null; net.mode = 'solo';
    banner = { text: 'Spoluhráč se odpojil — hraješ dál sám', t: 120, warn: true };
  } else {
    net.role = null; net.mode = 'solo';
    setState('menu');
    banner = { text: 'Spojení ztraceno', t: 120, warn: true };
  }
}
function netClose() {
  try { if (net.dc) net.dc.close(); } catch {}
  try { if (net.conn) net.conn.close(); } catch {}
  try { if (peerObj) peerObj.destroy(); } catch {}
  net.dc = null; net.conn = null; peerObj = null; net.connected = false;
  netCode = '';
}
function netSend(msg) { const dc = net.dc; if (dc && dc.readyState === 'open') { try { dc.send(JSON.stringify(msg)); } catch {} } }

/* ---------- Hostitel ---------- */
function netHost() {
  netClose(); net.role = 'host'; net.mode = 'coop';
  if (!hasPeerJS()) { lobbyError('Nepodařilo se načíst online modul. Zkontroluj připojení k internetu.'); return; }
  tryHostWithCode(0);
}
function tryHostWithCode(attempt) {
  netCode = randCode();
  if (state === 'host') renderHostLobby();
  const peer = new Peer(netCode, PEER_OPTS); peerObj = peer;
  peer.on('open', () => { if (state === 'host') renderHostLobby(); });
  peer.on('connection', conn => { wireConn(conn); });
  peer.on('error', err => {
    // kód už někdo zabral → zkus jiný (max 5×)
    if (err && err.type === 'unavailable-id' && attempt < 5) { try { peer.destroy(); } catch {} tryHostWithCode(attempt + 1); return; }
    if (!net.connected) lobbyError('Chyba online spojení: ' + (err && err.type ? err.type : 'neznámá') + '. Zkus to prosím znovu.');
  });
}

/* ---------- Guest ---------- */
function netJoinConnect() {
  const el = document.getElementById('codeIn');
  const code = el && el.value ? el.value.replace(/\D/g, '') : '';
  if (code.length !== 6) { alert('Zadej 6místný kód hry od hostitele.'); return; }
  if (!hasPeerJS()) { lobbyError('Nepodařilo se načíst online modul. Zkontroluj připojení k internetu.'); return; }
  netClose(); net.role = 'guest'; net.mode = 'coop';
  const status = document.getElementById('joinStatus');
  if (status) status.textContent = 'Připojuji se ke hře ' + code + '…';
  const peer = new Peer(PEER_OPTS); peerObj = peer;
  peer.on('open', () => {
    const conn = peer.connect(code, { reliable: true });
    wireConn(conn);
    setTimeout(() => { if (!net.connected) { const s = document.getElementById('joinStatus'); if (s) s.textContent = 'Nedaří se připojit — zkontroluj kód a zkus to znovu.'; } }, 8000);
  });
  peer.on('error', err => { if (!net.connected) { const s = document.getElementById('joinStatus'); if (s) s.textContent = 'Chyba: kód nenalezen nebo spojení selhalo. Zkus to znovu.'; } });
}

function lobbyError(msg) { if (typeof ovContent !== 'undefined' && ovContent) { const p = document.getElementById('lobbyErr'); if (p) p.textContent = msg; else ovContent.insertAdjacentHTML('beforeend', `<p id="lobbyErr" style="color:#e06060">${escapeHtml(msg)}</p>`); } }

/* ---------- Kopírování kódu hry ---------- */
function netCopy(which, el) {
  const val = netCode || '';
  const done = () => { if (el) { const o = el.textContent; el.textContent = '✔ Zkopírováno'; setTimeout(() => { el.textContent = o; }, 1200); } };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(val).then(done, () => {});
}

/* ---------- Lobby UI ---------- */
function renderHostLobby() {
  const ready = !!(peerObj && peerObj.open) || !!netCode;
  ovContent.innerHTML = `
    <h2>Hostovat co-op</h2>
    <p>Řekni spoluhráči tento <b>kód hry</b>. Zadá ho na svém telefonu v <b>Připojit se</b>.</p>
    <p class="lbl">Kód hry:</p>
    <div class="gamecode">${ready ? escapeHtml(netCode) : '· · · · · ·'}</div>
    <button data-act="copycode" data-which="code"${ready ? '' : ' disabled'}>📋 Kopírovat kód</button>
    <p style="color:#c0a060">Čekání na spoluhráče…</p>
    <button data-act="menu" class="ghost">Zrušit</button>`;
}
function renderJoinLobby() {
  ovContent.innerHTML = `
    <h2>Připojit se ke hře</h2>
    <p>Zadej <b>6místný kód hry</b>, který ti řekl hostitel.</p>
    <input id="codeIn" class="codeinput" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" autocomplete="off">
    <button data-act="joinconnect">Připojit se</button>
    <p id="joinStatus" style="color:#8fb070"></p>
    <button data-act="menu" class="ghost">Zrušit</button>`;
}

/* ============================================================================
   DISPATCH přijatých zpráv
   ========================================================================== */
function netDispatch(m) {
  if (net.role === 'host') {
    if (m.t === 'class') { net.guestClass = m.classId; if (net.hostClass) startCoop(); }
    else if (m.t === 'input') {
      const p = players[1];
      if (p) { p.input.mx = m.mx; p.input.my = m.my; p.input.aiming = m.aiming; p.aimAngle = m.aimAngle; p.autoaim = !!m.aa; p.autofire = !!m.af; }
    } else if (m.t === 'cmd') netHandleCmd(m);
  } else if (net.role === 'guest') {
    if (m.t === 'state') applyState(m.s);
  }
}
function netHandleCmd(m) {
  switch (m.act) {
    case 'buyweapon': buyWeapon(m.id, players[1]); break;
    case 'buyammo': buyAmmo(m.id, players[1]); break;
    case 'buybuild': buyBuild(m.id, players[1]); break;
    case 'upstat': buyUpgrade(m.id, players[1]); break;
    case 'upweapon': buyWeaponUp(m.id, players[1]); break;
    case 'buylife': buyLife(players[1]); break;
    case 'toshop': setState('shop'); break;
    case 'perkpick': choosePerk(players[1], m.id); break;
    case 'upshield': buyShield(players[1]); break;
    case 'wheelpick': chooseWheel(m.id); break;
    case 'pactpick': choosePact(m.id); break;
    case 'sready': readyGuest = true; if (readyHost) startBuildPhase(); break;
    case 'sunready': readyGuest = false; break;
    case 'cycle': cycleWeapon(players[1]); break;
    case 'ability': useAbility(players[1]); break;
    case 'ready': readyGuest = true; if (readyHost) { startWave(); } break;
    case 'unready': readyGuest = false; break;
    case 'place': { const prev = buildSel; buildSel = m.sel; placeAt(m.tx, m.ty); buildSel = prev; break; }
    case 'sell': sellAt(m.tx, m.ty, players[1]); break;
    case 'upgrade': upgradeAt(m.tx, m.ty, players[1]); break;
  }
  netPush(); // po změně stavu okamžitě sesynchronizuj guesta
}

/* ============================================================================
   SNAPSHOT_SCHEMA — JEDEN ZDROJ PRAVDY pro serializeState() i applyState().
   Pole každé entity se vyjmenují JEDNOU zde; serialize i apply je čtou odsud.
   Zápis pole:
     'jmeno'                  → přímá kopie (obj.jmeno), beze změny hodnoty
     { key, def }              → obj[key] || def   (stejná sémantika jako dřívější `x || 0`/`|| {}`/`|| []`/`|| null`)
     { key, bool: true }       → !!obj[key]
   `rehydrate(obj)` (volitelný) se po applyState() zavolá na KAŽDÝ prvek dané
   entity a doplní netransportovatelné věci (napojení `.def`/`.class`, apod.).
   ========================================================================== */
const SNAPSHOT_SCHEMA = {
  run: {
    single: true,
    fields: [
      'lives', 'wave', { key: 'score', def: 0 }, 'ownedWeapons', 'ammo', 'owned', 'upgrades', 'wUpgrades',
      { key: 'wood', def: 0 }, { key: 'steel', def: 0 }, { key: 'combo', def: 0 }, { key: 'comboT', def: 0 },
      { key: 'shieldLvl', def: 0 }, { key: 'wheelReady', def: 0 }, { key: 'wheelUpgrades', def: {} },
      { key: 'turretKills', def: 0 }, { key: 'wheelThreshold', def: 2 }, { key: 'pacts', def: [] },
      { key: '_pactOffer', def: null }, { key: 'lifeBuys', def: 0 },
    ],
  },
  wave: { single: true, fields: ['boss', 'spawned', 'total', 'reward'] },
  banner: { single: true, fields: ['text', 't', 'warn'] },
  players: {
    list: true,
    fields: [
      'x', 'y', 'r', 'hp', 'hpMax', { key: 'gems', def: 0 }, 'aimAngle', 'inv', 'downed', 'classId', 'color',
      'weaponId', 'mana', 'manaMax', { key: 'walk', def: 0 }, { key: 'buffRapid', def: 0 }, { key: 'buffPower', def: 0 },
      { key: 'shieldT', def: 0 }, { key: 'rageT', def: 0 }, { key: 'abilityCd', def: 0 }, { key: 'perks', def: {} },
      { key: 'perkOffer', def: null }, { key: 'blockT', def: 0 }, { key: 'invisT', def: 0 }, { key: 'flurryT', def: 0 },
      { key: 'abomT', def: 0 }, { key: 'potions', def: 0 }, { key: 'bile', def: 0 }, { key: 'clanCd', def: 0 },
      { key: 'resurrectUsed', bool: true }, { key: '_clanActive', bool: true },
    ],
    rehydrate(p) {
      p.class = CLASSES[p.classId]; p.basePassive = p.class ? p.class.passive : {};
      p.perks = p.perks || {}; p.input = { mx: 0, my: 0, aiming: false };
      recalcPerks(p);
    },
  },
  enemies: {
    list: true,
    fields: [
      'id', 'x', 'y', 'r', 'hp', 'hpMax', 'flash', 'arch', 'color', 'typeId', 'elite', 'spawnT',
      { key: 'slamWind', def: 0 }, 'slamWindMax', 'slamX', 'slamY', 'slamR',
    ],
    rehydrate(e) { e.def = ENEMIES[e.typeId] || {}; },
  },
  bullets: { list: true, fields: ['x', 'y', 'vx', 'vy', 'r', 'color', 'thrown', 'magic', 'ang', 'crit'] },
  eBullets: { list: true, fields: ['x', 'y', 'r', 'color'] },
  walls: {
    list: true,
    fields: ['defId', 'tx', 'ty', 'x', 'y', 'hp', 'hpMax', 'flash', 'temp', { key: 'level', def: 0 }],
    rehydrate(o) { o.def = STRUCTURES[o.defId] || TRAPS[o.defId]; },
  },
  turrets: {
    list: true,
    fields: ['defId', 'tx', 'ty', 'x', 'y', 'hp', 'hpMax', 'flash', 'temp', { key: 'level', def: 0 }],
    rehydrate(o) { o.def = TRAPS[o.defId]; },
  },
  traps: {
    list: true,
    fields: ['defId', 'tx', 'ty', 'x', 'y', 'dur', { key: 'level', def: 0 }],
    rehydrate(o) { o.def = TRAPS[o.defId]; },
  },
  warriors: {
    list: true,
    fields: ['defId', 'x', 'y', 'r', 'hp', 'hpMax', 'flash', 'aim'],
    rehydrate(o) { o.def = WARRIORS[o.defId] || (o.defId === 'clan_axeman' ? CLAN_AXEMAN : { color: '#d07038', arch: 'MELEE' }); },
  },
  groundFx: { list: true, fields: ['x', 'y', 'radius', 'color'] },
  pickups: { list: true, fields: ['id', 'x', 'y', 'bob'] },
};

// Serializuje jeden objekt podle pole `fields` ze schématu (viz komentář výše).
function schemaPick(obj, fields) {
  const out = {};
  for (const f of fields) {
    if (typeof f === 'string') out[f] = obj[f];
    else if (f.bool) out[f.key] = !!obj[f.key];
    else out[f.key] = obj[f.key] || f.def;
  }
  return out;
}
function schemaSerList(schemaKey, arr) { return arr.map(o => schemaPick(o, SNAPSHOT_SCHEMA[schemaKey].fields)); }
function schemaSerSingle(schemaKey, obj) { return obj && schemaPick(obj, SNAPSHOT_SCHEMA[schemaKey].fields); }
// Po převzetí pole ze snímku dovoláme rehydrate() (napojení def/class) na každý prvek.
function schemaApplyList(schemaKey, arr) {
  const rehydrate = SNAPSHOT_SCHEMA[schemaKey].rehydrate;
  if (rehydrate) for (const o of arr) rehydrate(o);
  return arr;
}

/* ============================================================================
   SERIALIZACE (host → guest)
   ========================================================================== */
function serializeState() {
  const snap = {
    st: state, map: currentMap,
    run: schemaSerSingle('run', run),
    wave: schemaSerSingle('wave', wave),
    banner: schemaSerSingle('banner', banner),
    readyHost, readyGuest, freezeTimer,
    players: schemaSerList('players', players),
    enemies: schemaSerList('enemies', enemies),
    bullets: schemaSerList('bullets', bullets),
    eBullets: schemaSerList('eBullets', eBullets),
    walls: schemaSerList('walls', walls),
    turrets: schemaSerList('turrets', turrets),
    traps: schemaSerList('traps', traps),
    warriors: schemaSerList('warriors', warriors),
    groundFx: schemaSerList('groundFx', groundFx),
    pickups: schemaSerList('pickups', pickups),
    effects: effects.map(e => ({ ...e })),
    ev: netEvents,
  };
  netEvents = [];   // odeslané události zahodíme (jsou jednorázové)
  return snap;
}

// Podpis ekonomiky pro rozhodnutí, kdy překreslit obchod na guestovi.
function shopSig(r) { return r ? meGems() + '|' + r.lives + '|' + (r.ownedWeapons ? r.ownedWeapons.length : 0) + '|' + JSON.stringify(r.owned) + '|' + JSON.stringify(r.ammo) + '|' + JSON.stringify(r.upgrades) + '|' + JSON.stringify(r.wUpgrades) + '|' + (r.wood || 0) + '|' + (r.steel || 0) + '|' + readyHost + readyGuest : ''; }
let lastShopSig = '';

function applyState(s) {
  // změna mapy → guest přenačte arénu (stejný seed = stejný terén)
  if (s.map != null && s.map !== currentMap) loadMap(s.map);
  // ekonomika / run
  if (s.run) { if (!run) run = {}; Object.assign(run, s.run); if (!run.class && players[0]) run.class = players[0].class; }
  readyHost = s.readyHost; readyGuest = s.readyGuest;
  freezeTimer = s.freezeTimer || 0;
  wave = s.wave ? s.wave : null;
  banner = s.banner ? s.banner : null;
  // hráči (napojíme třídu z classId) — applyState() staví pole ZNOVA (nové objekty), takže by jinak
  // guest ztratil vyhlazenou render-pozici (rx/ry) při každém snímku. Napřed si ji uložíme (podle
  // indexu — 0=hostitel, 1=guest, pořadí je stabilní), po rebuildu ji naSeedujeme do nových objektů.
  const prevPlayersRender = players.map(p => ({ rx: p.rx != null ? p.rx : p.x, ry: p.ry != null ? p.ry : p.y }));
  players.length = 0;
  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i];
    SNAPSHOT_SCHEMA.players.rehydrate(p);
    const prev = prevPlayersRender[i];
    if (prev) { p.rx = prev.rx; p.ry = prev.ry; } else { p.rx = p.x; p.ry = p.y; }   // nový hráč = objeví se rovnou na místě
    players.push(p);
  }
  // nepřátelé — napojíme def podle typeId (kvůli vykreslení bosse/pancíře); render-pozici (rx/ry)
  // spárujeme podle stabilního `id` (viz spawnEnemy v game.js), aby vyhlazování nenaskočilo mezi snímky.
  const prevEnemyRender = new Map();
  for (const e of enemies) if (e.id != null) prevEnemyRender.set(e.id, { rx: e.rx != null ? e.rx : e.x, ry: e.ry != null ? e.ry : e.y });
  enemies = schemaApplyList('enemies', s.enemies);
  for (const e of enemies) {
    const prev = prevEnemyRender.get(e.id);
    if (prev) { e.rx = prev.rx; e.ry = prev.ry; } else { e.rx = e.x; e.ry = e.y; }   // nově příchozí = objeví se rovnou na místě
  }
  bullets = s.bullets; eBullets = s.eBullets;
  walls = schemaApplyList('walls', s.walls);
  turrets = schemaApplyList('turrets', s.turrets);
  traps = schemaApplyList('traps', s.traps);
  warriors = schemaApplyList('warriors', s.warriors);
  groundFx = s.groundFx;
  pickups = s.pickups || [];
  effects = s.effects || [];
  // jednorázové události → kosmetika u guesta
  if (s.ev) for (const ev of s.ev) guestEvent(ev);
  // stav / overlay
  if (s.st !== state) {
    if (s.st === 'combat' || s.st === 'build') { particles = []; floaters = []; decals = []; edgeFlashes = []; }
    setState(s.st);
    lastShopSig = shopSig(run);
  } else if (s.st === 'shop') {
    const sig = shopSig(run);
    if (sig !== lastShopSig) { renderShop(); lastShopSig = sig; }
  }
}
// Guest vytvoří lokální efekt/zvuk podle události od hostitele.
function guestEvent(ev) {
  if (ev.k === 'hit') { spawnFloater(ev.x, ev.y, ev.d, !!ev.c); burst(ev.x, ev.y, '#ffd0d0', ev.c ? 6 : 3); sfx.hitFlesh(); }
  else if (ev.k === 'die') { zombieDeath(ev.x, ev.y, ev.color, ev.big, ev.s || 0); shake = Math.min(9, shake + (ev.big ? 5 : 1.2)); }
  else if (ev.k === 'freeze') { flash = 0.2; sfx.magic(); }
  else if (ev.k === 'pick') { burst(ev.x, ev.y, ev.color, 14); sfx.heal(); }
  else if (ev.k === 'ability') { sfx.buy(); }
  else if (ev.k === 'spawn') { burst(ev.x, ev.y, 'rgba(150,40,60,0.6)', 4); }
}

/* ============================================================================
   RENDER-VYHLAZENÍ (FÁZE 3 co-op) — jen KOSMETIKA, nikdy autoritativní data.
   Guest dostává snímky ~30×/s (viz netSendState); bez vyhlazení entity mezi snímky
   viditelně „skáčou". Řešení: robustní exponenciální vyhlazování — render-pozice
   (rx/ry) se každý VYKRESLENÝ snímek posune o zlomek k autoritativní pozici (x/y).
   Žádná časová razítka, žádné přestřelení, nevyžaduje přesné timingy.
   U sóla/hostitele se rx/ry KAŽDÝ snímek přímo přepíší na x/y (viz updateRenderPositions
   níže) → vizuál je bit-identický s chováním před FÁZÍ 3, žádná regrese.
   ========================================================================== */
const RENDER_SMOOTH_K = 0.30;   // zlomek vzdálenosti k cíli za 1 vykreslený snímek (~60/s) — dolaďeno na pocit
// Čistá funkce (testovatelná samostatně): posune `cur` o zlomek `k` k `target`; při malém
// rozdílu (< 0.5 px) rovnou přichytí, ať vyhlazování nikdy „nedobíhá" donekonečna.
function smoothToward(cur, target, k) {
  const d = target - cur;
  if (Math.abs(d) < 0.5) return target;
  return cur + d * k;
}
// Zavolá se KAŽDÝ vykreslený snímek (render()), pro sólo/host/guest stejně.
function updateRenderPositions() {
  if (net.role === 'guest') {
    for (const e of enemies) { e.rx = smoothToward(e.rx != null ? e.rx : e.x, e.x, RENDER_SMOOTH_K); e.ry = smoothToward(e.ry != null ? e.ry : e.y, e.y, RENDER_SMOOTH_K); }
    for (const p of players) { p.rx = smoothToward(p.rx != null ? p.rx : p.x, p.x, RENDER_SMOOTH_K); p.ry = smoothToward(p.ry != null ? p.ry : p.y, p.y, RENDER_SMOOTH_K); }
  } else {
    // sólo/hostitel: PŘÍMÉ přiřazení (ne aritmetika) → rx/ry === x/y bit-přesně, nulové riziko regrese.
    for (const e of enemies) { e.rx = e.x; e.ry = e.y; }
    for (const p of players) { p.rx = p.x; p.ry = p.y; }
  }
}

/* ============================================================================
   ODESÍLÁNÍ (host snímky, guest vstup)
   ========================================================================== */
function netSendState() {
  if (net.role !== 'host' || !net.connected) return;
  netFrame++;
  const interval = state === 'combat' ? 2 : 8;   // ~30/s v boji, jinak řídce
  if (netFrame % interval !== 0) return;
  netSend({ t: 'state', s: serializeState() });
}
function netPush() {   // okamžitá synchronizace po změně (nákup, položení, přechod stavu)
  if (net.role === 'host' && net.connected) netSend({ t: 'state', s: serializeState() });
}
function netSendInput() {
  if (net.role !== 'guest' || !net.connected) return;
  inputFrame++;
  if (inputFrame % 2 !== 0) return;   // ~30/s
  netSend({ t: 'input', mx: myInput.mx, my: myInput.my, aiming: myInput.aiming, aimAngle: myInput.aimAngle, aa: profile.settings.autoaim, af: profile.settings.autofire });
}
