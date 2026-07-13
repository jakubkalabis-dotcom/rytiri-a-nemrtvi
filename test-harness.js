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
const ctxProxy = new Proxy({}, {
  get(t, k) {
    if (k === 'measureText') return () => ({ width: 4 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop: noop });
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
    // fire ability a few times across ticks
    for (let r = 0; r < 8; r++) { p.abilityCd = 0; if (cid==='knez') p.resurrectUsed=false; if (cid==='berserk'){p.hp=p.hpMax*0.4; p._clanActive=false; p.clanCd=0;} if (cid==='alchymista'){p.potions=1; p.abomT=0;} useAbility(p); tick(30); }
    log(cid + ' ability ok · warriors=' + warriors.length + ' enemies=' + enemies.length + ' particles=' + particles.length);
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
    for(let i=0;i<5;i++){ pickups.push({id:'zluc',x:p.x,y:p.y,t:900,bob:0,hold:0}); }
    tick(70); assert((p.potions||0)>=1,'5 biles made a potion (potions='+p.potions+')');
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
      startBuildPhase();          // triggers advanceToMap after wave 25
      assert(state==='build','build phase entered after wave '+run.wave);
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
