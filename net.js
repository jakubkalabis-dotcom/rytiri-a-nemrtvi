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
      if (p) { p.input.mx = m.mx; p.input.my = m.my; p.input.aiming = m.aiming; p.aimAngle = m.aimAngle; }
    } else if (m.t === 'cmd') netHandleCmd(m);
  } else if (net.role === 'guest') {
    if (m.t === 'state') applyState(m.s);
  }
}
function netHandleCmd(m) {
  switch (m.act) {
    case 'buyweapon': buyWeapon(m.id); break;
    case 'buyammo': buyAmmo(m.id); break;
    case 'buybuild': buyBuild(m.id); break;
    case 'buylife': if (run.gems >= 40) { run.gems -= 40; run.lives += 5; sfx.buy(); renderShop(); } break;
    case 'tobuild': startBuildPhase(); break;
    case 'toshop': setState('shop'); break;
    case 'cycle': cycleWeapon(players[1]); break;
    case 'ready': readyGuest = true; if (readyHost) { startWave(); } break;
    case 'unready': readyGuest = false; break;
    case 'place': { const prev = buildSel; buildSel = m.sel; placeAt(m.tx, m.ty); buildSel = prev; break; }
    case 'sell': sellAt(m.tx, m.ty); break;
  }
  netPush(); // po změně stavu okamžitě sesynchronizuj guesta
}

/* ============================================================================
   SERIALIZACE (host → guest)
   ========================================================================== */
function serializeState() {
  return {
    st: state,
    run: run && { gems: run.gems, lives: run.lives, wave: run.wave, score: run.score || 0, ownedWeapons: run.ownedWeapons, ammo: run.ammo, owned: run.owned },
    wave: wave && { boss: wave.boss, spawned: wave.spawned, total: wave.total },
    banner: banner && { text: banner.text, t: banner.t, warn: banner.warn },
    readyHost, readyGuest,
    players: players.map(p => ({ x: p.x, y: p.y, r: p.r, hp: p.hp, hpMax: p.hpMax, aimAngle: p.aimAngle, inv: p.inv, downed: p.downed, classId: p.classId, color: p.color, weaponId: p.weaponId, mana: p.mana, manaMax: p.manaMax })),
    enemies: enemies.map(e => ({ x: e.x, y: e.y, r: e.r, hp: e.hp, hpMax: e.hpMax, flash: e.flash, arch: e.arch, color: e.color })),
    bullets: bullets.map(b => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: b.r, color: b.color, thrown: b.thrown })),
    eBullets: eBullets.map(b => ({ x: b.x, y: b.y, r: b.r, color: b.color })),
    walls: walls.map(s => ({ defId: s.defId, tx: s.tx, ty: s.ty, x: s.x, y: s.y, hp: s.hp, hpMax: s.hpMax, flash: s.flash })),
    turrets: turrets.map(s => ({ defId: s.defId, tx: s.tx, ty: s.ty, x: s.x, y: s.y, hp: s.hp, hpMax: s.hpMax, flash: s.flash })),
    traps: traps.map(t => ({ defId: t.defId, tx: t.tx, ty: t.ty, x: t.x, y: t.y, charges: t.charges, dur: t.dur })),
    warriors: warriors.map(w => ({ defId: w.defId, x: w.x, y: w.y, r: w.r, hp: w.hp, hpMax: w.hpMax, flash: w.flash })),
    groundFx: groundFx.map(g => ({ x: g.x, y: g.y, radius: g.radius, color: g.color })),
  };
}

// Podpis ekonomiky pro rozhodnutí, kdy překreslit obchod na guestovi.
function shopSig(r) { return r ? r.gems + '|' + r.lives + '|' + (r.ownedWeapons ? r.ownedWeapons.length : 0) + '|' + JSON.stringify(r.owned) + '|' + JSON.stringify(r.ammo) : ''; }
let lastShopSig = '';

function applyState(s) {
  // ekonomika / run
  if (s.run) { if (!run) run = {}; Object.assign(run, s.run); if (!run.class && players[0]) run.class = players[0].class; }
  readyHost = s.readyHost; readyGuest = s.readyGuest;
  wave = s.wave ? s.wave : null;
  banner = s.banner ? s.banner : null;
  // hráči (napojíme třídu z classId)
  players.length = 0;
  for (const p of s.players) { p.class = CLASSES[p.classId]; p.passive = p.class ? p.class.passive : {}; p.input = { mx: 0, my: 0, aiming: false }; players.push(p); }
  // nepřátelé / střely (render nepotřebuje def)
  enemies = s.enemies;
  bullets = s.bullets; eBullets = s.eBullets;
  // stavby / pasti / válečníci — napojíme def podle defId (kvůli vykreslení)
  walls = s.walls.map(o => (o.def = STRUCTURES[o.defId] || TRAPS[o.defId], o));
  turrets = s.turrets.map(o => (o.def = TRAPS[o.defId], o));
  traps = s.traps.map(o => (o.def = TRAPS[o.defId], o));
  warriors = s.warriors.map(o => (o.def = WARRIORS[o.defId], o));
  groundFx = s.groundFx;
  // stav / overlay
  if (s.st !== state) {
    setState(s.st);   // přepne overlay a případně překreslí menu/shop/…
    lastShopSig = shopSig(run);
  } else if (s.st === 'shop') {
    const sig = shopSig(run);
    if (sig !== lastShopSig) { renderShop(); lastShopSig = sig; }  // překresli obchod jen při změně
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
  netSend({ t: 'input', mx: myInput.mx, my: myInput.my, aiming: myInput.aiming, aimAngle: myInput.aimAngle });
}
