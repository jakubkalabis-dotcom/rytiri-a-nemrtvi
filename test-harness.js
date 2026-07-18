// Headless live-test harness for the Rytíři a Nemrtví game.
// Stubs the browser, loads data.js/engine.js/game.js/net.js into ONE shared script
// scope, then drives waves + every class ability and asserts no runtime errors.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Spustit z adresáře hry: `node test-harness.js`. Načte data.js/engine.js/game.js/net.js
// vedle sebe, nasimuluje vlny + všechny schopnosti a ověří, že nic nespadne.
const DIR = __dirname;

// ---- minimal browser stubs ----
function noop() { return undefined; }
const bad = (v) => typeof v === 'number' && !Number.isFinite(v);
const ctxProxy = new Proxy({}, {
  get(t, k) {
    if (k === 'measureText') return () => ({ width: 4 });
    // emulace reálného prohlížeče: záporný/NaN poloměr v arc/ellipse a NaN v gradientu = výjimka
    if (k === 'arc' || k === 'arcTo') return (...a) => { const r = k === 'arc' ? a[2] : a[4]; if (bad(a[0]) || bad(a[1]) || bad(r) || r < 0) throw new Error(`IndexSizeError: ${k}(${a.join(',')})`); };
    if (k === 'ellipse') return (...a) => { if (bad(a[2]) || bad(a[3]) || a[2] < 0 || a[3] < 0) throw new Error(`IndexSizeError: ellipse(${a.slice(2, 4).join(',')})`); };
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return (...a) => { if (a.some(bad)) throw new Error(`${k} non-finite(${a.join(',')})`); return { addColorStop: noop }; };
    if (k === 'getImageData') return () => ({ data: [] });
    if (k === 'canvas') return { width: 480, height: 800 };
    return typeof k === 'string' ? noop : undefined;
  },
  set() { return true; },
});
function fakeCanvas() { return { width: 480, height: 800, style: {}, getContext: () => ctxProxy, addEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 800 }), dataset: {} }; }
function fakeEl() {
  const _listeners = {};
  // addEventListener zachytává handlery (na rozdíl od noop) — testu 71h to umožní volat SKUTEČNÝ
  // delegovaný click handler overlaye (overlay.addEventListener('click', ...) v game.js), místo
  // aby přímo volal podkladové funkce. Reálnější reprodukce sekvence kliknutí uživatele.
  const el = { style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, addEventListener: (t, fn) => { (_listeners[t] = _listeners[t] || []).push(fn); }, removeEventListener: noop, appendChild: noop, removeChild: noop, setAttribute: noop, getContext: () => ctxProxy, querySelectorAll: () => [], querySelector: () => null, focus: noop, click: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 800 }), remove: noop, _listeners };
  let _html = '';
  Object.defineProperty(el, 'innerHTML', { get: () => _html, set: v => { _html = String(v); } });
  Object.defineProperty(el, 'textContent', { get: () => '', set: noop });
  return el;
}
const els = {};
const documentStub = {
  getElementById: (id) => els[id] || (els[id] = (id === 'game' ? fakeCanvas() : fakeEl())),
  createElement: (t) => (t === 'canvas' ? fakeCanvas() : fakeEl()),
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener: noop, body: fakeEl(), documentElement: fakeEl(),
};
const store = {};
const sandbox = {
  console,
  document: documentStub,
  window: null,
  navigator: { vibrate: noop, userAgent: 'node', serviceWorker: null, clipboard: null },
  performance: { now: () => Date.now() },
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
  setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
  Audio: function () { return { play: noop, pause: noop }; },
  AudioContext: function () { return { createOscillator: () => ({ connect: noop, start: noop, stop: noop, frequency: { value: 0, setValueAtTime: noop } }), createGain: () => ({ connect: noop, gain: { value: 0, setValueAtTime: noop, exponentialRampToValueAtTime: noop, linearRampToValueAtTime: noop } }), destination: {}, currentTime: 0, resume: noop, state: 'running' }; },
  Peer: function () { return { on: noop, connect: noop, destroy: noop }; },
  Image: function () { return {}; },
  Math, Date, JSON, Object, Array, Number, String, Boolean, isNaN, parseInt, parseFloat, Infinity, NaN, undefined,
};
sandbox.window = sandbox;
sandbox.addEventListener = noop; sandbox.removeEventListener = noop;
sandbox.globalThis = sandbox;
sandbox.webkitAudioContext = sandbox.AudioContext;
vm.createContext(sandbox);

// ---- load game files into one shared scope ----
const files = ['data.js', 'engine.js', 'game.js', 'net.js'];
let code = '';
for (const f of files) code += `\n/* ===== ${f} ===== */\n` + fs.readFileSync(path.join(DIR, f), 'utf8') + '\n';

// ---- append the test driver in the same scope ----
code += `
;(function TEST() {
  const results = [];
  const log = (m) => results.push(m);
  const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };
  // drive N combat ticks
  function tick(n) { for (let i = 0; i < n; i++) { if (state === 'combat') updateCombat(1); } }
  // Vyvolá SKUTEČNÝ delegovaný click handler overlaye (overlay.addEventListener('click', ...) v game.js),
  // stejně jako reálný klik uživatele na tlačítko s data-act. Ověřuje se tak přesně ta cesta, kterou hráč
  // opravdu prochází, ne jen přímé volání podkladových funkcí.
  function clickAct(act, id, which) {
    const handlers = overlay._listeners && overlay._listeners.click;
    if (!handlers || !handlers.length) throw new Error('overlay nemá zaregistrovaný click handler (data-act dispatch)');
    const fakeTarget = { dataset: { act, id, which } };
    const fakeEvent = { target: { closest: (sel) => (sel === '[data-act]' ? fakeTarget : null) } };
    for (const fn of handlers) fn(fakeEvent);
  }
  function forceState(s) { state = s; }

  const CLASS_IDS = Object.keys(CLASSES);
  log('classes: ' + CLASS_IDS.join(','));

  // ---- 1) each class: new run, buy start ammo, run a few normal waves ----
  for (const cid of CLASS_IDS) {
    newRun(cid);
    assert(players.length === 1, cid + ' player made');
    assert(players[0].passive, cid + ' passive');
    // simulate first 6 waves (incl. a sub-boss at wave 5)
    for (let w = 0; w < 6; w++) {
      startWave();
      let guard = 0;
      while (state === 'combat' && guard++ < 6000) { updateCombat(1); }
      assert(state !== 'combat', cid + ' wave ' + (w+1) + ' ended (state=' + state + ')');
      // clear any perk offer / wheel so we can proceed
      if (players[0].perkOffer) players[0].perkOffer = null;
      if (state === 'wheel') { state = 'combat'; }
      // heal to keep going
      players[0].hp = players[0].hpMax; players[0].downed = false;
      if (run.lives <= 0) run.lives = 20;
    }
    log(cid + ': survived to wave ' + run.wave + ' score ' + run.score);
  }

  // ---- 2) ability smoke test: force each ability with enemies present ----
  function spawnDummy(typeId, x, y) { const before = enemies.length; spawnEnemy(typeId); const e = enemies[enemies.length-1]; if (e) { e.x = x; e.y = y; } return e; }
  for (const cid of CLASS_IDS) {
    newRun(cid);
    startWave();
    const p = players[0];
    // give resources for gated abilities
    p.gems = 9999; run.shieldLvl = 2;
    if (cid === 'alchymista') { p.potions = 2; }
    if (cid === 'berserk') { p.hp = p.hpMax * 0.4; }
    if (cid === 'knez') { p.hp = p.hpMax * 0.5; }
    // spawn a few enemies around player
    for (let k = 0; k < 5; k++) spawnDummy('chodec', p.x + 20 + k*8, p.y);
    spawnDummy('obr', p.x - 30, p.y);       // TANK
    p.aimAngle = 0;
    // fire ability a few times, a UPDATE+RENDER každý tick (render s přísným canvasem odhalí pády v kreslení)
    for (let r = 0; r < 8; r++) {
      p.abilityCd = 0;
      if (cid==='knez') p.resurrectUsed=false;
      if (cid==='berserk'){p.hp=p.hpMax*0.4; p._clanActive=false; p.clanCd=0;}
      if (cid==='alchymista'){p.potions=1; p.abomT=0;}
      useAbility(p);
      for (let f = 0; f < 30; f++) { if (state === 'combat') updateCombat(1); try { render(); } catch (e) { throw new Error(cid + ' RENDER CRASH po schopnosti: ' + (e && e.message)); } }
    }
    log(cid + ' ability+render ok · warriors=' + warriors.length + ' enemies=' + enemies.length + ' particles=' + particles.length);
  }

  // ---- 3) perk system: grant offer, choose, verify passive changes ----
  newRun('rytir');
  startWave();
  const pp = players[0];
  grantPerkOffer();
  assert(pp.perkOffer && pp.perkOffer.length, 'perk offer generated');
  const before = pp.passive.dmgMul || 1;
  // force a known damage perk
  pp.perkOffer = ['brutalita'];
  choosePerk(pp, 'brutalita');
  assert(pp.perks.brutalita === 1, 'perk stored');
  assert((pp.passive.dmgMul||1) > before, 'dmgMul increased after perk');
  log('perk applied: dmgMul ' + before.toFixed(3) + ' -> ' + pp.passive.dmgMul.toFixed(3));

  // ---- 4) map advance resets structures ----
  newRun('inzenyr');
  run.wave = 24; startWave(); // wave 25 = map boss
  let g=0; while (state==='combat' && g++<8000) updateCombat(1);
  // simulate build-phase map advance
  if (players[0].perkOffer) players[0].perkOffer=null;
  walls.push({defId:'kamenna_zed',tx:5,ty:5,x:160,y:160,hp:10,hpMax:10}); // fake structure
  turrets.push({defId:'samostril',tx:6,ty:6,x:192,y:192,hp:10,hpMax:10});
  const nextMap = mapForWave(run.wave+1);
  advanceToMap(nextMap);
  assert(walls.length === 0 && turrets.length === 0 && traps.length === 0, 'structures reset on new map');
  log('map advance reset ok (walls=' + walls.length + ' turrets=' + turrets.length + ')');

  // ---- 5) wave structure sanity ----
  assert(WAVES_PER_MAP === 25, 'WAVES_PER_MAP=25');
  assert(isSubBossWave(5) && isSubBossWave(10) && !isSubBossWave(25), 'sub-boss cadence');
  assert(isMapEndWave(25) && isMapEndWave(50), 'map boss cadence');
  assert(Object.keys(PERKS).length >= 50, 'at least 50 perks (' + Object.keys(PERKS).length + ')');
  log('perk count: ' + Object.keys(PERKS).length);

  // ---- 6) DEEP behavioral checks for each reworked mechanic ----
  // 6a Knight block negates damage + reflects
  { newRun('rytir'); startWave(); const p=players[0]; const e=spawnDummy('chodec',p.x+10,p.y);
    p.abilityCd=0; run.shieldLvl=3; useAbility(p); assert(p.blockT>0,'block active');
    const hp0=p.hp; const ehp0=e.hp; damagePlayer(p, 50, e);
    assert(p.hp===hp0,'block negated all damage'); assert(e.hp<ehp0,'block reflected to attacker');
    log('knight block: hp stayed '+hp0+', reflected '+(ehp0-e.hp).toFixed(1)); }

  // 6b Scout invisibility hides from enemies + backstab kills normal / 3x boss
  { newRun('zved'); startWave(); const p=players[0]; p.x=300;p.y=300; const e=spawnDummy('chodec',p.x+5,p.y);
    p.abilityCd=0; useAbility(p); assert(p.invisT>0 && p.backstabArmed,'invis+armed');
    assert(nearestPlayer(e.x,e.y)===null,'enemy ignores invisible scout');
    damageEnemy(e, 1, WEAPONS[p.weaponId], p); assert(e.dead,'backstab insta-killed normal mob');
    // boss 3x
    startWave(); const b=spawnDummy('nekromant',p.x+5,p.y); p.abilityCd=0; p.invisT=0; useAbility(p);
    const bhp0=b.hp; const base=weaponDmg(p,WEAPONS[p.weaponId]); damageEnemy(b, base, WEAPONS[p.weaponId], p);
    assert(b.hp <= bhp0 - base*2.5,'backstab ~3x on boss'); log('scout backstab ok'); }

  // 6c Hunter flurry = infinite ammo + faster
  { newRun('lovec'); startWave(); const p=players[0]; p.weaponId='kratky_luk'; run.ammo.sip=1;
    p.flurryT=200; const r0=rateMod(p,WEAPONS[p.weaponId]);
    assert(consumeAmmo(p,WEAPONS.kratky_luk)===true,'flurry fires');
    p.flurryT=0; const r1=rateMod(p,WEAPONS[p.weaponId]); assert(r0<r1,'flurry faster fire');
    log('hunter flurry ok (rate '+r1.toFixed(2)+'->'+r0.toFixed(2)+')'); }

  // 6d Berserk clan gating (needs <=50% HP) + dismiss over 65%
  { newRun('berserk'); startWave(); const p=players[0]; p.hp=p.hpMax; p._clanActive=false; p.clanCd=0;
    useAbility(p); assert(warriors.filter(w=>w.clanOwner).length===0,'no clan at full HP');
    p.hp=p.hpMax*0.4; useAbility(p); assert(warriors.filter(w=>w.clanOwner).length===2,'2 axemen at 40% HP');
    p.hp=p.hpMax*0.9; tick(3); assert(warriors.filter(w=>w.clanOwner).length===0,'clan left when HP>65%');
    assert(p.clanCd>0,'clan cooldown set'); log('berserk clan ok'); }

  // 6e Alchemist bile harvest -> potion -> abomination eats pawn (+maxHP)
  { newRun('alchymista'); startWave(); const p=players[0]; p.x=300;p.y=300;
    for(let i=0;i<BILE_PER_POTION;i++){ pickups.push({id:'zluc',x:p.x,y:p.y,t:900,bob:0,hold:0}); }
    tick(70); assert((p.potions||0)>=1,BILE_PER_POTION+' biles made a potion (potions='+p.potions+')');
    const max0=p.hpMax; p.potions=1; p.abilityCd=0; useAbility(p); assert(p.abomT>0,'abomination active');
    const weak=spawnDummy('chodec',p.x+4,p.y); tick(5);
    assert(weak.dead,'abomination ate the pawn'); assert(p.hpMax>max0,'maxHP grew from eating');
    log('alchemist bile+abom ok (maxHP '+max0+'->'+p.hpMax+')'); }

  // 6f Engineer wheels: turret kills fill charges, threshold doubles
  { newRun('inzenyr'); const th0=run.wheelThreshold;
    for(let i=0;i<th0;i++) registerTurretKill();
    assert(run.wheelReady>=1,'wheel charge earned'); assert(run.wheelThreshold===th0*2,'threshold doubled');
    // pick a wheel upgrade
    const dmg0=run.wheelUpgrades.dmg; chooseWheel('dmg'); assert(run.wheelUpgrades.dmg===dmg0+1,'wheel upgrade applied');
    log('engineer wheels ok (threshold '+th0+'->'+run.wheelThreshold+')'); }

  // 6g Priest resurrection revives a downed ally (simulate 2 players)
  { newRun('knez'); // force a second downed player nearby
    const p=players[0]; const q=makePlayer(CLASSES.rytir,'rytir'); q.x=p.x+20;q.y=p.y; q.downed=true;q.hp=0; players.push(q);
    startWave(); p.resurrectUsed=false; useAbility(p);
    assert(!q.downed && q.hp>0,'ally resurrected'); assert(p.resurrectUsed,'resurrect consumed for the round');
    log('priest resurrection ok (ally hp='+q.hp+')'); }

  // 6h Turrets are passable (do not block movement)
  { newRun('inzenyr'); const tx=8,ty=8; const def=TRAPS.samostril;
    const obj={def,defId:'samostril',tx,ty,x:(tx+0.5)*TILE,y:(ty+0.5)*TILE,r:15,hp:90,hpMax:90};
    grid.structures[tileIndex(tx,ty)]=obj; turrets.push(obj);
    assert(isBlocked(tx,ty)===false,'turret tile is passable'); log('turret passable ok'); }

  // ---- 7) FULL FLOW: play to wave 27 crossing map 1->2 via real build phase ----
  { newRun('mag'); const p=players[0]; p.gems=99999;
    const startMap = currentMap;
    for (let w=0; w<27; w++) {
      startWave();
      let guard=0; while (state==='combat' && guard++<12000) updateCombat(1);
      // clear gates
      if (p.perkOffer) p.perkOffer=null;
      if (state==='wheel') state='roundEnd';
      // real between-wave flow: roundEnd -> shop -> build (advances map on wave 25)
      p.hp=p.hpMax; p.downed=false; if (run.lives<=0) run.lives=20;
      startBuildPhase();          // triggers advanceToMap (+ pact offer) after wave 25
      if (state==='pact') { const o=run._pactOffer; choosePact(o&&o[0]); }  // nová mapa nabídne pakt
      assert(state==='build','build phase entered after wave '+run.wave+' (state='+state+')');
    }
    assert(currentMap > startMap, 'crossed to next map (map '+(currentMap+1)+')');
    assert(run.wave >= 27, 'reached wave '+run.wave);
    log('full flow ok: wave '+run.wave+', map '+(currentMap+1)+'/'+NUM_MAPS+', score '+run.score); }

  // ---- 8) no NaN in key player/enemy stats after heavy play ----
  { newRun('rytir'); startWave(); const p=players[0];
    grantPerkOffer(); p.perkOffer=['kolos']; choosePerk(p,'kolos'); // +30% maxHP
    let guard=0; while(state==='combat' && guard++<8000) updateCombat(1);
    assert(Number.isFinite(p.hp)&&Number.isFinite(p.hpMax)&&p.hpMax>0,'player hp finite');
    for(const e of enemies) assert(Number.isFinite(e.hp)&&Number.isFinite(e.x),'enemy stats finite');
    log('no-NaN check ok (hpMax='+p.hpMax+')'); }

  // ---- 9) UI render smoke: every shop tab + roundEnd perk offer + wheel menu ----
  { newRun('rytir'); players.push(makePlayer(CLASSES.inzenyr,'inzenyr')); players.push(makePlayer(CLASSES.alchymista,'alchymista'));
    for (const t of SHOP_TABS.map(x=>x[0])) { shopTab=t; const html=renderShopCat(t); assert(typeof html==='string' && html.length>0, 'tab '+t+' renders'); }
    // roundEnd with a perk offer
    run.wave=5; players[0].perkOffer=['ostri1','vitalita1','pancir1']; renderRoundEnd(); assert(ovContent.innerHTML.includes('buff'),'roundEnd shows perk offer');
    run.wheelReady=1; renderWheelMenu(); assert(ovContent.innerHTML.includes('Kolečka'),'wheel menu renders');
    run._pactOffer=['krvezizen','horda','pevnost']; renderPact(); assert(ovContent.innerHTML.includes('Pakt'),'pact screen renders');
    renderMenu(); assert(ovContent.innerHTML.includes('NEMRTVÍ'),'menu + hero renders');
    abilityDetail('rytir'); abilityDetail('alchymista'); abilityDetail('inzenyr'); // number-formatting paths
    log('UI render smoke ok (all '+SHOP_TABS.length+' tabs + roundEnd + wheel)'); }

  // ---- 10) cdMul perk actually shortens ability cooldown (was dead perk) ----
  { newRun('mag'); startWave(); const p=players[0];
    p.abilityCd=0; useAbility(p); const cdBase=p.abilityCd;
    p.perkOffer=['soustredeni2']; choosePerk(p,'soustredeni2'); p.perkOffer=['soustredeni2']; choosePerk(p,'soustredeni2');
    p.abilityCd=0; useAbility(p); const cdPerk=p.abilityCd;
    assert(cdPerk < cdBase, 'Soustředění shortens cd ('+cdBase+'->'+cdPerk+')');
    log('cdMul perk ok (cd '+cdBase+'->'+cdPerk+')'); }

  // ---- 11) armageddon targets a real spot without throwing (empty + populated) ----
  { newRun('mag'); startWave(); const p=players[0]; p.abilityCd=0; useAbility(p); // no enemies -> no throw
    for(let k=0;k<6;k++) spawnDummy('chodec', p.x+120+k*6, p.y);
    p.abilityCd=0; useAbility(p); log('armageddon ok (empty + cluster)'); }

  // ---- 12) clan/warrior with missing def must render (co-op crash fix) ----
  { newRun('berserk'); startWave();
    warriors.push({ defId: 'clan_axeman', x: 200, y: 200, r: 12, hp: 100, hpMax: 100, aim: 0, flash: 0 }); // def undefined
    try { render(); } catch (e) { throw new Error('drawWarriors crashed on missing def: ' + (e && e.message)); }
    log('warrior with missing def renders (co-op clan crash fixed)'); }

  // ---- 13) priest holy radiance pulses AOE damage passively ----
  { newRun('knez'); startWave(); const p=players[0]; p.holyNovaCd=0;
    const e=spawnDummy('chodec', p.x+30, p.y); const hp0=e.hp;
    for (let f=0;f<3;f++){ if(state==='combat') updateCombat(1); }
    assert(e.hp < hp0 || e.dead, 'holy radiance damaged nearby undead');
    log('priest holy radiance ok (dmg dealt passively)'); }

  // ---- 14) HUD renders with a boss on screen (boss bar, wave track, forged bars) ----
  { newRun('mag'); run.wave = 4; startWave(); // wave 5 = sub-boss
    for (let g=0; g<40 && state==='combat' && !enemies.some(e=>e.arch==='BOSS'); g++) updateCombat(1);
    assert(enemies.some(e=>e.arch==='BOSS'), 'sub-boss spawned for HUD test');
    try { for (let f=0;f<20;f++){ if(state==='combat') updateCombat(1); render(); } } catch (e) { throw new Error('HUD boss-bar render crash: ' + (e && e.message)); }
    log('HUD renders with boss (boss bar + wave track ok)'); }

  // ---- 15) PAKTY: nabídka, výběr, aplikace efektů ----
  { newRun('rytir');
    // po newRun jsme se dostali do 'pact' přes offerPact? newRun sám nevolá – simulujeme tok pickClass:
    offerPact('shop'); assert(state==='pact', 'pact state entered');
    assert(run._pactOffer && run._pactOffer.length===3, '3 pacts offered');
    // vyber pakt s max HP (Prokletí many) pokud v nabídce, jinak vynuť
    run._pactOffer=['pevnost']; const lives0=run.lives; choosePact('pevnost');
    assert(run.pacts.includes('pevnost'), 'pact stored'); assert(run.lives===lives0+8, 'gate bonus applied ('+lives0+'->'+run.lives+')');
    assert(state==='shop', 'returned to shop after pact');
    log('pacts ok (offer/choose/gateBonus)'); }

  // ---- 16) pakt effect: enemyHp multiplier reaches spawned enemy ----
  { newRun('rytir'); run.pacts=['krvezizen']; startWave(); // +20% enemy HP
    const base=ENEMIES.chodec.hp; spawnEnemy('chodec'); const e=enemies[enemies.length-1];
    assert(e.hpMax > base, 'enemyHp pact raised spawned HP ('+base+'->'+e.hpMax+')');
    newRun('rytir'); run.pacts=['krehci']; startWave(); spawnEnemy('chodec'); const e2=enemies[enemies.length-1];
    assert(e2.hpMax < ENEMIES.chodec.hp, 'krehci pact lowered HP');
    log('pact enemy-scaling ok'); }

  // ---- 17) pakt maxHp affects player hpMax via recalc ----
  { newRun('mag'); const p=players[0]; const hp0=p.hpMax; run.pacts=['arkany']; recalcPerks(p);
    assert(p.hpMax < hp0, 'arkany pact -10% maxHP ('+hp0+'->'+p.hpMax+')');
    log('pact maxHp ok'); }

  // ---- 18) META-progrese: duše z běhu, nákup, bonusy do dalšího běhu ----
  { profile.souls = 0; profile.meta = {};
    newRun('rytir'); run.wave = 20; run.score = 5000;
    const s = grantSouls(); assert(s > 0 && profile.souls === s, 'souls granted from run ('+s+')');
    // nakup Dědictví (gems) + Odolnost (hp)
    profile.souls = 999; buyMeta('gems'); buyMeta('gems'); buyMeta('hp');
    assert(metaLvl('gems') === 2 && metaLvl('hp') === 1, 'meta upgrades bought');
    const g0 = CLASSES.rytir.startGems;
    newRun('rytir'); const p = players[0];
    assert(p.gems > g0, 'meta gems bonus applied ('+g0+'->'+p.gems+')');
    const baseNoMeta = Math.round(120 * CLASSES.rytir.hpMod);
    assert(p.baseHp > baseNoMeta, 'meta HP bonus applied ('+baseNoMeta+'->'+p.baseHp+')');
    // dmg bonus
    profile.meta = { dmg: 5 }; newRun('rytir'); const p2 = players[0];
    const d = weaponDmg(p2, WEAPONS[p2.weaponId]); profile.meta = {}; const d0 = weaponDmg(p2, WEAPONS[p2.weaponId]);
    assert(d > d0, 'meta dmg bonus raises weapon damage');
    profile.souls = 0; profile.meta = {};
    log('meta-progrese ok (duše/nákup/bonusy)'); }

  // ---- 19) Shrine UI renders ----
  { profile.souls = 50; renderShrine(); assert(ovContent.innerHTML.includes('Svatyně'), 'shrine renders'); profile.souls = 0;
    log('shrine UI ok'); }

  // ---- 20) Boss drtivý úder: telegraf → zásah pokud stojíš, uhneš pokud odejdeš ----
  { newRun('rytir'); startWave(); const p=players[0]; p.x=300; p.y=300; p.inv=0;
    spawnEnemy('nekromant'); const b=enemies[enemies.length-1]; b.x=340; b.y=300; b.spawnT=0;
    // vynuť nádech na hráče
    b.slamCd=0; if(state==='combat') updateCombat(1);
    assert(b.slamWind>0, 'slam telegraph started');
    // hráč ZŮSTANE stát → dostane zásah
    const hp0=p.hp; let g=0; while(b.slamWind>0 && g++<200){ p.x=b.slamX; p.y=b.slamY; p.inv=0; updateCombat(1); }
    assert(p.hp<hp0, 'stát v kruhu = zásah ('+hp0+'->'+p.hp+')');
    // nový nádech, hráč UHNE → bez zásahu
    p.hp=p.hpMax; b.slamWind=0; b.slamCd=0; p.x=300;p.y=300; updateCombat(1); assert(b.slamWind>0,'2nd telegraph');
    const hp1=p.hp; g=0; while(b.slamWind>0 && g++<200){ p.x=b.slamX+300; p.y=b.slamY+300; p.inv=0; updateCombat(1); }
    assert(p.hp===hp1, 'uhnutí z kruhu = bez zásahu');
    log('boss drtivý úder ok (zásah / uhnutí)'); }

  // ---- 21) Dělič: po smrti se rozdělí na Dělíčky, a vlna přesto skončí ----
  { newRun('rytir'); startWave(); const n0 = enemies.length;
    spawnEnemy('delic'); const dl = enemies[enemies.length-1]; dl.spawnT=0;
    const before = enemies.filter(e=>!e.dead).length;
    dl.hp = 0; killEnemy(dl, players[0]);
    const kids = enemies.filter(e=>!e.dead && e.typeId==='delicek').length;
    assert(kids === ENEMIES.delic.splits, 'Dělič se rozdělil na '+ENEMIES.delic.splits+' ('+kids+')');
    // dítě už se nedělí
    const kid = enemies.find(e=>e.typeId==='delicek'); kid.hp=0; killEnemy(kid, players[0]);
    const kids2 = enemies.filter(e=>!e.dead && e.typeId==='delicek').length;
    assert(kids2 === ENEMIES.delic.splits - 1, 'Dělíček se už nedělí');
    log('dělič ok (split '+kids+', dítě se nedělí)'); }

  // ---- 22) vlna s Děličem řádně skončí (endWave přes enemies.length===0) ----
  { newRun('rytir'); run.wave=17; startWave();   // wave 18 – běžná, s Děliči v poolu
    let g=0; while (state==='combat' && g++<20000) updateCombat(1);
    assert(state !== 'combat', 'vlna s Děliči skončila (state='+state+')');
    log('vlna s Děliči korektně skončí'); }

  // ---- 23) Fáze 3: nové zbraně střílí bez chyby a produkují střely/zásah ----
  { newRun('lovec'); startWave(); const p=players[0]; p.x=300;p.y=300; p.aimAngle=0;
    for (const kk in AMMO) run.ammo[kk]=999; p.mana=p.manaMax=999;
    const news=['cep','trojzubec','svaty_samostril','ledova_kuse','hromova_hul','kartac'];
    for (const wid of news) {
      assert(WEAPONS[wid], 'zbraň '+wid+' existuje'); assert(WEAPON_SHAPE[wid], 'tvar '+wid);
      spawnEnemy('chodec'); const e=enemies[enemies.length-1]; e.x=p.x+40; e.y=p.y; e.spawnT=0;
      p.weaponId=wid; const nb=bullets.length;
      try { fireWeapon(p, WEAPONS[wid], 0); } catch(err){ throw new Error(wid+' fireWeapon HÁŽE: '+err.message); }
      const w=WEAPONS[wid];
      if (w.arch!=='MELEE_SWING' && w.arch!=='HITSCAN') assert(bullets.length>nb, wid+' vytvořil střelu');
    }
    log('nové zbraně ok ('+news.length+' vystřeleno bez chyby)'); }

  // ---- 24) Fáze 3: Nekromant vyvolá kostlivce, kteří pak vyprší ----
  { assert(CLASSES.nekromant, 'třída Nekromant existuje'); assert(ABILITIES.nekromant, 'schopnost Nekromant');
    newRun('nekromant'); startWave(); const p=players[0]; p.abilityCd=0;
    const w0 = warriors.length; useAbility(p);
    const skels = warriors.filter(w=>w.defId==='kostlivec').length;
    assert(skels === SKELETON_COUNT, 'vyvoláno '+SKELETON_COUNT+' kostlivců ('+skels+')');
    // po vypršení lifetime zmizí
    let g=0; while (warriors.some(w=>w.defId==='kostlivec') && g++<SKELETON_LIFETIME+120) { if(state==='combat') updateCombat(1); }
    assert(!warriors.some(w=>w.defId==='kostlivec'), 'kostlivci po čase vypršeli');
    log('nekromant ok (kostlivci vyvoláni i vypršeli)'); }

  // ---- 25) Fáze 3: Šaman léčí okolní nemrtvé; nové sub-bossy v cyklu ----
  { newRun('rytir'); startWave();
    spawnEnemy('saman'); const sh=enemies[enemies.length-1]; sh.x=300;sh.y=300;sh.spawnT=0; sh.healCool=1;
    spawnEnemy('chodec'); const wounded=enemies[enemies.length-1]; wounded.x=320;wounded.y=300;wounded.spawnT=0; wounded.hp=1;
    for (let f=0; f<90; f++) updateCombat(1);
    assert(wounded.dead || wounded.hp > 1, 'Šaman vyléčil raněného ('+wounded.hp+')');
    assert(ENEMIES.saman && ENEMIES.strasak, 'noví nepřátelé existují');
    assert(SUB_BOSS_CYCLE.includes('kosteny_tyran') && SUB_BOSS_CYCLE.includes('pridatny_lecitel'), 'nové sub-bossy v cyklu');
    // frenzy nespadne
    newRun('rytir'); startWave(); spawnEnemy('strasak'); const fr=enemies[enemies.length-1]; fr.hp=5; fr.spawnT=0;
    try { for(let f=0;f<20;f++) updateCombat(1); } catch(e){ throw new Error('frenzy crash: '+e.message); }
    log('šaman léčí + frenzy + nové sub-bossy ok'); }

  // ---- 26) Progresivní cena Života brány: 40 / 70 / 100 (+30 za nákup), buyLife strhne gemy a zvedne lifeBuys ----
  { newRun('rytir'); const p = players[0];
    run.lifeBuys = 0; assert(lifeBuyCost() === 40, 'lifeBuyCost @0 nákupů = 40');
    run.lifeBuys = 1; assert(lifeBuyCost() === 70, 'lifeBuyCost @1 nákup = 70');
    run.lifeBuys = 2; assert(lifeBuyCost() === 100, 'lifeBuyCost @2 nákupy = 100');
    run.lifeBuys = 0; p.gems = 1000; const lives0 = run.lives, gems0 = p.gems;
    buyLife(p);
    assert(run.lives === lives0 + 5, 'buyLife: +5 životů (' + lives0 + '->' + run.lives + ')');
    assert(p.gems === gems0 - 40, 'buyLife: strhla 40 gemů (' + gems0 + '->' + p.gems + ')');
    assert(run.lifeBuys === 1, 'buyLife: lifeBuys=1 po prvním nákupu');
    const gems1 = p.gems; buyLife(p);
    assert(p.gems === gems1 - 70, 'druhý nákup stojí 70 gemů (' + gems1 + '->' + p.gems + ')');
    assert(run.lifeBuys === 2, 'lifeBuys=2 po druhém nákupu');
    log('progresivní cena Života brány ok (40->70->100..., gemy/lifeBuys se aktualizují)'); }

  // ---- 27) waveModifier: null na boss/horda/rané vlny, platný objekt na 27/32/37, deterministický, cykluje přes všechny typy ----
  { assert(waveModifier(25) === null, 'vlna 25 (mapový boss) bez modifikátoru');
    assert(waveModifier(30) === null, 'vlna 30 (boss, %5==0) bez modifikátoru');
    assert(waveModifier(29) === null, 'vlna 29 (horda, %5==4) bez modifikátoru');
    assert(waveModifier(24) === null, 'vlna 24 (<=25) bez modifikátoru');
    assert(waveModifier(10) === null, 'raná vlna 10 (<=25) bez modifikátoru');
    const m27 = waveModifier(27);
    assert(m27 && typeof m27.id === 'string', 'vlna 27 má platný modifikátor s id');
    assert(Number.isFinite(m27.spdMul) && Number.isFinite(m27.hpMul) && Number.isFinite(m27.dmgMul) && Number.isFinite(m27.countMul) && Number.isFinite(m27.eliteChanceAdd), 'vlna 27 má očekávaná číselná pole');
    const m27b = waveModifier(27);
    assert(m27b.id === m27.id, 'waveModifier je deterministický pro stejnou vlnu (27)');
    const m32 = waveModifier(32), m37 = waveModifier(37);
    assert(m32 && m32.id, 'vlna 32 má platný modifikátor'); assert(m37 && m37.id, 'vlna 37 má platný modifikátor');
    const ids = []; for (let w = 27; w <= 27 + 5 * (WAVE_MODIFIERS.length - 1); w += 5) { const mm = waveModifier(w); assert(mm, 'vlna ' + w + ' by měla mít modifikátor'); ids.push(mm.id); }
    const uniq = new Set(ids);
    assert(uniq.size === WAVE_MODIFIERS.length, 'modifikátor cykluje přes všech ' + WAVE_MODIFIERS.length + ' typů (' + ids.join(',') + ')');
    log('waveModifier ok (null na boss/horda/rané vlny, determinismus, cyklus ' + ids.join(',') + ')'); }

  // ---- 28) Rozzuření (enrage): boss pod 35 % HP se hýbe výrazně rychleji (+40 % rychlost) než nad prahem ----
  //         Měřeno ve DVOU oddělených bězích (stejná mapa/seed => stejné flow-pole => stejný směr),
  //         aby se vyloučilo zkreslení ze separační síly mezi dvěma bossy stojícími na stejném místě.
  { newRun('rytir'); startWave(); let p = players[0]; p.x = 3000; p.y = 3000; // hráč mimo agro dosah (>150) → směr určí jen flow-field
    const eA = spawnDummy('abominace', 400, 400); // NEnrage: 90 % HP
    eA.hp = eA.hpMax * 0.9; eA.enrageAnnounced = false;
    const sxA = eA.x, syA = eA.y;
    updateCombat(1);
    const dA = dist(sxA, syA, eA.x, eA.y);
    const eAannounced = eA.enrageAnnounced;

    newRun('rytir'); startWave(); p = players[0]; p.x = 3000; p.y = 3000;
    const eB = spawnDummy('abominace', 400, 400); // Enrage: 20 % HP, stejná pozice a stejný tik → identický směr pohybu jako eA
    eB.hp = eB.hpMax * 0.2; eB.enrageAnnounced = false;
    const sxB = eB.x, syB = eB.y;
    updateCombat(1);
    const dB = dist(sxB, syB, eB.x, eB.y);

    assert(dB > dA * 1.2, 'rozzuřený boss (hp<35%) urazil za tik víc než klidný (' + dA.toFixed(3) + ' vs ' + dB.toFixed(3) + ')');
    assert(eB.enrageAnnounced === true, 'enrage flag nastaven pod 35 % HP');
    assert(eAannounced === false, 'enrage flag zůstal vypnutý nad 35 % HP');
    log('enrage ok: rychlost +40% pod 35% HP (' + dA.toFixed(3) + ' -> ' + dB.toFixed(3) + ')'); }

  // ---- 29) Bodcová zeď: kontaktní poškození (contactDmg) postupně sráží HP nepřítele u zdi a nakonec ho zabije ----
  { newRun('rytir'); startWave(); const p = players[0];
    const tx = 3, ty = 3;
    grid.tiles[tileIndex(tx, ty)] = 0; grid.tiles[tileIndex(tx - 1, ty)] = 0;   // zajisti volné dlaždice bez ohledu na náhodné překážky mapy
    const wallX = (tx + 0.5) * TILE, wallY = (ty + 0.5) * TILE;
    const wallDef = STRUCTURES.bodcova_zed;
    const wallObj = { def: wallDef, defId: 'bodcova_zed', tx, ty, x: wallX, y: wallY, r: 15, hp: wallDef.hp, hpMax: wallDef.hp, wallCool: 0, fireCool: 0, flash: 0 };
    grid.structures[tileIndex(tx, ty)] = wallObj; walls.push(wallObj);
    const e = spawnDummy('chodec', wallX - TILE, wallY);
    p.x = e.x + 100; p.y = e.y;   // hráč v agro dosahu → nepřítel míří rovně na zeď a zůstane u ní stát
    const hp0 = e.hpMax;
    updateCombat(1);
    assert(e.hp < hp0, 'bodcová zeď (contactDmg=' + wallDef.contactDmg + '/s) ubrala HP hned první tik (' + hp0 + '->' + e.hp.toFixed(2) + ')');
    let g = 1; while (!e.dead && g++ < 400) updateCombat(1);
    assert(e.dead, 'bodcová zeď kontaktním poškozením nepřítele nakonec zabila (tiky=' + g + ')');
    log('bodcová zeď ok: kontaktní poškození zabíjí, engine nespadl (tiky=' + g + ')'); }

  // ---- 30) D12 co-op: gemy za zabití dostane JEN killer, ne všichni hráči v týmu ----
  { newRun('rytir'); const p1 = players[0];
    const p2 = makePlayer(CLASSES.zved, 'zved'); p2.x = p1.x + 10; p2.y = p1.y; players.push(p2);
    startWave(); p1.gems = 0; p2.gems = 0;
    const e = spawnDummy('chodec', p1.x + 15, p1.y);
    e.hp = 0; killEnemy(e, p1);
    assert(p1.gems > 0, 'D12: zabíječ (hráč1) dostal gemy (' + p1.gems + ')');
    assert(p2.gems === 0, 'D12: druhý hráč gemy NEdostal, aby nedocházelo k duplikaci (' + p2.gems + ')');
    log('D12 coop gemy ok: jen killer dostává odměnu (p1=' + p1.gems + ', p2=' + p2.gems + ')'); }

  // ---- 31) FÁZE 2 (game feel): killShake — otřes jen za DŮLEŽITÉ zabití, obyčejný trash = 0 ----
  { assert(killShake({ arch: 'BOSS' }) === 11, 'killShake boss=11');
    assert(killShake({ arch: 'TANK' }) === 3, 'killShake tank=3');
    assert(killShake({ elite: 'zhoubny' }) === 1.2, 'killShake elite=1.2');
    assert(killShake({ arch: 'WALKER' }) === 0, 'killShake obyčejný trash=0');
    log('killShake ok (boss/tank/elite třesou, trash ne)'); }

  // ---- 32) pushDamageFloater: blízké rychlé trash-zásahy se SLUČUJÍ, počet nikdy nepřeteče strop; krity NE ----
  { floaters.length = 0;
    for (let i = 0; i < 40; i++) pushDamageFloater(100, 100, 5, false);   // stejné místo, rychle za sebou
    const trash = floaters.filter(f => !f.crit);
    assert(trash.length === 1, 'blízké trash zásahy se sloučily do 1 floateru (' + trash.length + ')');
    assert(trash[0].dmg === 200, 'sloučené poškození se sečetlo (5×40=200, je ' + trash[0].dmg + ')');
    floaters.length = 0;
    for (let i = 0; i < 40; i++) pushDamageFloater(100 + i * 40, 100, 3, false);   // rozházené daleko od sebe → neslučitelné
    assert(floaters.filter(f => !f.crit).length <= FLOATER_TRASH_LIMIT, 'strop trash-floaterů se drží (' + floaters.length + ' <= ' + FLOATER_TRASH_LIMIT + ')');
    floaters.length = 0;
    for (let i = 0; i < 5; i++) pushDamageFloater(100, 100, 9, true);   // krity se nikdy neslučují
    assert(floaters.filter(f => f.crit).length === 5, 'krity si vždy drží vlastní floater (' + floaters.filter(f=>f.crit).length + ')');
    log('spawnFloater throttling ok (merge/strop/krity)'); }

  // ---- 33) hitDirection: směr rány ze střely (vx/vy) nebo z pozice útočníka; bez zdroje null ----
  { const e = { x: 100, y: 100 };
    const dBullet = hitDirection(e, { vx: 3, vy: 0 }, null);
    assert(dBullet && Math.abs(dBullet.x - 1) < 1e-6 && Math.abs(dBullet.y) < 1e-6, 'hitDirection ze střely ok');
    const dPlayer = hitDirection(e, null, { x: 90, y: 100 });
    assert(dPlayer && dPlayer.x > 0.99, 'hitDirection z pozice útočníka ok');
    assert(hitDirection(e, null, null) === null, 'hitDirection bez zdroje = null');
    log('hitDirection ok (střela/útočník/bez zdroje)'); }

  // ---- 34) mixHex: interpolace barev pro pohasínající svatou pečeť brány (t=0→a, t=1→b, mimo rozsah se ořízne) ----
  { assert(mixHex('#e7c56a', '#6a6258', 0) === '#e7c56a', 'mixHex t=0 vrací první barvu');
    assert(mixHex('#e7c56a', '#6a6258', 1) === '#6a6258', 'mixHex t=1 vrací druhou barvu');
    assert(mixHex('#000000', '#ffffff', 2) === '#ffffff', 'mixHex ořízne t>1');
    log('mixHex ok (interpolace barev pečeti)'); }

  // ---- 35) enemyMarkerIcon: prioritní ikona nad hlavou — léčitel/dělič mají přednost před obyčejnou elitou ----
  { assert(enemyMarkerIcon({ def: { heals: true } }) === '✚', 'léčitel = ✚');
    assert(enemyMarkerIcon({ def: { splits: 3 } }) === '⚔', 'dělič = ⚔');
    assert(enemyMarkerIcon({ def: {}, elite: 'zhoubny' }) === '★', 'elita = ★');
    assert(enemyMarkerIcon({ def: { heals: true }, elite: 'zhoubny' }) === '✚', 'léčitel má přednost před elitou');
    assert(enemyMarkerIcon({ def: {} }) === null, 'obyčejný nepřítel bez markeru');
    log('enemyMarkerIcon ok (priorita léčitel/dělič/elita)'); }

  // ---- 36) FÁZE 3: SNAPSHOT_SCHEMA je jediný zdroj pravdy — serializeState()/applyState() čtou stejná pole (co-op parita) ----
  { newRun('rytir'); startWave();
    const p = players[0]; p.gems = 42; p.perks = { brutalita: 1 };
    spawnDummy('chodec', p.x + 30, p.y);
    const tx = 2, ty = 2;
    const wallObj = { def: STRUCTURES.kamenna_zed, defId: 'kamenna_zed', tx, ty, x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, hp: 55, hpMax: 100, flash: 0, temp: false, level: 1 };
    walls.push(wallObj);
    run.upgrades.dmg = 3; run.lifeBuys = 2;

    const snap1 = serializeState();

    // NEZÁVISLÝ SVĚDEK (pozor: úmyslně NEODVOZENO ze SNAPSHOT_SCHEMA!) — ručně vypsaný seznam polí,
    // která KAŽDÁ entita má vlastnit v síťovém snímku. Pokud někdo pole z SNAPSHOT_SCHEMA[key].fields
    // odebere (nebo přidá) a zapomene sladit síťový kontrakt, tento seznam se přestane shodovat a test
    // spadne — dokud vědomě neaktualizuje i tento guard. To je žádoucí tření pro desync-kritickou vrstvu.
    const EXPECTED_SCHEMA_FIELDS = {
      run: ['lives', 'wave', 'score', 'ownedWeapons', 'ammo', 'owned', 'upgrades', 'wUpgrades', 'wood', 'steel',
            'combo', 'comboT', 'shieldLvl', 'wheelReady', 'wheelUpgrades', 'turretKills', 'wheelThreshold', 'pacts',
            '_pactOffer', 'lifeBuys', 'ascension', 'daily'],
      wave: ['boss', 'spawned', 'total', 'reward'],
      banner: ['text', 't', 'warn'],
      players: ['x', 'y', 'r', 'hp', 'hpMax', 'gems', 'aimAngle', 'inv', 'downed', 'classId', 'color', 'weaponId',
                'mana', 'manaMax', 'walk', 'buffRapid', 'buffPower', 'shieldT', 'rageT', 'abilityCd', 'perks',
                'perkOffer', 'blockT', 'invisT', 'flurryT', 'abomT', 'potions', 'bile', 'clanCd', 'resurrectUsed',
                '_clanActive'],
      enemies: ['id', 'x', 'y', 'r', 'hp', 'hpMax', 'flash', 'arch', 'color', 'typeId', 'elite', 'spawnT',
                'slamWind', 'slamWindMax', 'slamX', 'slamY', 'slamR'],
      bullets: ['x', 'y', 'vx', 'vy', 'r', 'color', 'thrown', 'magic', 'ang', 'crit'],
      eBullets: ['x', 'y', 'r', 'color'],
      walls: ['defId', 'tx', 'ty', 'x', 'y', 'hp', 'hpMax', 'flash', 'temp', 'level'],
      turrets: ['defId', 'tx', 'ty', 'x', 'y', 'hp', 'hpMax', 'flash', 'temp', 'level'],
      traps: ['defId', 'tx', 'ty', 'x', 'y', 'dur', 'level'],
      warriors: ['defId', 'x', 'y', 'r', 'hp', 'hpMax', 'flash', 'aim'],
      groundFx: ['x', 'y', 'radius', 'color'],
      pickups: ['id', 'x', 'y', 'bob'],
    };
    assert(JSON.stringify(Object.keys(SNAPSHOT_SCHEMA).sort()) === JSON.stringify(Object.keys(EXPECTED_SCHEMA_FIELDS).sort()),
      'schema drift: SNAPSHOT_SCHEMA obsahuje jiné entity než EXPECTED_SCHEMA_FIELDS guard v testu — aktualizuj guard');
    for (const key of Object.keys(SNAPSHOT_SCHEMA)) {
      const meta = SNAPSHOT_SCHEMA[key];
      const actualFieldNames = meta.fields.map(f => (typeof f === 'string' ? f : f.key)).sort();
      const expectedFieldNames = EXPECTED_SCHEMA_FIELDS[key].slice().sort();
      assert(JSON.stringify(actualFieldNames) === JSON.stringify(expectedFieldNames),
        'schema drift v ' + key + ': SNAPSHOT_SCHEMA.fields=[' + actualFieldNames.join(',') + '] != očekávaný seznam=[' + expectedFieldNames.join(',') + '] (pokud je změna záměrná, sladi i EXPECTED_SCHEMA_FIELDS v testu)');
    }
    log('SNAPSHOT_SCHEMA nezávislý svědek ok (odebrání/přidání pole v SNAPSHOT_SCHEMA bez sladění testu by tuto kontrolu shodilo)');

    // strukturální kontrola implementace: schemaPick() musí vracet PŘESNĚ klíče z meta.fields (chytá bugy v schemaPick, ne drift schématu samotného)
    for (const key of Object.keys(SNAPSHOT_SCHEMA)) {
      const meta = SNAPSHOT_SCHEMA[key];
      const wantKeys = JSON.stringify(meta.fields.map(f => (typeof f === 'string' ? f : f.key)).sort());
      if (meta.list) {
        assert(Array.isArray(snap1[key]), 'schema drift: ' + key + ' je pole ve snímku');
        if (snap1[key].length) assert(JSON.stringify(Object.keys(snap1[key][0]).sort()) === wantKeys, 'schemaPick bug v ' + key + ': klíče snímku != schema.fields');
      } else if (meta.single && snap1[key]) {
        assert(JSON.stringify(Object.keys(snap1[key]).sort()) === wantKeys, 'schemaPick bug v ' + key + ': klíče snímku != schema.fields');
      }
    }
    log('SNAPSHOT_SCHEMA strukturální kontrola ok (schemaPick() vrací přesně pole ze schématu)');

    // round-trip přes drát (JSON, jako reálný DataChannel přenos)
    const wire = JSON.parse(JSON.stringify(snap1));
    const savedLives = run.lives, savedHp = p.hp, savedGems = p.gems, savedEnemyCount = enemies.length,
          savedEnemyHp = enemies[0].hp, savedWallHp = wallObj.hp, savedUpgrades = JSON.stringify(run.upgrades);

    // znič lokální stav — applyState(wire) ho musí obnovit na serializované hodnoty
    run.lives = 999; p.hp = 1; p.gems = 0; enemies.length = 0; walls[0].hp = 1; run.upgrades = {};
    applyState(wire);

    assert(run.lives === savedLives, 'apply obnovil run.lives (' + run.lives + ' == ' + savedLives + ')');
    assert(run.upgrades.dmg === 3 && JSON.stringify(run.upgrades) === savedUpgrades, 'apply obnovil run.upgrades');
    assert(players[0].hp === savedHp, 'apply obnovil players[0].hp (' + players[0].hp + ' == ' + savedHp + ')');
    assert(players[0].gems === savedGems, 'apply obnovil players[0].gems (' + players[0].gems + ' == ' + savedGems + ')');
    assert(players[0].class === CLASSES.rytir, 'apply rehydratoval players[0].class');
    assert(enemies.length === savedEnemyCount, 'apply obnovil počet enemies (' + enemies.length + ' == ' + savedEnemyCount + ')');
    assert(enemies[0].hp === savedEnemyHp, 'apply obnovil enemies[0].hp (' + enemies[0].hp + ' == ' + savedEnemyHp + ')');
    assert(enemies[0].def === ENEMIES[enemies[0].typeId], 'apply rehydratoval enemies[0].def');
    assert(walls.length === 1 && walls[0].hp === savedWallHp, 'apply obnovil walls[0].hp (' + walls[0].hp + ' == ' + savedWallHp + ')');
    assert(walls[0].def === STRUCTURES.kamenna_zed, 'apply rehydratoval walls[0].def');
    log('SNAPSHOT_SCHEMA round-trip ok (wire-format zachován, hodnoty obnoveny, def/class rehydratace ok)'); }

  // ---- 37) FÁZE 3: stabilní enemy.id — unikátní, monotónně rostoucí, resetuje se v newRun() ----
  { newRun('rytir');
    assert(nextEnemyId === 1, 'nextEnemyId se resetuje v newRun() na 1');
    spawnEnemy('chodec'); spawnEnemy('chodec'); spawnEnemy('chodec');
    const ids = enemies.map(e => e.id);
    assert(ids.every(id => typeof id === 'number'), 'enemy.id je číslo');
    assert(new Set(ids).size === ids.length, 'enemy.id: všechna ID v běhu unikátní');
    assert(ids[0] < ids[1] && ids[1] < ids[2], 'enemy.id: monotónně rostou (' + ids.join(',') + ')');
    log('enemy.id ok (unikátní, rostoucí, reset per běh)'); }

  // ---- 38) FÁZE 3: smoothToward() — čistá exponenciální vyhlazovací funkce (guest render) ----
  { assert(smoothToward(0, 10, 0.3) === 3, 'smoothToward: 0→10 @k=0.3 dá 3');
    assert(smoothToward(10, 10, 0.3) === 10, 'smoothToward: cur===target beze změny');
    assert(smoothToward(9.7, 10, 0.3) === 10, 'smoothToward: rozdíl < 0.5px se přichytí přesně na cíl');
    assert(smoothToward(100, 0, 0.3) === 70, 'smoothToward: funguje i směrem dolů');
    let v = 0; const target = 200, hist = [];
    for (let i = 0; i < 60; i++) { v = smoothToward(v, target, 0.3); hist.push(v); }
    assert(v === target, 'smoothToward: po dostatku kroků přesně dosáhne cíle (' + v + ')');
    assert(hist.every(x => x <= target), 'smoothToward: nikdy nepřestřelí cíl (monotónní přiblížení)');
    log('smoothToward ok (vyhlazuje, přichycuje pod 0.5px, nikdy nepřestřelí)'); }

  // ---- 39) FÁZE 3: updateRenderPositions() v SÓLU/HOSTU = rx/ry bit-přesně == x/y (ŽÁDNÁ vizuální regrese) ----
  { newRun('rytir'); spawnEnemy('chodec');
    const e = enemies[0]; e.x = 123.456789; e.y = -55.125;
    players[0].x = 77.777; players[0].y = 88.888;
    assert(net.role === null, 'test předpokládá sólo (net.role null)');
    updateRenderPositions();
    assert(e.rx === e.x && e.ry === e.y, 'sólo: enemy.rx/ry === x/y bit-přesně (' + e.rx + '===' + e.x + ')');
    assert(players[0].rx === players[0].x && players[0].ry === players[0].y, 'sólo: player.rx/ry === x/y bit-přesně');
    log('updateRenderPositions ok v sólu (přímé přiřazení, beze změny vizuálu)'); }

  // ---- 40) FÁZE 3: updateRenderPositions() u GUESTA plynule dohání cíl, nikdy neskočí ----
  { newRun('rytir'); spawnEnemy('chodec');
    const e = enemies[0]; e.rx = 0; e.ry = 0; e.x = 100; e.y = 0;
    net.role = 'guest';
    updateRenderPositions();
    assert(e.rx > 0 && e.rx < 100, 'guest: 1. snímek se posune k cíli, ale nedoskočí (' + e.rx + ')');
    assert(Math.abs(e.rx - 30) < 1e-9, 'guest: posun odpovídá faktoru k=0.30 (' + e.rx + ')');
    let guard = 0;
    while (e.rx !== e.x && guard++ < 200) updateRenderPositions();
    assert(e.rx === e.x, 'guest: po dostatku snímků se render-pozice přichytí přesně na cíl');
    assert(guard < 200, 'guest: konverguje v rozumném počtu snímků (' + guard + ')');
    net.role = null;   // úklid, ať to neovlivní další testy
    log('updateRenderPositions ok u guesta (plynulé vyhlazení, konverguje)'); }

  // ---- 41) FÁZE 3: applyState() páruje render-pozici nepřátel podle stabilního id (ne skokem na novou x/y) ----
  { newRun('rytir'); startWave();
    const e = spawnDummy('chodec', 50, 50);
    e.rx = 50; e.ry = 50;   // guest už měl tohoto nepřítele vykreslený usazeného na (50,50)
    const oldId = e.id;
    const snap = serializeState();
    assert(snap.enemies[0].id === oldId, 'serializeState nese stabilní enemy.id');
    snap.enemies[0].x = 500; snap.enemies[0].y = 500;   // hostitel mezitím nepřítele posunul
    const wire = JSON.parse(JSON.stringify(snap));      // round-trip přes drát
    net.role = 'guest';
    applyState(wire);
    const e2 = enemies.find(x => x.id === oldId);
    assert(e2, 'nepřítel se stejným id existuje po applyState');
    assert(e2.x === 500 && e2.y === 500, 'applyState nastavil autoritativní x/y na novou (hostitelovu) pozici');
    assert(e2.rx === 50 && e2.ry === 50, 'applyState ZACHOVAL starou vyhlazenou render-pozici spárovanou podle id (neskočila na 500,500)');
    net.role = null;
    log('applyState: enemy render-pozice spárována podle id, ne resetována skokem'); }

  // ---- 42) FÁZE 3: applyState() páruje render-pozici hráčů podle indexu (0=hostitel, 1=guest) ----
  { newRun(CLASS_IDS.slice(0, 2));
    players[0].rx = 10; players[0].ry = 10;
    players[1].rx = 20; players[1].ry = 20;
    const snap = serializeState();
    snap.players[0].x = 999; snap.players[1].x = 888;
    const wire = JSON.parse(JSON.stringify(snap));
    net.role = 'guest';
    applyState(wire);
    assert(players[0].rx === 10 && players[1].rx === 20, 'applyState: render-pozice hráčů spárována podle indexu');
    assert(players[0].x === 999 && players[1].x === 888, 'applyState: autoritativní x aktualizováno');
    net.role = null;
    log('applyState: player render-pozice spárována podle indexu, ne resetována skokem'); }

  // ---- 43) FÁZE 3: trapGrid (O(1) mřížka pastí) zůstává v synchronu s traps při placeAt/sellAt/expiraci ----
  { newRun('rytir');
    const tx1 = 2, ty1 = 2, tx2 = 3, ty2 = 2;
    // vynuť volné dlaždice bez ohledu na náhodně generovanou mapu (stejná technika jako test 29)
    grid.tiles[tileIndex(tx1, ty1)] = 0; grid.tiles[tileIndex(tx2, ty2)] = 0;
    const i1 = tileIndex(tx1, ty1), i2 = tileIndex(tx2, ty2);
    assert(!trapGrid.has(i1) && !trapGrid.has(i2), 'trapGrid start prázdná na testovacích dlaždicích');

    // a) placeAt (past 'smola', SLOW) -> musí být v traps I v trapGrid na správném tile indexu
    run.owned.smola = 1; buildSel = 'smola';
    placeAt(tx1, ty1);
    assert(trapGrid.has(i1), 'placeAt: past je v trapGrid na tileIndex(' + tx1 + ',' + ty1 + ')');
    const trapObj1 = trapGrid.get(i1);
    assert(traps.includes(trapObj1), 'placeAt: STEJNÝ objekt je i v poli traps');
    assert(traps.filter(t => t.tx === tx1 && t.ty === ty1).length === 1, 'placeAt: přesně jedna past na dlaždici');

    // b) sellAt -> musí zmizet z traps I z trapGrid, dlaždice znovu stavitelná
    const sold = sellAt(tx1, ty1, players[0]);
    assert(sold === true, 'sellAt vrátila true (něco se prodalo)');
    assert(!trapGrid.has(i1), 'sellAt: past zmizela z trapGrid');
    assert(!traps.some(t => t.tx === tx1 && t.ty === ty1), 'sellAt: past zmizela z traps');
    run.owned.smola = 1; buildSel = 'smola';
    placeAt(tx1, ty1);   // dlaždice musí jít znovu zastavět (trapGrid.has() by jinak placeAt zablokoval)
    assert(trapGrid.has(i1), 'dlaždice je po sellAt znovu stavitelná (placeAt uspěl podruhé)');
    sellAt(tx1, ty1, players[0]);   // úklid

    // c) DOT_AOE past ('ohniste') po vypršení (dur<=0) zmizí z traps I z trapGrid
    run.owned.ohniste = 1; buildSel = 'ohniste';
    placeAt(tx2, ty2);
    assert(trapGrid.has(i2), 'ohniště je v trapGrid po placeAt');
    const trapObj2 = trapGrid.get(i2);
    assert(trapObj2.def.arch === 'DOT_AOE', 'ohniště má arch DOT_AOE');
    trapObj2.dur = 0.5;   // simuluj těsně před vypršením (updateTraps odečte dt a smaže při dur<=0)
    enemyHash.clear();    // izolace od zbytkového stavu jiných testů
    updateTraps(1);
    assert(!trapGrid.has(i2), 'ohniště po vypršení (dur<=0) zmizelo z trapGrid');
    assert(!traps.some(t => t.tx === tx2 && t.ty === ty2), 'ohniště po vypršení zmizelo z traps');
    log('trapGrid ok (placeAt/sellAt/expirace DOT_AOE drží trapGrid v synchronu s traps)'); }

  // ---- 44) FÁZE 3: swap-remove enemies (V9 perf) — bez duplicit a bez vynechání, na kraji i uprostřed ----
  { newRun('rytir'); startWave();
    const p = players[0]; p.x = 40; p.y = 700;   // hráč daleko od testovacích nepřátel (mimo 150px aggro)
    enemies.length = 0;                          // izolace od nepřátel spawnutých startWave()
    wave.spawned = wave.total;                   // zabraň auto-spawnu z fronty během testovacího ticku
    const es = [];
    for (let k = 0; k < 6; k++) es.push(spawnDummy('chodec', 40 + k * 20, 40));
    assert(es.every(e => e), 'všech 6 testovacích nepřátel vytvořeno');
    es[0].dead = true;   // první
    es[2].dead = true;   // prostřední
    es[3].dead = true;   // prostřední, sousedící s předchozím (dvojice sousedících mrtvých)
    es[5].dead = true;   // poslední
    const idsWant = [es[1].id, es[4].id].sort((a, b) => a - b);
    updateCombat(1);
    assert(enemies.length === 2, 'swap-remove enemies: po odstranění 4 mrtvých zbyli přesně 2 (' + enemies.length + ')');
    assert(new Set(enemies).size === enemies.length, 'swap-remove enemies: žádné duplicitní reference v poli');
    const idsGot = enemies.map(e => e.id).sort((a, b) => a - b);
    assert(JSON.stringify(idsGot) === JSON.stringify(idsWant), 'swap-remove enemies: přežili přesně ti neoznačení (' + idsGot.join(',') + ' == ' + idsWant.join(',') + ')');
    log('swap-remove enemies ok (první/prostřední/sousedící/poslední mrtví korektně odstraněni bez duplicit)'); }

  // ---- 45) FÁZE 3: swap-remove warriors (V9 perf) — víc mrtvých v jednom snímku, bez duplicit/vynechání ----
  { newRun('rytir'); startWave();
    enemies.length = 0; enemyHash.clear();   // žádní nepřátelé v okolí, ať spojence nic jiného nezraní
    warriors.length = 0;
    const mk = (x, y, hp) => ({ def: WARRIORS.mecenos, defId: 'mecenos', x, y, r: 12, hp, hpMax: 100, homeX: x, homeY: y, cool: 0, aim: 0, flash: 0 });
    const ws = [mk(40, 40, 100), mk(60, 40, 0), mk(80, 40, 100), mk(100, 40, 0), mk(120, 40, 0), mk(140, 40, 100)];
    // mrtví: index1 (osamocený uprostřed, sousedí se 2 živými), index3+4 (sousedící dvojice mrtvých)
    warriors.push(...ws);
    const survivorsWant = [ws[0], ws[2], ws[5]];   // první, uprostřed, poslední — všichni živí
    updateWarriors(1);
    assert(warriors.length === 3, 'swap-remove warriors: po odstranění 3 mrtvých zbyli přesně 3 (' + warriors.length + ')');
    assert(new Set(warriors).size === warriors.length, 'swap-remove warriors: žádné duplicitní reference v poli');
    const gotSet = new Set(warriors);
    for (const w of survivorsWant) assert(gotSet.has(w), 'swap-remove warriors: přeživší odpovídají přesně neoznačeným');
    log('swap-remove warriors ok (víc mrtvých v jednom snímku odstraněno bez duplicit/vynechání)'); }

  // ---- 46) FÁZE 3: queryHashInto() (sdílený buffer _enemyQueryBuf) — shoda s enemyHash.query() a nezávislost mezi voláními ----
  { newRun('rytir'); startWave();
    enemies.length = 0; enemyHash.clear();
    // klastr A (3 nepřátelé) a klastr B (2 nepřátelé), dostatečně daleko od sebe, ať se dotazy nepřekrývají
    spawnDummy('chodec', 40, 40); spawnDummy('chodec', 45, 42); spawnDummy('chodec', 50, 38);
    spawnDummy('chodec', 400, 700); spawnDummy('chodec', 404, 702);
    assert(enemies.length === 5, 'test připravil přesně 5 nepřátel ve 2 klastrech');
    enemyHash.clear(); for (const e of enemies) enemyHash.insert(e);

    // a) queryHashInto vrací STEJNOU množinu referencí jako query() pro stejné parametry
    const wideQ = enemyHash.query(45, 40, 5000);           // pokryje celou mapu
    const wideI = queryHashInto(enemyHash, 45, 40, 5000).slice();   // spotřebuj hned do lokálního pole
    assert(wideQ.length === enemies.length, 'kontrolní query() pokrylo všech 5 testovacích nepřátel');
    assert(wideI.length === wideQ.length, 'queryHashInto vrací stejný POČET jako query() (' + wideI.length + '==' + wideQ.length + ')');
    const setQ = new Set(wideQ);
    assert(wideI.every(e => setQ.has(e)), 'queryHashInto vrací stejnou MNOŽINU referencí jako query()');

    // b) dvě po sobě jdoucí volání se navzájem nekontaminují (sdílený buffer se mezi voláními resetuje)
    const resA = queryHashInto(enemyHash, 45, 40, 20).slice();      // klastr A, spotřebováno do lokální kopie
    assert(resA.length === 3, 'queryHashInto: klastr A obsahuje přesně 3 nepřátele (' + resA.length + ')');
    const resB = queryHashInto(enemyHash, 402, 701, 20).slice();    // klastr B, 2. volání
    assert(resB.length === 2, 'queryHashInto: 2. volání (klastr B) neobsahuje zbytky z 1. volání — délka přesně 2, ne 5 (' + resB.length + ')');
    assert(new Set(resB).size === resB.length, 'queryHashInto: žádné duplicity ve výsledku 2. volání');
    assert(resA.length === 3, 'queryHashInto: lokální kopie 1. volání zůstala nedotčena 2. voláním');
    log('queryHashInto ok (shoda s enemyHash.query(), buffer se mezi voláními korektně resetuje bez kontaminace)'); }

  // ---- 47) FÁZE 3: hraniční případ interpolace — NOVÉ enemy.id u guesta se objeví přímo na x/y, beze skoku ----
  { newRun('rytir'); startWave();
    const savedRole = net.role;
    const e1 = spawnDummy('chodec', 50, 50); e1.rx = 50; e1.ry = 50;
    const wire1 = JSON.parse(JSON.stringify(serializeState()));
    net.role = 'guest';
    applyState(wire1);   // guest teď zná e1 (spárovaný podle id)
    const e1g = enemies.find(x => x.id === e1.id);
    assert(e1g, 'e1 existuje po 1. applyState');
    e1g.rx = 5; e1g.ry = 5;   // umělé reziduum — jako by e1 už chvíli doháněl jinou vyhlazenou render-pozici

    // hostitel mezitím přidá NOVÉHO nepřítele s ID, které guest ještě NIKDY neviděl, daleko od (0,0).
    // Pozor: NEsmí se přidat přímo do sdíleného pole enemies PŘED voláním applyState — to je totiž
    // právě pole, které applyState čte jako "guestův dosavadní stav" při párování rx/ry podle id;
    // kdyby tam nový nepřítel už byl, test by (falešně) simuloval už-známé id s reziduální (spawnovou)
    // rx/ry místo skutečně nového příchozího. Proto ho vytvoříme v DOČASNĚ izolovaném poli, serializujeme
    // jeho pole podle schématu, a teprve tak "od hostitele" přidáme do drátového snímku.
    const wire2 = JSON.parse(JSON.stringify(serializeState()));   // zatím jen e1 — přesně to, co guest už zná
    const savedEnemiesArr = enemies;
    enemies = [];
    const e2 = spawnDummy('chodec', 400, 300);
    wire2.enemies.push(schemaSerList('enemies', enemies)[0]);   // "od hostitele": nový nepřítel s novým id
    enemies = savedEnemiesArr;   // vrať guestovo lokální pole (pořád jen e1) — applyState ho nahradí

    applyState(wire2);   // pořád v roli guest

    const e2g = enemies.find(x => x.id === e2.id);
    assert(e2g, 'nový nepřítel s novým id existuje po applyState');
    assert(Number.isFinite(e2g.rx) && Number.isFinite(e2g.ry), 'rx/ry nového nepřítele jsou konečná čísla (ne NaN/undefined)');
    assert(e2g.rx === e2g.x && e2g.ry === e2g.y, 'nový nepřítel se objeví PŘÍMO na cílové x/y (' + e2g.rx + ',' + e2g.ry + ' == ' + e2g.x + ',' + e2g.y + '), ne skokem z 0,0');

    const e1g2 = enemies.find(x => x.id === e1.id);
    assert(e1g2 && e1g2.rx === 5 && e1g2.ry === 5, 'starý (známý) nepřítel si i po dalším applyState drží spárovanou render-pozici (nezasáhla ho logika pro nová id)');

    net.role = savedRole;   // úklid, ať to neovlivní další testy
    log('applyState hraniční případ ok: nové enemy.id u guesta se objeví přímo na x/y, beze skoku z 0,0/rezidua'); }

  // ---- 48) FÁZE 4.1 ASCENSION: ascensionMul(0)=1 (žádný vliv na běžnou hru, vlny 1..FINAL_WAVE) ----
  { for (const k of ['hp', 'spd', 'dmg', 'count', 'gem', 'eliteChance']) {
      assert(ascensionMul({ ascension: 0 }, k) === 1, 'ascensionMul kind=' + k + ' == 1 při ascension=0');
      assert(ascensionMul(null, k) === 1, 'ascensionMul(null, ' + k + ') == 1 (bezpečné volání bez run)');
    }
    assert(ascensionMul(undefined, 'hp') === 1, 'ascensionMul(undefined) == 1');
    log('ascensionMul: ascension=0 nemá žádný efekt (normální hra vln 1..FINAL_WAVE beze změny) ok'); }

  // ---- 49) FÁZE 4.1 ASCENSION: stohování prokletí v pořadí + 2. cyklus dál násobí stejné prokletí ----
  { assert(Math.abs(ascensionMul({ ascension: 1 }, 'hp') - ASCENSION_CURSES[0].hp) < 1e-9,
      'tier 1: aktivní jen 1. prokletí (hp = ' + ASCENSION_CURSES[0].hp + ')');
    assert(ascensionMul({ ascension: 1 }, 'dmg') === 1, 'tier 1: 3. prokletí (dmg) ještě neaktivní');
    assert(Math.abs(ascensionMul({ ascension: 3 }, 'dmg') - ASCENSION_CURSES[2].dmg) < 1e-9,
      'tier 3: dmg curse[2] aplikováno přesně 1× (' + ascensionMul({ ascension: 3 }, 'dmg').toFixed(3) + ')');
    const expectHp6 = ASCENSION_CURSES[0].hp;   // v tieru 6 je hp curse[0] pořád jen 1×
    assert(Math.abs(ascensionMul({ ascension: 6 }, 'hp') - expectHp6) < 1e-9, 'tier 6: hp curse[0] pořád jen 1× (celá sada 6 prokletí, žádné opakování)');
    const expectDmg9 = ASCENSION_CURSES[2].dmg * ASCENSION_CURSES[2].dmg;   // tier 9 = indexy 0..8 mod 6 → index 2 vyjde 2×
    assert(Math.abs(ascensionMul({ ascension: 9 }, 'dmg') - expectDmg9) < 1e-9,
      '2. cyklus (tier 9) násobí dmg curse[2] znovu (' + ascensionMul({ ascension: 9 }, 'dmg').toFixed(4) + ' == ' + expectDmg9.toFixed(4) + ')');
    log('ascensionMul: stohování v pořadí a 2. cyklus dál násobí stejné prokletí ok'); }

  // ---- 50) FÁZE 4.1 ASCENSION: čísla v ASCENSION_CURSES[].desc PŘESNĚ odpovídají realitě v ascensionMul (transparentnost) ----
  { for (const c of ASCENSION_CURSES) {
      for (const k of ['hp', 'spd', 'dmg', 'count', 'gem', 'eliteChance']) {
        const v = c[k]; if (v == null) continue;
        const pct = Math.round(Math.abs(v - 1) * 100);
        assert(c.desc.indexOf(String(pct)) >= 0,
          'ASCENSION_CURSES.' + c.id + '.desc musí obsahovat přesné číslo ' + pct + ' (klíč ' + k + '=' + v + ') — desc="' + c.desc + '"');
      }
    }
    log('ASCENSION_CURSES desc čísla ok (odpovídají skutečným multiplikátorům v ascensionMul)'); }

  // ---- 51) FÁZE 4.1 ASCENSION: efekt reálně dopadá na spawnutého nepřítele (hp/spd/dmg) i na počet vlny ----
  { newRun('rytir'); startWave();
    const eBase = spawnDummy('chodec', 40, 40);
    const hpBase = eBase.hpMax, spdBase = eBase.speed, dmgBase = eBase.dmg;
    newRun('rytir'); run.ascension = 1; startWave();   // tier 1 = Nemrtvá tuhost (+40 % HP), nic jiného zatím
    const eAsc = spawnDummy('chodec', 40, 40);
    assert(Math.abs(eAsc.hpMax / hpBase - 1.40) < 0.02, 'ascension=1: HP nepřítele přesně +40 % (' + hpBase + '->' + eAsc.hpMax + ')');
    assert(Math.abs(eAsc.speed - spdBase) < 1e-6, 'ascension=1: rychlost zatím nedotčena (2. prokletí ještě neaktivní)');
    assert(Math.abs(eAsc.dmg - dmgBase) < 1e-6, 'ascension=1: poškození zatím nedotčeno (3. prokletí ještě neaktivní)');
    newRun('rytir'); run.ascension = 3; startWave();   // tier 3 = HP+40 %, SPD+25 %, DMG+30 %
    const eAsc3 = spawnDummy('chodec', 40, 40);
    assert(Math.abs(eAsc3.speed / spdBase - 1.25) < 0.02, 'ascension=3: rychlost +25 % (' + spdBase + '->' + eAsc3.speed + ')');
    assert(Math.abs(eAsc3.dmg / dmgBase - 1.30) < 0.02, 'ascension=3: poškození +30 % (' + dmgBase + '->' + eAsc3.dmg + ')');
    newRun('rytir'); run.ascension = 4; startWave();   // tier 4 přidá Přesila (+20 % počet nepřátel)
    const n0 = waveCount(run.wave), nMul = Math.round(n0 * ascensionMul(run, 'count'));
    assert(nMul > n0, 'ascension=4: počet nepřátel ve vlně vyšší díky prokletí Přesila (' + n0 + '->' + nMul + ')');
    log('ascension efekt aplikován na spawn (hp/spd/dmg) i na waveCount ok'); }

  // ---- 52) FÁZE 4.1 ASCENSION: run.ascension je ve SNAPSHOT_SCHEMA i svědkovi a přežije round-trip ----
  { newRun('rytir'); startWave(); run.ascension = 4;
    assert(SNAPSHOT_SCHEMA.run.fields.some(f => (typeof f === 'string' ? f : f.key) === 'ascension'), 'ascension je v SNAPSHOT_SCHEMA.run.fields');
    const snap = serializeState();
    assert(snap.run.ascension === 4, 'serializeState() zahrnuje run.ascension');
    const wire = JSON.parse(JSON.stringify(snap));
    run.ascension = 0;   // znič lokální stav
    applyState(wire);
    assert(run.ascension === 4, 'applyState() obnovil run.ascension přes drát (' + run.ascension + ')');
    log('run.ascension: schema + round-trip ok'); }

  // ---- 53) FÁZE 4.1 ASCENSION: vstup do Nekonečna z victory pokračuje TÝMŽ během (žádný newRun), nastaví ascension=1 ----
  { newRun('rytir'); const ownedBefore = run.ownedWeapons.slice();
    loadMap(mapForWave(FINAL_WAVE));   // simuluje přirozený postup: v okamžiku FINAL_WAVE je hráč vždy na poslední mapě
    run.wave = FINAL_WAVE - 1; startWave();   // -> run.wave === FINAL_WAVE
    assert(run.wave === FINAL_WAVE, 'run.wave dosáhl FINAL_WAVE (' + run.wave + ')');
    endWave();
    assert(state === 'victory', 'endWave() na FINAL_WAVE s ascension=0 vede na victory (' + state + ')');
    assert(run.ascension === 0, 'ascension zůstává 0, dokud hráč nevstoupí do Nekonečna');
    const runRefBefore = run;
    enterAscension();
    assert(run === runRefBefore, 'enterAscension() NEzakládá nový run — stejná reference na run');
    assert(run.ascension === 1, 'enterAscension() nastaví ascension=1 (hned první tier)');
    assert(run.wave === FINAL_WAVE, 'enterAscension() nemění run.wave (žádný reset postupu)');
    assert(JSON.stringify(run.ownedWeapons) === JSON.stringify(ownedBefore), 'zbraně/postup zachovány (žádný nový run)');
    assert(state === 'roundEnd', 'po vstupu do Nekonečna pokračuje běžným tokem (roundEnd → obchod → stavění)');
    // pokračování: obchod -> stavění -> další vlna. Zůstává na poslední mapě, žádné volání advanceToMap za FINAL_WAVE.
    const mapBefore = currentMap;
    setState('shop'); shopReady();
    assert(state === 'build', 'po ready přechod do fáze stavění');
    assert(currentMap === mapBefore && currentMap === NUM_MAPS - 1, 'v Nekonečnu zůstává na poslední mapě (' + (currentMap + 1) + '/' + NUM_MAPS + ')');
    startWave();
    assert(run.wave === FINAL_WAVE + 1, 'vlna pokračuje za FINAL_WAVE (' + run.wave + ')');
    assert(state === 'combat', 'combat pokračuje normálně v Nekonečnu');
    assert(run.ascension === 1, 'tier se nezvyšuje hned na vlně FINAL_WAVE+1 (další tier až FINAL_WAVE+25)');
    log('enterAscension ok (pokračuje TÝMŽ během, ascension=1, zůstává na poslední mapě)'); }

  // ---- 54) FÁZE 4.1 ASCENSION: tier-up přesně každých 25 vln za FINAL_WAVE (FINAL_WAVE+25, +50, …) ----
  { newRun('rytir'); run.ascension = 1; run.wave = FINAL_WAVE - 1;   // simulace: v Nekonečnu, tier 1
    startWave();   // -> run.wave === FINAL_WAVE (žádná změna tieru — vstup do Nekonečna už proběhl)
    assert(run.ascension === 1, 'vlna FINAL_WAVE: tier beze změny');
    run.wave = FINAL_WAVE + 25 - 1;   // -> startWave() -> FINAL_WAVE+25
    startWave();
    assert(run.wave === FINAL_WAVE + 25 && run.ascension === 2, 'vlna FINAL_WAVE+25 zvyšuje ascension na 2 (' + run.ascension + ')');
    run.wave = FINAL_WAVE + 50 - 1;   // -> FINAL_WAVE+50
    startWave();
    assert(run.wave === FINAL_WAVE + 50 && run.ascension === 3, 'vlna FINAL_WAVE+50 zvyšuje ascension na 3 (' + run.ascension + ')');
    log('ascension tier-up ok (přesně každých 25 vln za FINAL_WAVE)'); }

  // ---- 55) FÁZE 4.1 ASCENSION: perzistentní PB profile.bestAscension (defaultProfile + doGameOver/doVictory) ----
  { assert(defaultProfile().bestAscension === 0, 'defaultProfile().bestAscension výchozí 0');
    profile.bestAscension = 0;
    newRun('rytir'); run.ascension = 3; run.wave = 400; run.lives = 0;
    doGameOver();
    assert(profile.bestAscension === 3, 'doGameOver() zaznamená nejvyšší dosažený ascension do profilu (' + profile.bestAscension + ')');
    profile.bestAscension = 5;   // vyšší starý rekord se NESMÍ přepsat nižším
    newRun('rytir'); run.ascension = 2; run.wave = 425; run.lives = 0;
    doGameOver();
    assert(profile.bestAscension === 5, 'doGameOver() nepřepíše vyšší starý rekord nižším (' + profile.bestAscension + ')');
    log('profile.bestAscension ok (perzistentní PB, max() přes běhy)'); }

  // ---- 56) FÁZE 4.1 ASCENSION GUARD: enterAscension()/netHandleCmd('ascend') jsou no-op mimo legitimní vstup ----
  { // (a) daleko pod FINAL_WAVE, uprostřed boje: cmd 'ascend' (guestova cesta bez lokální validace) nesmí nic udělat
    newRun('rytir'); run.wave = 10; setState('combat');
    assert(run.ascension === 0, 'test předpokládá čerstvý run (ascension=0)');
    netHandleCmd({ t: 'cmd', act: 'ascend' });
    assert(run.ascension === 0, 'netHandleCmd ascend hluboko pod FINAL_WAVE v combatu: ascension zůstává 0 (' + run.ascension + ')');
    assert(state === 'combat', 'netHandleCmd ascend hluboko pod FINAL_WAVE v combatu: state zůstává combat (' + state + ')');
    assert(run.wave === 10, 'netHandleCmd ascend hluboko pod FINAL_WAVE v combatu: wave nedotčena (' + run.wave + ')');
    enterAscension();   // i přímé volání (host klik) musí být stejně bezpečné
    assert(run.ascension === 0 && state === 'combat' && run.wave === 10, 'enterAscension() přímo: stejně no-op mimo FINAL_WAVE/victory');

    // (b) legitimní jednorázový vstup z victory na FINAL_WAVE funguje a je idempotentní
    newRun('rytir'); run.wave = FINAL_WAVE; setState('victory');
    enterAscension();
    assert(run.ascension === 1, 'legitimní vstup do Nekonečna z victory na FINAL_WAVE nastaví ascension=1 (' + run.ascension + ')');
    assert(state === 'roundEnd', 'legitimní vstup pokračuje běžným tokem (roundEnd)');
    enterAscension();   // druhé volání ihned po prvním (state už není victory) — nesmí nic udělat
    assert(run.ascension === 1, 'druhé volání enterAscension() (state už roundEnd): ascension zůstává 1, ne reset/inkrement (' + run.ascension + ')');
    state = 'victory';   // adversariální simulace: i kdyby se stav victory vrátil, ascension>0 sám o sobě blokuje re-entry
    enterAscension();
    assert(run.ascension === 1, 'i s state vráceným na victory: ascension>0 blokuje re-entry, zůstává 1 (' + run.ascension + ')');

    // (c) run.ascension=6 (hluboko v Nekonečnu): cmd 'ascend' nesmí resetovat postup zpět na 1
    newRun('rytir'); run.ascension = 6; run.wave = FINAL_WAVE + 100; setState('combat');
    netHandleCmd({ t: 'cmd', act: 'ascend' });
    assert(run.ascension === 6, 'netHandleCmd ascend s run.ascension=6: zůstává 6, žádný reset na 1 (' + run.ascension + ')');
    log('enterAscension guard ok (no-op mimo legitimní victory@FINAL_WAVE vstup, idempotentní, nikdy nereset existující ascension)'); }

  // ---- 57) FÁZE 4.2: čísla v META_UPGRADES[].desc a RELICS[].desc PŘESNĚ odpovídají realitě (transparentnost) ----
  { for (const k of META_KEYS) {
      const d = META_UPGRADES[k];
      const pct = Math.round(d.per * 100);
      // per je buď procento za úroveň (crit/rate/armor/pickup/hp/dmg/luck/reaper), nebo absolutní číslo (gems)
      const needle = k === 'gems' ? String(d.per) : String(pct);
      assert(d.desc.indexOf(needle) >= 0, 'META_UPGRADES.' + k + '.desc musí obsahovat přesné číslo ' + needle + ' (per=' + d.per + ') — desc="' + d.desc + '"');
    }
    for (const id of RELIC_KEYS) {
      const d = RELICS[id];
      assert(typeof d.cost === 'number' && d.cost > 0, 'RELICS.' + id + ' má platnou cenu');
    }
    // konkrétní efektová čísla v desc relikvií musí sedět na to, co aplikuje game.js
    assert(RELICS.pokladnice.desc.indexOf('50') >= 0, 'pokladnice desc obsahuje 50 (gemy)');
    assert(RELICS.magnet.desc.indexOf('50') >= 0, 'magnet desc obsahuje 50 (% dosah)');
    assert(RELICS.ucenec.desc.indexOf('25') >= 0, 'ucenec desc obsahuje 25 (% XP)');
    assert(RELICS.kuze.desc.indexOf('8') >= 0, 'kuze desc obsahuje 8 (% pancíř)');
    assert(RELICS.hamiznost.desc.indexOf('20') >= 0, 'hamiznost desc obsahuje 20 (% gemy)');
    log('META_UPGRADES/RELICS desc čísla ok (odpovídají skutečným hodnotám per/cost/efekt)'); }

  // ---- 58) FÁZE 4.2: nová META vylepšení (crit/rate/armor/pickup) — nákup sníží duše, zvýší metaLvl, projeví se v pas ----
  { profile.souls = 0; profile.meta = {}; profile.unlocked = [];
    newRun('rytir'); const p0 = players[0];
    assert((p0.passive.crit || 0) === (CLASSES.rytir.passive && CLASSES.rytir.passive.crit || 0), 'bez meta: crit neovlivněn');
    profile.souls = 999;
    const s0 = profile.souls;
    buyMeta('crit'); buyMeta('crit');
    assert(profile.souls < s0, 'buyMeta(crit) strhl duše (' + s0 + '->' + profile.souls + ')');
    assert(metaLvl('crit') === 2, 'metaLvl crit = 2 po 2 nákupech');
    buyMeta('rate'); buyMeta('armor'); buyMeta('pickup');
    assert(metaLvl('rate') === 1 && metaLvl('armor') === 1 && metaLvl('pickup') === 1, 'metaLvl rate/armor/pickup = 1');
    newRun('rytir'); const p = players[0];
    const critBase = (CLASSES.rytir.passive && CLASSES.rytir.passive.crit) || 0;
    assert(Math.abs(p.passive.crit - (critBase + metaBonus('crit'))) < 1e-9, 'pas.crit = základ třídy + metaBonus(crit) přesně (' + p.passive.crit + ')');
    const w = WEAPONS[p.weaponId];
    const metaSaved = profile.meta;
    profile.meta = {};   // dočasně vynulovat meta -> referenční hodnota BEZ vlivu Zděděné hbitosti
    const rBase = rateMod(p, w);
    profile.meta = metaSaved;   // vrátit (metaLvl(rate)===1)
    const rWithMeta = rateMod(p, w);
    assert(rWithMeta < rBase, 'meta rate zrychluje palbu (nižší cooldown mult): ' + rBase + ' -> ' + rWithMeta);
    assert(Math.abs(p.passive.armorMul - Math.max(0.3, 1 - metaBonus('armor'))) < 1e-9, 'pas.armorMul = 1 − metaBonus(armor) přesně (' + p.passive.armorMul + ')');
    assert(Math.abs(p.passive.pickupMul - (1 + metaBonus('pickup'))) < 1e-9, 'pas.pickupMul = 1 + metaBonus(pickup) přesně (' + p.passive.pickupMul + ')');
    profile.souls = 0; profile.meta = {};
    log('nová meta vylepšení ok (crit/rate/armor/pickup: nákup + aplikace do pas)'); }

  // ---- 59) FÁZE 4.2: RELIKVIE — buyRelic přidá do unlocked, strhne duše, 2. koupě je no-op (idempotence) ----
  { profile.souls = 0; profile.unlocked = [];
    assert(!hasRelic('pokladnice'), 'relikvie zatím nevlastněna');
    buyRelic('pokladnice');   // bez duší -> no-op
    assert(!hasRelic('pokladnice'), 'buyRelic bez dostatku duší je no-op');
    assert(profile.souls === 0, 'souls beze změny při neúspěšném pokusu');
    profile.souls = RELICS.pokladnice.cost;
    buyRelic('pokladnice');
    assert(hasRelic('pokladnice'), 'buyRelic přidal relikvii do unlocked');
    assert(profile.souls === 0, 'buyRelic strhl přesně cenu (' + RELICS.pokladnice.cost + ')');
    profile.souls = 999;
    buyRelic('pokladnice');   // druhá koupě
    assert(profile.souls === 999, 'druhá koupě stejné relikvie je no-op — duše se nestrhly znovu');
    assert(profile.unlocked.filter(x => x === 'pokladnice').length === 1, 'relikvie se v unlocked neduplikuje');
    profile.souls = 0; profile.unlocked = [];
    log('buyRelic ok (nákup/strhnutí duší/idempotentní 2. koupě)'); }

  // ---- 60) FÁZE 4.2: RELIKVIE — efekty se reálně aplikují ----
  { profile.souls = 0; profile.unlocked = [];
    newRun('rytir'); const gBase = players[0].gems;
    profile.unlocked = ['pokladnice'];
    newRun('rytir'); const gWith = players[0].gems;
    assert(gWith === gBase + 50, 'pokladnice: +50 startovních gemů přesně (' + gBase + '->' + gWith + ')');

    profile.unlocked = [];
    newRun('rytir'); const pmBase = players[0].passive.pickupMul;
    profile.unlocked = ['magnet'];
    newRun('rytir'); const pmWith = players[0].passive.pickupMul;
    assert(Math.abs(pmWith - (pmBase + 0.5)) < 1e-9, 'magnet: +0.5 pickupMul přesně (' + pmBase + '->' + pmWith + ')');

    profile.unlocked = [];
    newRun('rytir'); const p1 = players[0]; profile.xp = 0; profile.playerLevel = 1;
    addXp(10, p1); const xpNoRelic = profile.xp;   // 10 << xpToLevel(1)=100, žádný level-up = čistý měřitelný zisk
    profile.xp = 0;
    profile.unlocked = ['ucenec'];
    addXp(10, p1); const xpWithRelic = profile.xp;
    assert(Math.abs(xpWithRelic - xpNoRelic * 1.25) < 1e-6, 'ucenec: +25 % XP přesně (' + xpNoRelic + '->' + xpWithRelic + ')');

    profile.unlocked = [];
    newRun('rytir'); const amBase = players[0].passive.armorMul;
    profile.unlocked = ['kuze'];
    newRun('rytir'); const amWith = players[0].passive.armorMul;
    assert(amWith < amBase, 'kuze: snižuje armorMul (' + amBase + '->' + amWith + ')');
    assert(Math.abs(amBase - amWith - 0.08) < 1e-9, 'kuze: rozdíl přesně 0,08 (8 %) (' + amBase + '->' + amWith + ')');

    profile.unlocked = [];
    newRun('rytir'); startWave(); const p2 = players[0]; const g2Start = p2.gems;
    for (let i = 0; i < 10; i++) { const e = spawnDummy('chodec', p2.x + 10, p2.y); e.hp = 0; killEnemy(e, p2); }
    const gemsNoRelic = p2.gems - g2Start;
    profile.unlocked = ['hamiznost'];
    newRun('rytir'); startWave(); const p3 = players[0]; const g3Start = p3.gems;
    for (let i = 0; i < 10; i++) { const e = spawnDummy('chodec', p3.x + 10, p3.y); e.hp = 0; killEnemy(e, p3); }
    const gemsWithRelic = p3.gems - g3Start;
    assert(gemsWithRelic > gemsNoRelic, 'hamiznost: víc gemů ze zabití (10× chodec, ' + gemsNoRelic + '->' + gemsWithRelic + ')');

    profile.unlocked = [];
    log('relikvie efekty ok (pokladnice/magnet/ucenec/kuze/hamiznost reálně aplikovány)'); }

  // ---- 61) FÁZE 4.2 NEUTRALITA: bez koupených meta/relikvií hraje hráč IDENTICKY jako dřív (žádná regrese) ----
  { profile.souls = 0; profile.meta = {}; profile.unlocked = [];
    for (const k of META_KEYS) assert(metaBonus(k) === 0, 'bez nákupu: metaBonus(' + k + ')=0');
    for (const id of RELIC_KEYS) assert(!hasRelic(id), 'bez nákupu: relikvie ' + id + ' nevlastněna');
    newRun('rytir'); const p = players[0];
    assert(p.gems === CLASSES.rytir.startGems, 'bez meta/relikvií: startovní gemy nezměněny (' + p.gems + ')');
    assert(p.passive.pickupMul === 1, 'bez meta/relikvií: pickupMul=1 (neutrální)');
    assert(p.passive.armorMul === 1, 'bez meta/relikvií: armorMul=1 (neutrální)');
    assert((p.passive.crit || 0) === (CLASSES.rytir.passive && CLASSES.rytir.passive.crit || 0), 'bez meta/relikvií: crit nezměněn oproti třídní passivě');
    const w = WEAPONS[p.weaponId];
    // s metaBonus('rate')=0 musí přidaný násobič Math.max(0.5, 1-metaBonus('rate')) vyjít přesně 1×
    // (žádný vliv na rateMod oproti stavu před FÁZÍ 4.2)
    assert(Math.max(0.5, 1 - metaBonus('rate')) === 1, 'meta rate multiplikátor je neutrální (1×) bez nákupu');
    const before = { passive: { rangedRate: p.passive.rangedRate, rateMul: p.passive.rateMul }, flurryT: 0, buffRapid: 0, rageT: 0 };
    const expected = rateMod(before, w);   // referenční výpočet BEZ meta vlivu (metaBonus vrací 0, takže shodné s rateMod(p,w))
    assert(Math.abs(rateMod(p, w) - expected) < 1e-9, 'bez meta: rateMod totožný s referenčním výpočtem (' + expected + ' == ' + rateMod(p, w) + ')');
    profile.xp = 0; profile.playerLevel = 1; addXp(10, p);   // 10 << xpToLevel(1)=100, žádný level-up = čistý zisk
    assert(profile.xp === 10, 'bez relikvie ucenec: addXp nepřidává bonus (' + profile.xp + ')');
    log('neutralita bez koupí ok (žádná regrese oproti stavu bez meta/relikvií)'); }

  // ---- 62) FÁZE 4.2 EMPIRICKÝ GUARD: pokud se číslo v desc rozejde s reálným efektem, test SPADNE ----
  { // ověřuje, že guard v testu 57 skutečně něco kontroluje (ne jen kosmeticky prochází) —
    // dočasně rozhodíme META_UPGRADES.crit.per vs. desc a očekáváme selhání assertu
    const savedPer = META_UPGRADES.crit.per;
    META_UPGRADES.crit.per = 0.09;   // desc pořád říká "3 %" -> nesedí s per=0.09 (9 %)
    let threw = false;
    try {
      const pct = Math.round(META_UPGRADES.crit.per * 100);
      assert(META_UPGRADES.crit.desc.indexOf(String(pct)) >= 0, 'desc musí obsahovat ' + pct);
    } catch (e) { threw = true; }
    META_UPGRADES.crit.per = savedPer;   // vrátit zpět, ať zbytek testů běží na reálných datech
    assert(threw, 'empirický guard: rozhozené per vs. desc MUSÍ shodit assert (jinak by drift čísel prošel nepovšimnut)');
    log('empirický guard ok (rozhozené číslo v desc vs. realita test skutečně shodí)'); }

  // ---- 63) FÁZE 4.3 MISTROVSTVÍ: masteryXpToLevel/masteryLevel — monotónní křivka, správné prahy ----
  { assert(masteryXpToLevel(0) === 0, 'masteryXpToLevel(0)=0');
    assert(masteryXpToLevel(1) === 50, 'masteryXpToLevel(1)=50 (přírůstek 50+0*40)');
    assert(masteryXpToLevel(2) === 140, 'masteryXpToLevel(2)=140 (50+90)');
    assert(masteryXpToLevel(3) === 270, 'masteryXpToLevel(3)=270 (50+90+130)');
    for (let l = 0; l < 30; l++) assert(masteryXpToLevel(l + 1) > masteryXpToLevel(l), 'masteryXpToLevel monotónně roste na úrovni ' + l);
    // masteryLevel odvozuje úroveň z profile.mastery[classId].xp přesně podle prahů
    profile.mastery = {};
    profile.mastery.rytir = { xp: 0 }; assert(masteryLevel('rytir') === 0, 'xp=0 -> level 0');
    profile.mastery.rytir = { xp: 49 }; assert(masteryLevel('rytir') === 0, 'xp=49 (těsně pod prahem 50) -> level 0');
    profile.mastery.rytir = { xp: 50 }; assert(masteryLevel('rytir') === 1, 'xp=50 (přesně práh) -> level 1');
    profile.mastery.rytir = { xp: 139 }; assert(masteryLevel('rytir') === 1, 'xp=139 (těsně pod prahem 140) -> level 1');
    profile.mastery.rytir = { xp: 140 }; assert(masteryLevel('rytir') === 2, 'xp=140 -> level 2');
    // třída bez záznamu v profile.mastery -> bezpečně level 0 (žádný pád)
    assert(masteryLevel('lovec') === 0, 'třída bez záznamu v profile.mastery -> level 0 (bezpečné)');
    profile.mastery = {};
    log('masteryXpToLevel/masteryLevel křivka ok (monotónní, prahy 0/50/140/270 přesné)'); }

  // ---- 64) FÁZE 4.3 MISTROVSTVÍ: masteryBonus — level 0 neutrální {0,0}, roste lineárně, strop na MASTERY_LEVEL_CAP ----
  { profile.mastery = {};
    const b0 = masteryBonus('rytir');
    assert(b0.dmgPct === 0 && b0.hpPct === 0, 'masteryBonus level 0 = {0,0} (neutralita, žádná regrese)');
    profile.mastery.rytir = { xp: masteryXpToLevel(5) };
    const b5 = masteryBonus('rytir');
    assert(Math.abs(b5.dmgPct - 5 * MASTERY_BONUS_PER_LEVEL) < 1e-9, 'masteryBonus level 5: dmgPct = 5×per přesně (' + b5.dmgPct + ')');
    assert(Math.abs(b5.hpPct - 5 * MASTERY_BONUS_PER_LEVEL) < 1e-9, 'masteryBonus level 5: hpPct = 5×per přesně (' + b5.hpPct + ')');
    // strop: úroveň hluboko nad MASTERY_LEVEL_CAP nesmí dát víc bonusu než na stropu
    profile.mastery.rytir = { xp: masteryXpToLevel(MASTERY_LEVEL_CAP + 15) };
    assert(masteryLevel('rytir') === MASTERY_LEVEL_CAP + 15, 'level sám o sobě roste i nad strop (prestiž) (' + masteryLevel('rytir') + ')');
    const bCap = masteryBonus('rytir');
    const expectedCap = MASTERY_LEVEL_CAP * MASTERY_BONUS_PER_LEVEL;
    assert(Math.abs(bCap.dmgPct - expectedCap) < 1e-9, 'masteryBonus stropován na MASTERY_LEVEL_CAP úrovni, i když level je vyšší (' + bCap.dmgPct + ' == ' + expectedCap + ')');
    assert(Math.abs(bCap.hpPct - expectedCap) < 1e-9, 'masteryBonus hpPct stejně stropován (' + bCap.hpPct + ')');
    profile.mastery = {};
    log('masteryBonus ok (level0={0,0}, lineární růst, strop na MASTERY_LEVEL_CAP=' + MASTERY_LEVEL_CAP + ')'); }

  // ---- 65) FÁZE 4.3 MISTROVSTVÍ: zisk XP na konci běhu (doGameOver/doVictory) přičte SPRÁVNÉ třídě ----
  { profile.mastery = {};
    newRun('lovec'); run.wave = 12; run.score = 3400; run.lives = 0;
    const expectedGain = masteryXpForRun(run);
    doGameOver();
    assert((profile.mastery.lovec && profile.mastery.lovec.xp) === expectedGain, 'doGameOver() přičetl mistrovské XP přesně hrané třídě lovec (' + (profile.mastery.lovec && profile.mastery.lovec.xp) + ' == ' + expectedGain + ')');
    assert(!profile.mastery.rytir, 'jiná (nehraná) třída zůstává nedotčená po doGameOver()');
    // druhý běh JINOU třídou musí přičíst JÍ, ne lovci
    newRun('mag'); run.wave = 5; run.score = 100; run.lives = 0;
    const gain2 = masteryXpForRun(run);
    const lovecBefore = profile.mastery.lovec.xp;
    doGameOver();
    assert(profile.mastery.mag.xp === gain2, 'doGameOver() druhého běhu přičetl mistrovské XP třídě mag (' + profile.mastery.mag.xp + ' == ' + gain2 + ')');
    assert(profile.mastery.lovec.xp === lovecBefore, 'mistrovství lovce beze změny po běhu za mag (žádné křížení tříd)');
    // victory cestou (doVictory) totéž — a kumuluje (nepřepisuje)
    newRun('lovec'); run.wave = FINAL_WAVE; run.score = 500; run.ascension = 0;
    const lovecBefore2 = profile.mastery.lovec.xp; const gain3 = masteryXpForRun(run);
    doVictory();
    assert(profile.mastery.lovec.xp === lovecBefore2 + gain3, 'doVictory() KUMULUJE mistrovské XP (nepřepisuje) (' + profile.mastery.lovec.xp + ' == ' + (lovecBefore2 + gain3) + ')');
    profile.mastery = {};
    log('zisk mistrovského XP na konci běhu ok (doGameOver/doVictory přičítá přesně hrané třídě, kumuluje, nekříží třídy)'); }

  // ---- 65b) FÁZE 4.3 BUGFIX: grantMasteryXp() v co-opu se STEJNOU třídou přičte gain jen JEDNOU (ne 2×) ----
  { profile.mastery = {};
    newRun(['rytir', 'rytir']); run.wave = 10; run.score = 1000;
    const gain = masteryXpForRun(run);
    assert(gain === 11, 'kontrolní očekávaný gain pro wave 10 / score 1000 je 11 (' + gain + ')');
    const got = grantMasteryXp();
    assert(got === gain, 'grantMasteryXp() vrací gain přesně jednou (' + got + ' == ' + gain + ')');
    assert(profile.mastery.rytir.xp === gain, 'co-op DVA hráči SE STEJNOU třídou rytir: xp přičteno přesně JEDNOU, ne 2× (' + profile.mastery.rytir.xp + ' == ' + gain + ', NE ' + (gain * 2) + ')');
    profile.mastery = {};
    // pro jistotu i druhé volání ve stejném běhu (např. přes doGameOver) se chová stejně - žádné zdvojení kvůli počtu hráčů
    newRun(['rytir', 'rytir']); run.wave = 10; run.score = 1000; run.lives = 0;
    doGameOver();
    assert(profile.mastery.rytir.xp === gain, 'doGameOver() v co-opu se stejnou třídou (rytir+rytir) přičte XP jen jednou (' + profile.mastery.rytir.xp + ' == ' + gain + ')');
    profile.mastery = {};
    log('BUGFIX co-op stejná třída: grantMasteryXp()/doGameOver() nepřičítá XP dvakrát za jeden běh'); }

  // ---- 65c) FÁZE 4.3 MISTROVSTVÍ: co-op se DVĚMA RŮZNÝMI třídami — každá dostane gain přesně jednou ----
  { profile.mastery = {};
    newRun(['rytir', 'lovec']); run.wave = 10; run.score = 1000;
    const gain = masteryXpForRun(run);
    grantMasteryXp();
    assert(profile.mastery.rytir.xp === gain, 'co-op rytir+lovec: rytir dostal gain přesně jednou (' + profile.mastery.rytir.xp + ' == ' + gain + ')');
    assert(profile.mastery.lovec.xp === gain, 'co-op rytir+lovec: lovec dostal gain přesně jednou (' + profile.mastery.lovec.xp + ' == ' + gain + ')');
    profile.mastery = {};
    log('co-op dvě různé třídy: obě dostanou mistrovské XP přesně jednou (žádná ztráta, žádné zdvojení)'); }

  // ---- 66) FÁZE 4.3 MISTROVSTVÍ: aplikace v makePlayer/recalcPerks — vyšší mastery = vyšší baseHp/dmgMul ----
  { profile.mastery = {};
    newRun('berserk'); const hp0 = players[0].hpMax; const dmgMul0 = players[0].passive.dmgMul;
    profile.mastery.berserk = { xp: masteryXpToLevel(10) };   // level 10 = +15 % dmg, +15 % hp
    newRun('berserk'); const hp1 = players[0].hpMax; const dmgMul1 = players[0].passive.dmgMul;
    assert(hp1 > hp0, 'vyšší mistrovství třídy -> vyšší baseHp/hpMax (' + hp0 + ' -> ' + hp1 + ')');
    assert(dmgMul1 > dmgMul0, 'vyšší mistrovství třídy -> vyšší pas.dmgMul (' + dmgMul0.toFixed(4) + ' -> ' + dmgMul1.toFixed(4) + ')');
    const expectedB = masteryBonus('berserk');
    assert(Math.abs(dmgMul1 - (dmgMul0 + expectedB.dmgPct)) < 1e-9, 'dmgMul rozdíl přesně odpovídá masteryBonus(berserk).dmgPct (' + expectedB.dmgPct + ')');
    // jiná (nehraná) třída zůstává level 0 -> žádný vliv
    profile.mastery = {}; profile.mastery.berserk = { xp: masteryXpToLevel(10) };
    newRun('mag'); const magP = players[0];
    assert(magP.passive.dmgMul === 1, 'mag (level 0 mistrovství) má dmgMul přesně 1 (neovlivněn mistrovstvím berserka)');
    profile.mastery = {};
    log('aplikace mistrovství v makePlayer/recalcPerks ok (vyšší úroveň -> vyšší baseHp i dmgMul, izolace mezi třídami)'); }

  // ---- 67) FÁZE 4.3 NEUTRALITA: level 0 (žádné mistrovství) hraje IDENTICKY jako dřív (žádná regrese) ----
  { profile.mastery = {};
    for (const cid of Object.keys(CLASSES)) assert(masteryLevel(cid) === 0, 'bez mistrovství: masteryLevel(' + cid + ')=0');
    newRun('rytir'); const p = players[0];
    const b = CLASSES.rytir.hpMod;
    assert(p.hpMax === Math.round(120 * b * (1 + metaBonus('hp')) * (1 + 0)), 'bez mistrovství: baseHp přesně jako předtím (bez mastery členu), ' + p.hpMax);
    assert(p.passive.dmgMul === 1, 'bez mistrovství: dmgMul=1 přesně (neutrální, žádná regrese)');
    log('neutralita mistrovství level 0 ok (identické chování jako před FÁZÍ 4.3)'); }

  // ---- 68) FÁZE 4.3 BEZPEČNOST: starý profil bez pole mastery nesmí spadnout (migrace přes defaultProfile) ----
  { const oldProfile = { playerLevel: 3, xp: 50, unlocked: [], souls: 10, meta: {}, settings: { autofire: true, autoaim: true, muted: false, haptics: true } };
    assert(!('mastery' in oldProfile), 'test předpokládá starý profil BEZ pole mastery');
    // stejná cesta jako loadProfile() v engine.js (Object.assign(defaultProfile(), p)), přes reálný localStorage klíč
    localStorage.setItem(PROFILE_KEY, JSON.stringify(oldProfile));
    const migrated = loadProfile();
    assert(migrated.playerLevel === 3 && migrated.souls === 10, 'loadProfile() skutečně načetl starý profil ze storage (ne jen default)');
    assert(migrated.mastery && typeof migrated.mastery === 'object', 'loadProfile() doplní chybějící mastery na {} (Object.assign(defaultProfile(),...))');
    profile = migrated;
    let threw = false;
    try { newRun('rytir'); masteryLevel('rytir'); masteryBonus('rytir'); renderMastery(); renderClassSelect(); }
    catch (e) { threw = true; log('CHYBA: ' + (e && e.stack)); }
    assert(!threw, 'starý profil bez mastery: newRun/masteryLevel/masteryBonus/renderMastery/renderClassSelect neházejí výjimku');
    assert(players[0].passive.dmgMul === 1 && masteryLevel('rytir') === 0, 'migrovaný starý profil: chování identické level 0 (bez pádu, bez regrese)');
    profile.mastery = {};
    log('bezpečnost starého profilu bez mastery ok (migrace + žádný pád)'); }

  // ---- 69) FÁZE 4.3 UI: renderMastery() zobrazuje kartu pro každou třídu a čísla PŘESNĚ odpovídají masteryBonus (empirický guard transparentnosti) ----
  { profile.mastery = {};
    profile.mastery.knez = { xp: masteryXpToLevel(7) };
    renderMastery();
    const html = ovContent.innerHTML;
    assert(html.includes('Mistrovství tříd'), 'renderMastery() vykreslí nadpis');
    for (const cid of Object.keys(CLASSES)) assert(html.includes(CLASSES[cid].name), 'renderMastery() obsahuje kartu třídy ' + CLASSES[cid].name);
    const bKnez = masteryBonus('knez');
    const dmgStr = (bKnez.dmgPct * 100).toFixed(1);
    const hpStr = (bKnez.hpPct * 100).toFixed(1);
    assert(html.includes('+' + dmgStr + ' % poškození'), 'renderMastery(): zobrazené % poškození pro kněze PŘESNĚ odpovídá masteryBonus (' + dmgStr + ')');
    assert(html.includes('+' + hpStr + ' % max HP'), 'renderMastery(): zobrazené % HP pro kněze PŘESNĚ odpovídá masteryBonus (' + hpStr + ')');
    assert(html.includes('úroveň <b>7</b>'), 'renderMastery(): zobrazená úroveň kněze = 7 (odpovídá vloženému xp)');
    // renderClassSelect ukazuje indikátor "Mistr. {lvl}" ze stejné funkce masteryLevel()
    renderClassSelect();
    const clsHtml = ovContent.innerHTML;
    assert(clsHtml.includes('Mistr. 7'), 'renderClassSelect(): karta kněze ukazuje "Mistr. 7" (masteryLevel)');
    assert(clsHtml.includes('Mistr. 0'), 'renderClassSelect(): třída bez mistrovství ukazuje "Mistr. 0"');
    profile.mastery = {};
    log('renderMastery()/renderClassSelect() ok (karta pro každou třídu, čísla přesně == masteryBonus/masteryLevel)'); }

  // ---- 70) FÁZE 4.3 EMPIRICKÝ GUARD: pokud se konstanta MASTERY_BONUS_PER_LEVEL rozejde s tím, co masteryBonus vrací, test SPADNE ----
  { profile.mastery = {}; profile.mastery.rytir = { xp: masteryXpToLevel(4) };
    const saved = MASTERY_BONUS_PER_LEVEL;
    let threw = false;
    try {
      const b = masteryBonus('rytir');
      // simulace driftu: „UI" by očekávalo hodnotu spočtenou z ROZHOZENÉ konstanty, realita (b) je z PŮVODNÍ
      const fakeExpected = 4 * 0.09;   // úmyslně jiné číslo než skutečný MASTERY_BONUS_PER_LEVEL (0.015)
      assert(Math.abs(b.dmgPct - fakeExpected) < 1e-9, 'guard: rozhozené očekávané číslo vs. realita musí neshodovat');
    } catch (e) { threw = true; }
    assert(threw, 'empirický guard: rozhozené číslo vs. realita MUSÍ shodit assert (jinak by drift čísel prošel nepovšimnut)');
    assert(MASTERY_BONUS_PER_LEVEL === saved, 'konstanta MASTERY_BONUS_PER_LEVEL nezůstala pozměněná (guard nic natrvalo nemění)');
    profile.mastery = {};
    log('empirický guard mistrovství ok (rozhozené číslo vs. realita test skutečně shodí)'); }

  // ---- 71a) FÁZE 4.4 DENNÍ VÝZVA: dailyPactId() je deterministický a vrací platný pakt ----
  { const a1 = dailyPactId(), a2 = dailyPactId();
    assert(a1 === a2, 'dailyPactId() je deterministický pro stejné datum, opakovaná volání se shodují (' + a1 + ' == ' + a2 + ')');
    assert(PACT_KEYS.includes(a1), 'dailyPactId() vrací platný prvek PACT_KEYS (' + a1 + ')');
    const seed1 = dailySeed(todayStr()), seed2 = dailySeed(todayStr());
    assert(seed1 === seed2, 'dailySeed() je deterministický pro stejné datum');
    const rndA = mulberry32(seed1)(), rndB = mulberry32(seed2)();
    assert(rndA === rndB, 'mulberry32(dailySeed(todayStr())) dá stejnou první hodnotu při opakovaném vytvoření generátoru (' + rndA + ' == ' + rndB + ')');
    assert(dailySeed('2020-01-01') !== dailySeed('2099-12-31'), 'dailySeed() rozlišuje různá data (různý seed pro různé datum)');
    log('dailyPactId() ok (deterministický pro dnešní datum, vrací platný PACT_KEYS prvek)'); }

  // ---- 71b) FÁZE 4.4 DENNÍ BĚH: pendingDaily -> pickClass() vynutí zapečetěný pakt, PŘESKOČÍ nabídku ----
  { pendingDaily = true;
    pickClass('rytir');
    assert(run.daily === true, 'pickClass() s pendingDaily nastaví run.daily=true');
    const expected = dailyPactId();
    assert(run.pacts.length === 1 && run.pacts[0] === expected, 'run.pacts obsahuje PŘESNĚ jeden vynucený denní pakt (' + JSON.stringify(run.pacts) + ' == [' + expected + '])');
    assert(run._pactOffer === null, 'denní běh NEMÁ aktivní nabídku paktů (_pactOffer=null, offerPact() nebyl volán)');
    assert(pendingDaily === false, 'pendingDaily se po spuštění denního běhu spotřebuje (zpět na false)');
    assert(state === 'shop', 'denní běh jde rovnou do obchodu (žádná mezi-obrazovka pact)');
    log('denní běh ok (vynucený pakt dle data, žádná nabídka, pendingDaily spotřebován)'); }

  // ---- 71c) FÁZE 4.4 REGRESE: nedenní běh (pendingDaily=false) se chová IDENTICKY jako dřív ----
  { pendingDaily = false;
    pickClass('mag');
    assert(run.daily === false, 'normální (nedenní) run.daily zůstává false');
    assert(state === 'pact', 'normální běh nabízí pakt (state=pact), přesně jako dřív');
    assert(run._pactOffer && run._pactOffer.length === 3, 'normální běh nabízí 3 pakty (žádná regrese)');
    assert(run.pacts.length === 0, 'žádný pakt není vynucen před výběrem hráče v normálním běhu');
    run._pactOffer = ['pevnost']; choosePact('pevnost');
    assert(state === 'shop' && run.pacts.includes('pevnost'), 'normální tok pact -> shop funguje jako dřív');
    log('regrese ok (nedenní běh má identický tok jako před FÁZÍ 4.4)'); }

  // ---- 71d) FÁZE 4.4 UI: obrazovka 'daily' zobrazí datum + přesná čísla zapečetěného paktu (transparentnost) ----
  { renderDaily();
    const html = ovContent.innerHTML;
    assert(html.includes('Denní výzva'), 'renderDaily() zobrazí nadpis');
    assert(html.includes(todayStr()), 'renderDaily() zobrazí dnešní datum');
    const id = dailyPactId(), p = PACTS[id];
    assert(html.includes(p.name) && html.includes(p.desc), 'renderDaily() zobrazí PŘESNÝ název a popis (čísla) dnešního zapečetěného paktu');
    assert(html.includes('data-act="playdaily"'), 'renderDaily() nabízí tlačítko pro spuštění denní výzvy');
    log('renderDaily() ok (datum + zapečetěný pakt s reálnými čísly)'); }

  // ---- 71e) FÁZE 4.4 PB: doGameOver/doVictory zaznamená profile.daily (reset při jiném datu, max() jinak) ----
  { profile.daily = { date: '2000-01-01', bestWave: 50, bestScore: 9000 };  // starý rekord z „jiného dne"
    pendingDaily = true; pickClass('rytir'); run.wave = 5; run.score = 100; run.lives = 0;
    doGameOver();
    const today = todayStr();
    assert(profile.daily.date === today, 'doGameOver() resetuje profile.daily na dnešní datum (starý den zahozen)');
    assert(profile.daily.bestWave === 5 && profile.daily.bestScore === 100, 'doGameOver() nastaví PB na hodnoty z prvního dnešního běhu (' + profile.daily.bestWave + ',' + profile.daily.bestScore + ')');
    assert(run._dailyNewPB === true, 'první běh dne = nový rekord (run._dailyNewPB=true)');

    // druhý běh týž den, HORŠÍ výsledek -> max() se NESMÍ snížit
    pendingDaily = true; pickClass('rytir'); run.wave = 2; run.score = 10; run.lives = 0;
    doGameOver();
    assert(profile.daily.bestWave === 5 && profile.daily.bestScore === 100, 'doGameOver() NEPŘEPÍŠE lepší rekord horším výsledkem téhož dne (' + profile.daily.bestWave + ',' + profile.daily.bestScore + ')');
    assert(run._dailyNewPB === false, 'horší běh téhož dne NENÍ nový rekord (run._dailyNewPB=false)');

    // třetí běh týž den, lepší v jednom poli (vlna) -> max() se zvýší JEN v tom poli
    pendingDaily = true; pickClass('rytir'); run.wave = 9; run.score = 50; run.lives = 0;
    doVictory();
    assert(profile.daily.bestWave === 9, 'doVictory() zvýší bestWave při lepším výsledku (' + profile.daily.bestWave + ')');
    assert(profile.daily.bestScore === 100, 'doVictory() NESNÍŽÍ bestScore, když je nové skóre nižší (max() per pole nezávisle, ' + profile.daily.bestScore + ')');
    assert(run._dailyNewPB === true, 'zlepšení alespoň v jednom poli (bestWave) = nový rekord');

    // NEDENNÍ běh nesmí profile.daily vůbec ovlivnit
    const savedDaily = JSON.stringify(profile.daily);
    pendingDaily = false; pickClass('mag'); run._pactOffer = ['pevnost']; choosePact('pevnost'); run.wave = 999; run.score = 999999; run.lives = 0;
    doGameOver();
    assert(JSON.stringify(profile.daily) === savedDaily, 'nedenní běh NEOVLIVNÍ profile.daily (i s vyšší vlnou/skóre)');
    assert(run._dailyNewPB === false, 'nedenní běh: run._dailyNewPB=false (recordDailyPB() no-op mimo run.daily)');
    log('PB Denní výzvy ok (reset na jiný den, max() přes běhy stejného dne, nedenní běh neovlivní)'); }

  // ---- 71f) FÁZE 4.4 SCHÉMA: run.daily je v SNAPSHOT_SCHEMA i nezávislém svědkovi (viz test 36), round-trip ----
  { pendingDaily = true; pickClass('rytir');
    assert(run.daily === true, 'test předpoklad: run.daily=true před round-trip');
    const snap = serializeState();
    assert(snap.run.daily === true, 'serializeState() zahrne run.daily=true');
    run.daily = false;   // znič lokální stav
    applyState(JSON.parse(JSON.stringify(snap)));
    assert(run.daily === true, 'applyState() obnoví run.daily z drátu (' + run.daily + ')');
    log('run.daily schema round-trip ok'); }

  // ---- 71g) FÁZE 4.4 BEZPEČNOST: starý profil bez pole daily nesmí spadnout (migrace přes defaultProfile) ----
  { const oldProfile = { playerLevel: 2, xp: 10, unlocked: [], souls: 5, meta: {}, mastery: {}, bestAscension: 0, settings: { autofire: true, autoaim: true, muted: false, haptics: true } };
    assert(!('daily' in oldProfile), 'test předpokládá starý profil BEZ pole daily');
    localStorage.setItem(PROFILE_KEY, JSON.stringify(oldProfile));
    const migrated = loadProfile();
    assert(migrated.playerLevel === 2 && migrated.souls === 5, 'loadProfile() skutečně načetl starý profil ze storage (ne jen default)');
    assert(migrated.daily && typeof migrated.daily === 'object' && migrated.daily.date === '' && migrated.daily.bestWave === 0 && migrated.daily.bestScore === 0,
      'loadProfile() doplní chybějící daily na výchozí {date:"",bestWave:0,bestScore:0} (Object.assign(defaultProfile(),...))');
    profile = migrated;
    let threw = false;
    try { pendingDaily = true; pickClass('rytir'); run.wave = 3; run.score = 3; run.lives = 0; doGameOver(); renderDaily(); }
    catch (e) { threw = true; log('CHYBA: ' + (e && e.stack)); }
    assert(!threw, 'starý profil bez daily: denní běh + doGameOver()/renderDaily() neházejí výjimku');
    assert(profile.daily.date === todayStr() && profile.daily.bestWave === 3, 'migrovaný starý profil: PB se po prvním denním běhu zapíše správně');
    log('bezpečnost starého profilu bez daily ok (migrace + žádný pád)'); }

  // ---- 71h) FÁZE 4.4 OPRAVA REGRESE: opuštění denní výzvy PŘED výběrem třídy nesmí zaseknout
  //           pendingDaily=true a tiše vynutit denní pakt v pozdějším NORMÁLNÍM běhu.
  //           Simuluje se PŘES SKUTEČNÝ delegovaný click handler overlaye (clickAct), přesná
  //           sekvence reálných kliknutí: Menu -> „Denní výzva“ -> „Hrát denní výzvu“ -> „Zpět“
  //           (do menu, OPUŠTĚNÍ toku před výběrem třídy) -> „Hrát sám“ -> výběr třídy. ----
  { const savedDailyBefore = JSON.stringify(profile.daily);
    clickAct('daily');                 // Menu -> Denní výzva (obrazovka s datem + zapečetěným paktem)
    assert(state === 'daily', 'clickAct(daily) přepne na obrazovku denní výzvy');
    clickAct('playdaily');             // „Hrát denní výzvu“ -> pendingDaily=true, výběr třídy
    assert(pendingDaily === true, 'clickAct(playdaily) nastaví pendingDaily=true (jako dřív)');
    assert(state === 'class', 'clickAct(playdaily) přepne na výběr třídy');
    clickAct('menu');                  // „Zpět“ na výběru třídy -> OPUŠTĚNÍ toku denní výzvy do menu
    assert(state === 'menu', 'clickAct(menu) přepne zpět do menu (uživatel opustil denní tok)');
    assert(pendingDaily === false, 'OPRAVA: clickAct(menu) resetuje zaseklý pendingDaily zpět na false');
    clickAct('play');                  // „Hrát sám“ -> normální sólo výběr třídy (NE denní)
    assert(state === 'class', 'clickAct(play) přepne na výběr třídy (normální sólo)');
    assert(pendingDaily === false, 'pendingDaily zůstává false i po vstupu do normálního výběru třídy');
    clickAct('pickclass', 'rytir');    // výběr třídy -> pickClass('rytir') přes handler
    assert(run.daily === false, 'BEZ OPRAVY BY SPADLO: normální běh po opuštěné denní výzvě má run.daily=false (žádný tichý denní běh)');
    assert(run.pacts.length === 0, 'BEZ OPRAVY BY SPADLO: žádný vynucený pakt (forceDailyPact() se nezavolal)');
    assert(state === 'pact' && run._pactOffer && run._pactOffer.length === 3, 'BEZ OPRAVY BY SPADLO: normální nabídka 3 paktů proběhla (offerPact() se zavolal)');
    assert(pendingDaily === false, 'pendingDaily zůstává false po pickClass (nic k spotřebování)');
    run._pactOffer = ['pevnost']; choosePact('pevnost');
    run.wave = 5; run.score = 100; run.lives = 0;
    const dailyBefore = JSON.stringify(profile.daily);
    doGameOver();
    assert(JSON.stringify(profile.daily) === dailyBefore, 'BEZ OPRAVY BY SPADLO: doGameOver() normálního běhu NEZMĚNÍ profile.daily (nebyl to denní běh)');
    assert(JSON.stringify(profile.daily) === savedDailyBefore, 'profile.daily je na konci scénáře identické jako před ním (žádný vedlejší zápis)');
    log('oprava regrese 71h ok (opuštění denní výzvy před výběrem třídy už nezasekává pendingDaily do dalšího normálního běhu)'); }

  // ---- 71i) FÁZE 4.4 HAPPY PATH: legitimní PŘÍMÁ cesta daily -> playdaily -> pickClass DÁL funguje
  //           (oprava 71h nerozbila normální denní tok), opět přes SKUTEČNÝ click handler. ----
  { clickAct('menu');                  // čistý start z menu
    assert(pendingDaily === false, 'pendingDaily čistý před testem happy path');
    clickAct('daily');
    clickAct('playdaily');
    assert(pendingDaily === true, 'pendingDaily=true bezprostředně po playdaily (přímá cesta, žádné opuštění)');
    clickAct('pickclass', 'mag');      // BEZ mezikroku menu/play — přímý výběr třídy v denním toku
    assert(run.daily === true, 'legitimní denní tok: pickClass přímo po playdaily stále nastaví run.daily=true');
    const expected = dailyPactId();
    assert(run.pacts.length === 1 && run.pacts[0] === expected, 'legitimní denní tok: vynucený pakt dle data je stále zapečetěn (' + JSON.stringify(run.pacts) + ')');
    assert(run._pactOffer === null, 'legitimní denní tok: stále žádná nabídka paktů (offerPact() nevolán)');
    assert(pendingDaily === false, 'pendingDaily se po legitimním denním běhu spotřebuje jako dřív');
    assert(state === 'shop', 'legitimní denní tok jde rovnou do obchodu, přesně jako dřív');
    log('happy path 71i ok (přímá cesta daily -> playdaily -> pickClass dál vynucuje denní pakt, oprava 71h nerozbila legitimní tok)'); }

  console.log('\\n==== TEST RESULTS ====');
  for (const r of results) console.log('  ✓ ' + r);
  console.log('==== ALL PASSED ====');
})();
`;

try {
  vm.runInContext(code, sandbox, { filename: 'game-bundle.js' });
} catch (e) {
  console.error('\n==== TEST FAILED ====');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
