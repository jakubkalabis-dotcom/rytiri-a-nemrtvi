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
  const el = { style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, addEventListener: noop, removeEventListener: noop, appendChild: noop, removeChild: noop, setAttribute: noop, getContext: () => ctxProxy, querySelectorAll: () => [], querySelector: () => null, focus: noop, click: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 800 }), remove: noop };
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
