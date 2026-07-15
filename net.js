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
   SERIALIZACE (host → guest)
   ========================================================================== */
function serializeState() {
  const snap = {
    st: state, map: currentMap,
    run: run && { lives: run.lives, wave: run.wave, score: run.score || 0, ownedWeapons: run.ownedWeapons, ammo: run.ammo, owned: run.owned, upgrades: run.upgrades, wUpgrades: run.wUpgrades, wood: run.wood || 0, steel: run.steel || 0, combo: run.combo || 0, comboT: run.comboT || 0, shieldLvl: run.shieldLvl || 0, wheelReady: run.wheelReady || 0, wheelUpgrades: run.wheelUpgrades || {}, turretKills: run.turretKills || 0, wheelThreshold: run.wheelThreshold || 2, pacts: run.pacts || [], _pactOffer: run._pactOffer || null },
    wave: wave && { boss: wave.boss, spawned: wave.spawned, total: wave.total, reward: wave.reward },
    banner: banner && { text: banner.text, t: banner.t, warn: banner.warn },
    readyHost, readyGuest, freezeTimer,
    players: players.map(p => ({ x: p.x, y: p.y, r: p.r, hp: p.hp, hpMax: p.hpMax, gems: p.gems || 0, aimAngle: p.aimAngle, inv: p.inv, downed: p.downed, classId: p.classId, color: p.color, weaponId: p.weaponId, mana: p.mana, manaMax: p.manaMax, walk: p.walk || 0, buffRapid: p.buffRapid || 0, buffPower: p.buffPower || 0, shieldT: p.shieldT || 0, rageT: p.rageT || 0, abilityCd: p.abilityCd || 0, perks: p.perks || {}, perkOffer: p.perkOffer || null, blockT: p.blockT || 0, invisT: p.invisT || 0, flurryT: p.flurryT || 0, abomT: p.abomT || 0, potions: p.potions || 0, bile: p.bile || 0, clanCd: p.clanCd || 0, resurrectUsed: !!p.resurrectUsed, _clanActive: !!p._clanActive })),
    enemies: enemies.map(e => ({ x: e.x, y: e.y, r: e.r, hp: e.hp, hpMax: e.hpMax, flash: e.flash, arch: e.arch, color: e.color, typeId: e.typeId, elite: e.elite, spawnT: e.spawnT, slamWind: e.slamWind || 0, slamWindMax: e.slamWindMax, slamX: e.slamX, slamY: e.slamY, slamR: e.slamR })),
    bullets: bullets.map(b => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: b.r, color: b.color, thrown: b.thrown, magic: b.magic, ang: b.ang, crit: b.crit })),
    eBullets: eBullets.map(b => ({ x: b.x, y: b.y, r: b.r, color: b.color })),
    walls: walls.map(s => ({ defId: s.defId, tx: s.tx, ty: s.ty, x: s.x, y: s.y, hp: s.hp, hpMax: s.hpMax, flash: s.flash, temp: s.temp, level: s.level || 0 })),
    turrets: turrets.map(s => ({ defId: s.defId, tx: s.tx, ty: s.ty, x: s.x, y: s.y, hp: s.hp, hpMax: s.hpMax, flash: s.flash, temp: s.temp, level: s.level || 0 })),
    traps: traps.map(t => ({ defId: t.defId, tx: t.tx, ty: t.ty, x: t.x, y: t.y, dur: t.dur, level: t.level || 0 })),
    warriors: warriors.map(w => ({ defId: w.defId, x: w.x, y: w.y, r: w.r, hp: w.hp, hpMax: w.hpMax, flash: w.flash, aim: w.aim })),
    groundFx: groundFx.map(g => ({ x: g.x, y: g.y, radius: g.radius, color: g.color })),
    pickups: pickups.map(pu => ({ id: pu.id, x: pu.x, y: pu.y, bob: pu.bob })),
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
  // hráči (napojíme třídu z classId)
  players.length = 0;
  for (const p of s.players) { p.class = CLASSES[p.classId]; p.basePassive = p.class ? p.class.passive : {}; p.perks = p.perks || {}; p.input = { mx: 0, my: 0, aiming: false }; recalcPerks(p); players.push(p); }
  // nepřátelé — napojíme def podle typeId (kvůli vykreslení bosse/pancíře)
  enemies = s.enemies.map(e => (e.def = ENEMIES[e.typeId] || {}, e));
  bullets = s.bullets; eBullets = s.eBullets;
  walls = s.walls.map(o => (o.def = STRUCTURES[o.defId] || TRAPS[o.defId], o));
  turrets = s.turrets.map(o => (o.def = TRAPS[o.defId], o));
  traps = s.traps.map(o => (o.def = TRAPS[o.defId], o));
  warriors = s.warriors.map(o => (o.def = WARRIORS[o.defId] || (o.defId === 'clan_axeman' ? CLAN_AXEMAN : { color: '#d07038', arch: 'MELEE' }), o));
  groundFx = s.groundFx;
  pickups = s.pickups || [];
  effects = s.effects || [];
  // jednorázové události → kosmetika u guesta
  if (s.ev) for (const ev of s.ev) guestEvent(ev);
  // stav / overlay
  if (s.st !== state) {
    if (s.st === 'combat' || s.st === 'build') { particles = []; floaters = []; decals = []; }
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
