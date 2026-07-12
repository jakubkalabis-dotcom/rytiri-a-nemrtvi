/* ============================================================================
   RYTÍŘI A NEMRTVÍ — co-op síťování (net.js)
   Čisté WebRTC (DataChannel) s RUČNÍM spojovacím kódem — bez serveru i knihovny.
   Model host-authoritative: hostitel počítá simulaci a posílá snímky, guest
   posílá vstup/příkazy a jen vykresluje. Sdílený global scope s game.js.
   ========================================================================== */

const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let netOffer = '', netAnswer = '';
let netFrame = 0, inputFrame = 0;

/* ---------- Kódování SDP do kopírovatelného textu ---------- */
function encodeDesc(desc) { return btoa(JSON.stringify({ type: desc.type, sdp: desc.sdp })); }
function decodeDesc(code) { const o = JSON.parse(atob(code.trim())); return new RTCSessionDescription(o); }
// Počká na dokončení ICE gathering (non-trickle → jediný kód). Fallback timeout.
function waitIce(pc) {
  return new Promise(res => {
    if (pc.iceGatheringState === 'complete') return res();
    const check = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); res(); } };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(res, 2800);
  });
}

/* ---------- Napojení DataChannelu ---------- */
function wireChannel(dc) {
  net.dc = dc;
  dc.onopen = () => {
    net.connected = true;
    // po spojení jdou oba na výběr třídy
    net.hostClass = null; net.guestClass = null;
    setState('class');
  };
  dc.onmessage = ev => { try { netDispatch(JSON.parse(ev.data)); } catch (e) { showFatal('net: ' + e.message); } };
  dc.onclose = () => netOnDisconnect();
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
  try { if (net.pc) net.pc.close(); } catch {}
  net.dc = null; net.pc = null; net.connected = false;
  netOffer = ''; netAnswer = '';
}
function netSend(msg) { const dc = net.dc; if (dc && dc.readyState === 'open') { try { dc.send(JSON.stringify(msg)); } catch {} } }

/* ---------- Hostitel ---------- */
async function netHost() {
  netClose(); net.role = 'host'; net.mode = 'coop';
  const pc = new RTCPeerConnection(RTC_CFG); net.pc = pc;
  pc.oniceconnectionstatechange = () => { if (['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) netOnDisconnect(); };
  const dc = pc.createDataChannel('game', { ordered: true });
  wireChannel(dc);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIce(pc);
  netOffer = encodeDesc(pc.localDescription);
  if (state === 'host') renderHostLobby();
}
async function netHostAccept() {
  const el = document.getElementById('answerIn');
  const code = el && el.value ? el.value : '';
  if (!code.trim()) { alert('Vlož kód odpovědi od spoluhráče.'); return; }
  try { await net.pc.setRemoteDescription(decodeDesc(code)); }
  catch (e) { alert('Neplatný kód odpovědi.'); return; }
}

/* ---------- Guest ---------- */
async function netJoinAccept() {
  const el = document.getElementById('offerIn');
  const code = el && el.value ? el.value : '';
  if (!code.trim()) { alert('Vlož kód pozvánky od hostitele.'); return; }
  netClose(); net.role = 'guest'; net.mode = 'coop';
  const pc = new RTCPeerConnection(RTC_CFG); net.pc = pc;
  pc.oniceconnectionstatechange = () => { if (['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) netOnDisconnect(); };
  pc.ondatachannel = ev => wireChannel(ev.channel);
  try { await pc.setRemoteDescription(decodeDesc(code)); }
  catch (e) { alert('Neplatný kód pozvánky.'); return; }
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIce(pc);
  netAnswer = encodeDesc(pc.localDescription);
  const wrap = document.getElementById('answerWrap');
  if (wrap) wrap.innerHTML = `
    <p style="color:#8fb070">Zkopíruj kód odpovědi a pošli ho hostiteli:</p>
    <textarea id="answerBox" readonly class="codebox">${escapeHtml(netAnswer)}</textarea>
    <button data-act="copycode" data-which="answer">📋 Kopírovat kód odpovědi</button>
    <p style="color:#c0a060">Čekání na spojení…</p>`;
}

/* ---------- Kopírování ---------- */
function netCopy(which, el) {
  const t = document.getElementById(which === 'offer' ? 'offerBox' : 'answerBox');
  const val = t ? t.value : '';
  const done = () => { if (el) { const o = el.textContent; el.textContent = '✔ Zkopírováno'; setTimeout(() => { el.textContent = o; }, 1200); } };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(val).then(done, () => { if (t) { t.focus(); t.select(); } });
  else if (t) { t.focus(); t.select(); try { document.execCommand('copy'); done(); } catch {} }
}

/* ---------- Lobby UI ---------- */
function renderHostLobby() {
  ovContent.innerHTML = `
    <h2>Hostovat co-op</h2>
    <p>1) Zkopíruj <b>kód pozvánky</b> a pošli ho spoluhráči (např. přes zprávy).<br>
       2) On ti vrátí <b>kód odpovědi</b> — vlož ho dole a dej <b>Spojit</b>.</p>
    <p class="lbl">Kód pozvánky:</p>
    <textarea id="offerBox" readonly class="codebox">${netOffer ? escapeHtml(netOffer) : 'generuji kód…'}</textarea>
    <button data-act="copycode" data-which="offer">📋 Kopírovat kód pozvánky</button>
    <p class="lbl">Kód odpovědi od spoluhráče:</p>
    <textarea id="answerIn" class="codebox" placeholder="sem vlož kód odpovědi"></textarea>
    <button data-act="hostaccept">Spojit</button>
    <button data-act="menu" class="ghost">Zrušit</button>`;
}
function renderJoinLobby() {
  ovContent.innerHTML = `
    <h2>Připojit se ke hře</h2>
    <p>1) Vlož <b>kód pozvánky</b> od hostitele a dej <b>Vytvořit odpověď</b>.<br>
       2) Zkopíruj vzniklý <b>kód odpovědi</b> a pošli ho zpátky hostiteli.</p>
    <p class="lbl">Kód pozvánky od hostitele:</p>
    <textarea id="offerIn" class="codebox" placeholder="sem vlož kód pozvánky"></textarea>
    <button data-act="genanswer">Vytvořit odpověď</button>
    <div id="answerWrap"></div>
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
    run: run && { lives: run.lives, wave: run.wave, score: run.score || 0, ownedWeapons: run.ownedWeapons, ammo: run.ammo, owned: run.owned, upgrades: run.upgrades, wUpgrades: run.wUpgrades, wood: run.wood || 0, steel: run.steel || 0, combo: run.combo || 0, comboT: run.comboT || 0 },
    wave: wave && { boss: wave.boss, spawned: wave.spawned, total: wave.total, reward: wave.reward },
    banner: banner && { text: banner.text, t: banner.t, warn: banner.warn },
    readyHost, readyGuest, freezeTimer,
    players: players.map(p => ({ x: p.x, y: p.y, r: p.r, hp: p.hp, hpMax: p.hpMax, gems: p.gems || 0, aimAngle: p.aimAngle, inv: p.inv, downed: p.downed, classId: p.classId, color: p.color, weaponId: p.weaponId, mana: p.mana, manaMax: p.manaMax, walk: p.walk || 0, buffRapid: p.buffRapid || 0, buffPower: p.buffPower || 0, shieldT: p.shieldT || 0, rageT: p.rageT || 0, abilityCd: p.abilityCd || 0 })),
    enemies: enemies.map(e => ({ x: e.x, y: e.y, r: e.r, hp: e.hp, hpMax: e.hpMax, flash: e.flash, arch: e.arch, color: e.color, typeId: e.typeId, elite: e.elite, spawnT: e.spawnT })),
    bullets: bullets.map(b => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: b.r, color: b.color, thrown: b.thrown, magic: b.magic, ang: b.ang, crit: b.crit })),
    eBullets: eBullets.map(b => ({ x: b.x, y: b.y, r: b.r, color: b.color })),
    walls: walls.map(s => ({ defId: s.defId, tx: s.tx, ty: s.ty, x: s.x, y: s.y, hp: s.hp, hpMax: s.hpMax, flash: s.flash, temp: s.temp, level: s.level || 0 })),
    turrets: turrets.map(s => ({ defId: s.defId, tx: s.tx, ty: s.ty, x: s.x, y: s.y, hp: s.hp, hpMax: s.hpMax, flash: s.flash, temp: s.temp, level: s.level || 0 })),
    traps: traps.map(t => ({ defId: t.defId, tx: t.tx, ty: t.ty, x: t.x, y: t.y, charges: t.charges, dur: t.dur, level: t.level || 0 })),
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
  for (const p of s.players) { p.class = CLASSES[p.classId]; p.passive = p.class ? p.class.passive : {}; p.input = { mx: 0, my: 0, aiming: false }; players.push(p); }
  // nepřátelé — napojíme def podle typeId (kvůli vykreslení bosse/pancíře)
  enemies = s.enemies.map(e => (e.def = ENEMIES[e.typeId] || {}, e));
  bullets = s.bullets; eBullets = s.eBullets;
  walls = s.walls.map(o => (o.def = STRUCTURES[o.defId] || TRAPS[o.defId], o));
  turrets = s.turrets.map(o => (o.def = TRAPS[o.defId], o));
  traps = s.traps.map(o => (o.def = TRAPS[o.defId], o));
  warriors = s.warriors.map(o => (o.def = WARRIORS[o.defId], o));
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
