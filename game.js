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
// Gemy jsou per-hráč: kill/odměna dostanou VŠICHNI, každý utrácí své.
function meGems() { const p = localPlayer(); return p ? (p.gems || 0) : 0; }
function creditAll(n) { for (const q of players) q.gems = (q.gems || 0) + n; }
// Nejlepší pasiva napříč týmem (vyšší = lepší, např. warriorBuff)
function teamMax(key) { let m = 0; for (const p of players) { const v = (p.passive && p.passive[key]) || 0; if (v > m) m = v; } return m; }
// Nejlepší „rate" pasiva (nižší = rychlejší, např. emitterRate)
function teamRate(key) { let m = 1; for (const p of players) { const v = p.passive && p.passive[key]; if (v != null && v < m) m = v; } return m; }
// Aplikuj lokální vstup na vlastního hráče (host/solo). Guest vstup jen odesílá.
function applyLocalInput() {
  if (net.role === 'guest') return;
  const p = players[0]; if (!p) return;
  p.input.mx = myInput.mx; p.input.my = myInput.my; p.input.aiming = myInput.aiming;
  p.autoaim = profile.settings.autoaim; p.autofire = profile.settings.autofire;
  if (myInput.aiming) p.aimAngle = myInput.aimAngle;
}
let bullets = [], eBullets = [], groundFx = [], particles = [], effects = [];
let pickups = [], floaters = [], decals = [], netEvents = [];
let freezeTimer = 0, animClock = 0, hitStop = 0;
let lastTime = performance.now();
let shake = 0, flash = 0, banner = null;
let wave = null;      // stav probíhající vlny

const overlay = document.getElementById('overlay');
const ovContent = document.getElementById('ovContent');

/* ---------- Layout HUD ---------- */
const STICK_R = 50;
function inArena(y) { return y < VIEWH; }
const BTN = {
  weapon:   { x: 6,      y: VIEWH + 6,  w: 148, h: 34 },
  autoaim:  { x: 160,    y: VIEWH + 6,  w: 78,  h: 34 },
  autofire: { x: 242,    y: VIEWH + 6,  w: 78,  h: 34 },
  pause:    { x: W - 46, y: VIEWH + 6,  w: 40,  h: 34 },
  switch2:  { x: 6,      y: VIEWH + 44, w: 148, h: 36 },   // přepínač zbraní zpět
  ability:  { x: 160,    y: VIEWH + 44, w: 200, h: 40 },   // aktivní schopnost
  start:    { x: W - 132,y: VIEWH + 50, w: 126, h: 38 },   // start vlny (build)
  upgrade:  { x: W - 132,y: VIEWH + 8,  w: 126, h: 36 },   // režim vylepšování (build)
};
function inRect(px, py, r) { return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h; }

/* ---------- Nová hra / třída ---------- */
// classIds: string (solo) nebo pole tříd (co-op, index 0 = hostitel).
function newRun(classIds) {
  if (typeof classIds === 'string') classIds = [classIds];
  const first = CLASSES[classIds[0]];
  run = {
    classId: classIds[0], class: first,
    lives: 20,   // gemy jsou nově per-hráč (viz makePlayer)
    wave: 0,
    ownedWeapons: [],
    ammo: {},
    owned: {},          // stavební inventář: id -> počet
    upgrades: { hp: 0, dmg: 0, speed: 0, rate: 0, crit: 0, armor: 0 }, // statová vylepšení (sdílená)
    wUpgrades: {},      // vylepšení zbraní: weaponId -> úroveň
    wood: 0, steel: 0,  // materiály na vylepšování zbraní (sdílený pool)
    score: 0,
    shieldLvl: 0,       // vylepšení štítu rytíře (0..SHIELD_UP_MAX)
    turretKills: 0,     // zabití věžemi (plní „Kolečka se točí")
    wheelThreshold: 2,  // kolik zabití věží na další nabití koleček (zdvojnásobuje se)
    wheelReady: 0,      // nevyužité nabité „spiny" koleček
    wheelUpgrades: { dmg: 0, dur: 0, rate: 0, count: 0, hp: 0 },  // vylepšení polní věže
  };
  for (const k in AMMO) run.ammo[k] = 0;
  // sdílené vlastněné zbraně = sjednocení startovních zbraní hráčů
  for (const cid of classIds) for (const wid of CLASSES[cid].start) if (!run.ownedWeapons.includes(wid)) run.ownedWeapons.push(wid);
  for (const wid of run.ownedWeapons) grantAmmoFor(wid, 2);
  enemies = []; walls = []; turrets = []; traps = []; warriors = [];
  bullets = []; eBullets = []; groundFx = []; particles = []; effects = [];
  pickups = []; floaters = []; decals = []; netEvents = []; freezeTimer = 0;
  run.combo = 0; run.comboT = 0;
  loadMap(0);
  players.length = 0;
  const cx = (CORE.tx + CORE.w / 2) * TILE;
  classIds.forEach((cid, i) => {
    const p = makePlayer(CLASSES[cid], cid);
    p.x = cx + (i === 0 ? -20 : 20); p.y = (CORE.ty - 1) * TILE;
    players.push(p);
  });
  updateCamera(players[0].x, players[0].y, 1, true);
  readyHost = false; readyGuest = false;
}
function makePlayer(cls, classId) {
  const pas = cls.passive || {};
  const baseHp = Math.round(120 * cls.hpMod);
  const p = {
    classId, class: cls, color: cls.color, gems: cls.startGems,   // vlastní peněženka
    x: (CORE.tx + CORE.w / 2) * TILE, y: (CORE.ty - 1) * TILE, r: 12,
    baseHp, hpMax: baseHp, hp: baseHp,
    baseSpeed: 2.6 * cls.spdMod * (pas.moveSpeed || 1),
    weaponId: cls.start[0], cool: 0, aimAngle: -Math.PI / 2, inv: 0, downed: false,
    manaMax: Math.round(100 * (pas.manaMax || 1)), mana: Math.round(100 * (pas.manaMax || 1)),
    manaRegen: 0.11 * (pas.manaRegen || 1),
    abilityCd: 0, buffRapid: 0, buffPower: 0, shieldT: 0, rageT: 0, dashT: 0, walk: 0, atkAnim: 0,
    // stavy schopností (per-hráč): rytíř blok, zvěd neviditelnost/backstab, lovec smršt, abominace, kněz
    blockT: 0, invisT: 0, backstabArmed: false, flurryT: 0, abomT: 0, bonusHp: 0,
    bile: 0, potions: 0, resurrectUsed: false, clanCd: 0,
    autoaim: true, autofire: true,   // per-hráč (v co-opu má každý své)
    basePassive: pas,     // třídní passivy (neměnné) — perky se počítají navrch
    perks: {},            // trvalé buffy ze sub-bossů: id -> počet (do konce hry)
    perkOffer: null,      // aktuální nabídka buffů (po bossovi), pole id
    passive: pas,
    input: { mx: 0, my: 0, aiming: false },
  };
  recalcPerks(p);
  return p;
}
// Přepočte p.passive z třídních passiv + všech vlastněných perků. Volá se při zisku perku
// (a na guestovi po přijetí stavu). Deriv. násobiče (dmgMul, rateMul…) čtou call-sity dole.
function recalcPerks(p) {
  const base = p.basePassive || {};
  const pas = Object.assign({}, base);
  let dmgPct = 0, ratePct = 0, speedPct = 0, maxHpPct = 0, armorPct = 0, rangePct = 0, cdPct = 0,
      critAdd = 0, critMulAdd = 0, lifestealAdd = 0, dodgeAdd = 0, pickupRadiusAdd = 0,
      gemPct = 0, xpPct = 0, regenAdd = 0, thornsPct = 0, projAdd = 0, explodeChance = 0,
      freezeChance = 0, knockbackAdd = 0, ammoSaveChance = 0, manaRegenPct = 0;
  for (const id in (p.perks || {})) {
    const def = PERKS[id]; if (!def) continue; const n = p.perks[id];
    dmgPct += (def.dmgPct || 0) * n;           ratePct += (def.ratePct || 0) * n;
    speedPct += (def.speedPct || 0) * n;       maxHpPct += (def.maxHpPct || 0) * n;
    armorPct += (def.armorPct || 0) * n;       rangePct += (def.rangePct || 0) * n;
    cdPct += (def.cdPct || 0) * n;             critAdd += (def.critAdd || 0) * n;
    critMulAdd += (def.critMulAdd || 0) * n;   lifestealAdd += (def.lifestealAdd || 0) * n;
    dodgeAdd += (def.dodgeAdd || 0) * n;       pickupRadiusAdd += (def.pickupRadiusAdd || 0) * n;
    gemPct += (def.gemPct || 0) * n;           xpPct += (def.xpPct || 0) * n;
    regenAdd += (def.regenAdd || 0) * n;       thornsPct += (def.thornsPct || 0) * n;
    projAdd += (def.projAdd || 0) * n;         explodeChance += (def.explodeChance || 0) * n;
    freezeChance += (def.freezeChance || 0) * n; knockbackAdd += (def.knockbackAdd || 0) * n;
    ammoSaveChance += (def.ammoSaveChance || 0) * n; manaRegenPct += (def.manaRegenPct || 0) * n;
  }
  // přímé úpravy existujících passiv (čtou je stávající mechaniky):
  pas.crit = (base.crit || 0) + critAdd;
  pas.critMul = (base.critMul || 2) + critMulAdd;
  pas.lifesteal = (base.lifesteal || 0) + lifestealAdd;
  pas.dodge = (base.dodge || 0) + dodgeAdd;
  // nové deriv. násobiče/hodnoty (čtou je call-sity níže):
  pas.dmgMul = 1 + dmgPct;
  pas.rateMul = Math.max(0.35, 1 - ratePct);      // nižší prodleva = rychlejší palba
  pas.speedMul = 1 + speedPct;
  pas.armorMul = Math.max(0.3, 1 - armorPct);      // nižší obdržené poškození
  pas.rangeMul = 1 + rangePct;
  pas.cdMul = Math.max(0.4, 1 - cdPct);            // nižší cooldown schopnosti
  pas.pickupMul = 1 + pickupRadiusAdd;
  pas.gemMul = 1 + gemPct;
  pas.xpMul = 1 + xpPct;
  pas.regenAdd = regenAdd;                          // HP/s
  pas.thorns = thornsPct;
  pas.projAdd = projAdd;
  pas.explodeChance = explodeChance;
  pas.freezeChance = freezeChance;
  pas.knockbackAdd = knockbackAdd;
  pas.ammoSaveChance = ammoSaveChance;
  p.passive = pas;
  // odvozené staty: max HP (+maxHpPct navrch na statové vylepšení HP) a mana regen.
  // Na guestovi (bez p.baseHp) necháme autoritativní hpMax ze snímku beze změny.
  if (p.baseHp != null) {
    const oldMax = p.hpMax || p.baseHp;
    const upHp = (run && run.upgrades && run.upgrades.hp) || 0;
    p.hpMax = Math.round(p.baseHp * (1 + 0.12 * upHp) * (1 + maxHpPct) + (p.bonusHp || 0));
    const gained = p.hpMax - oldMax;
    if (gained > 0) p.hp = Math.min(p.hpMax, (p.hp || p.hpMax) + gained);  // nový max = plné doléčení přírůstku
    else if (p.hp > p.hpMax) p.hp = p.hpMax;
  }
  p.manaRegen = 0.11 * (base.manaRegen || 1) * (1 + manaRegenPct);
}
// Nabídka 3 buffů po zabití bosse (každý hráč si vybírá vlastní). Vzácnější (nižší cap) padají řidčeji.
function rollPerkOffer(p) {
  const avail = PERK_KEYS.filter(id => (p.perks[id] || 0) < PERKS[id].cap);
  if (!avail.length) return null;
  const pool = [];
  for (const id of avail) { const c = PERKS[id].cap; const w = c >= 4 ? 4 : (c === 3 ? 3 : (c === 2 ? 2 : 1)); for (let k = 0; k < w; k++) pool.push(id); }
  const offer = [];
  while (offer.length < 3 && pool.length) {
    const id = pool[(Math.random() * pool.length) | 0];
    if (!offer.includes(id)) offer.push(id);
    for (let i = pool.length - 1; i >= 0; i--) if (pool[i] === id) pool.splice(i, 1);
  }
  return offer.length ? offer : null;
}
function grantPerkOffer() { for (const p of players) if (!p.perkOffer) p.perkOffer = rollPerkOffer(p); }
function choosePerk(p, id) {
  if (!p || !p.perkOffer || p.perkOffer.indexOf(id) < 0) return;
  if ((p.perks[id] || 0) >= PERKS[id].cap) return;
  p.perks[id] = (p.perks[id] || 0) + 1;
  p.perkOffer = null;
  recalcPerks(p);
  sfx.levelUp();
  if (state === 'roundEnd') renderRoundEnd();
  if (typeof netPush === 'function' && net.role === 'host' && net.connected) netPush();
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
  if (s === 'menu' || s === 'class' || s === 'shop' || s === 'roundEnd' || s === 'gameOver' || s === 'victory' || s === 'host' || s === 'join' || s === 'wheel') {
    overlay.classList.remove('hidden');
  } else {
    overlay.classList.add('hidden');
  }
  if (s === 'wheel') renderWheelMenu();
  else if (s === 'menu') renderMenu();
  else if (s === 'class') renderClassSelect();
  else if (s === 'shop') renderShop();
  else if (s === 'roundEnd') renderRoundEnd();
  else if (s === 'gameOver') renderGameOver();
  else if (s === 'victory') renderVictory();
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

function shopCard(id, name, cost, cat, extra, act, disabled, costLabel) {
  return `<div class="card shop-card ${disabled ? 'dis' : ''}" ${disabled ? '' : `data-act="${act}" data-id="${id}"`}>
    <div class="scn">${name}</div>
    <div class="scd">${extra || ''}</div>
    <div class="scc">${disabled || costLabel || ('💎 ' + cost)}</div>
  </div>`;
}
let shopTab = 'weapons';
const SHOP_TABS = [['weapons', '🗡 Zbraně'], ['traps', '🪤 Pasti'], ['walls', '🧱 Zdi'], ['warriors', '🛡 Spojenci'], ['ammo', '🎯 Munice'], ['char', '🧙 Postava'], ['perks', '✨ Buffy'], ['bestiary', '📖 Bestiář']];
function refreshShop() { if (state === 'shop') renderShop(); lastShopSig = typeof shopSig === 'function' ? shopSig(run) : ''; }
function shopHeader() {
  return `<h2>Obchod · vlna ${run.wave + 1}</h2>
    <div class="wallet">💎 ${meGems()} &nbsp; 🪵 ${run.wood || 0} &nbsp; ⛓ ${run.steel || 0} &nbsp; ❤ ${run.lives}</div>
    <div class="tabs">${SHOP_TABS.map(t => `<button data-act="tab" data-id="${t[0]}" class="tab ${shopTab === t[0] ? 'on' : ''}">${t[1]}</button>`).join('')}</div>`;
}
function renderShop() {
  let btn = 'Dál → stavění ▶';
  if (isCoop()) {
    const meR = net.role === 'guest' ? readyGuest : readyHost, other = net.role === 'guest' ? readyHost : readyGuest;
    btn = (meR ? '✔ Připraven' : '▶ Připraven do stavění') + (meR ? ' · ' + (other ? 'druhý ✔' : 'čekání na druhého…') : '');
  }
  ovContent.innerHTML = shopHeader() + renderShopCat(shopTab) + `<button data-act="tobuild">${btn}</button>`;
  paintShopIcons();
}
function shopGrid(cards, empty) { return `<div class="grid">${cards || '<div class="empty">' + (empty || '—') + '</div>'}</div>`; }
// Krátký popis účinku pasti/věže do karty obchodu.
function trapInfo(t) {
  if (t.arch === 'ONESHOT') return `⚔ ${t.dmg}/zásah · trvalá`;
  if (t.arch === 'DOT_AOE') return `🔥 ${t.dps}/s v okolí`;
  if (t.arch === 'SLOW') return `🐌 −${Math.round((1 - t.slow.mul) * 100)}% rychlost`;
  if (t.arch === 'EMITTER') return `🏹 ${t.dmg} dmg · dosah ${Math.round(t.range / 24)}`;
  return '';
}
// Popis chování nepřítele pro bestiář.
function enemyDesc(id, e) {
  const parts = [];
  const A = { WALKER: 'Základní pomalý nemrtvý.', RUNNER: 'Rychlý, ale křehký — dožene hráče.',
    TANK: 'Spousta HP, velmi pomalý. Prokousává zdi.', RANGED: 'Plive kyselinu z dálky, drží si odstup.',
    EXPLODER: 'Při kontaktu vybuchne — plošné poškození!', BOSS: 'Boss.' };
  parts.push(A[e.arch] || '');
  if (e.armored) parts.push('Brnění: sníženému poškození odolává.');
  if (e.arch === 'BOSS') {
    if (e.summon) parts.push('Přivolává další nemrtvé (' + (ENEMIES[e.summon] ? ENEMIES[e.summon].name : e.summon) + ').');
    if (e.volley) parts.push('Střílí vějíř projektilů.');
    if (e.enrage) parts.push('V nízkém HP se rozzuří (zrychlí).');
    if (e.final) parts.push('Finální boss celé hry.');
  }
  return parts.filter(Boolean).join(' ');
}
function renderBestiaryCard(id) {
  const e = ENEMIES[id];
  const dps = e.atkRate ? (e.dmg / (e.atkRate / 60)).toFixed(0) : e.dmg;
  const spd = e.speed >= 1.5 ? 'rychlý' : e.speed >= 0.8 ? 'střední' : 'pomalý';
  return `<div class="bcard">
    <canvas class="ico benemy" width="40" height="40" data-k="enemy" data-id="${id}"></canvas>
    <div class="binfo">
      <div class="bname">${e.name}${e.arch === 'BOSS' ? ' <span class="bboss">BOSS</span>' : ''}</div>
      <div class="bstats">❤ ${e.hp} · ⚔ ${e.dmg} dmg · 🏃 ${spd} · 💎 ${e.bounty}</div>
      <div class="bdesc">${enemyDesc(id, e)}</div>
    </div></div>`;
}
function renderBestiary() {
  const normal = Object.keys(ENEMIES).filter(id => ENEMIES[id].arch !== 'BOSS');
  const bosses = Object.keys(ENEMIES).filter(id => ENEMIES[id].arch === 'BOSS');
  return `<div class="shop bestiary">
    <p style="font-size:12px;color:#9aa87e">Přehled nepřátel — jejich životy, poškození a schopnosti.</p>
    <h3>Nemrtví</h3>${normal.map(renderBestiaryCard).join('')}
    <h3>Bossové</h3>${bosses.map(renderBestiaryCard).join('')}</div>`;
}
function renderShopCat(tab) {
  if (tab === 'char') return renderCharTab();
  if (tab === 'perks') return renderPerksTab();
  if (tab === 'bestiary') return renderBestiary();
  if (tab === 'weapons') {
    const lvl = profile.playerLevel;
    const owned = run.ownedWeapons.map(id => { const w = WEAPONS[id], wl = run.wUpgrades[id] || 0, maxed = wl >= WEAPON_UP_MAX, c = weaponUpMat(wl), afford = (run.wood || 0) >= c.wood && (run.steel || 0) >= c.steel;
      return shopCard(id, `${ico('weapon', id)} ${w.name}`, 0, null, `Lv.${wl} · dmg ${Math.round(w.dmg * (1 + 0.1 * wl))}`, 'upweapon', maxed ? 'MAX' : (afford ? null : 'málo mat.'), maxed ? null : `⬆ 🪵${c.wood} ⛓${c.steel}`); }).join('');
    const buy = Object.keys(WEAPONS).filter(id => !run.ownedWeapons.includes(id) && WEAPONS[id].cost > 0).map(id => { const w = WEAPONS[id], locked = lvl < w.unlock, cost = costOf(w.cost, w.cat === 'melee' ? 'melee' : 'ranged');
      return shopCard(id, `${ico('weapon', id)} ${w.name}`, cost, null, `dmg ${w.dmg} · ${w.cat === 'melee' ? 'zblízka' : 'dálka'}`, 'buyweapon', locked ? `🔒 úroveň ${w.unlock}` : (meGems() < cost ? 'málo 💎' : null)); }).join('');
    return `<div class="shop">${owned ? '<h3>Vylepšit vlastní zbraně</h3>' + shopGrid(owned) : ''}<h3>Koupit nové zbraně</h3>${shopGrid(buy, 'Vše koupeno')}</div>`;
  }
  if (tab === 'traps') {
    const cards = Object.keys(TRAPS).map(id => { const t = TRAPS[id], cost = costOf(t.cost, 'trap'); return shopCard(id, `${ico('trap', id)} ${t.name}`, cost, 'trap', `${trapInfo(t)} · máš ${run.owned[id] || 0}`, 'buybuild', meGems() < cost ? 'málo 💎' : null); }).join('');
    return `<div class="shop"><p style="font-size:12px;color:#9aa87e">Vše postavené je trvalé <b>v rámci mapy</b> (nemizí mezi vlnami). Na <b>nové mapě</b> se ale všechny stavby resetují — postavíš je znovu (peníze i vylepšení zůstávají). <b>Věže</b> jsou průchozí (hráč přes ně projde, nezaseknou ho).</p><h3>Pasti a věže (${Object.keys(TRAPS).length})</h3>${shopGrid(cards)}</div>`;
  }
  if (tab === 'walls') {
    const cards = Object.keys(STRUCTURES).map(id => { const s = STRUCTURES[id], cost = costOf(s.cost, 'wall'); return shopCard(id, `${ico('wall', id)} ${s.name}`, cost, 'wall', `HP ${Math.round(s.hp * (teamMax('wallHp') || 1))} · máš ${run.owned[id] || 0}`, 'buybuild', meGems() < cost ? 'málo 💎' : null); }).join('');
    return `<div class="shop"><h3>Zdi a brány</h3>${shopGrid(cards)}</div>`;
  }
  if (tab === 'warriors') {
    const cards = Object.keys(WARRIORS).map(id => { const w = WARRIORS[id], cost = costOf(w.cost, 'warrior'); return shopCard(id, `${ico('warrior', id)} ${w.name}`, cost, 'warrior', `HP ${w.hp} · máš ${run.owned[id] || 0}`, 'buybuild', meGems() < cost ? 'málo 💎' : null); }).join('');
    return `<div class="shop"><h3>Váleční spojenci</h3>${shopGrid(cards)}</div>`;
  }
  // ammo + život
  const ammo = Object.keys(AMMO).map(id => { const a = AMMO[id], cost = costOf(a.cost, 'ammo'); return shopCard(id, `🎯 ${a.name}`, cost, 'ammo', `+${a.bundle} · máš ${run.ammo[id] || 0}`, 'buyammo', meGems() < cost ? 'málo 💎' : null); }).join('');
  const life = shopCard('life', '❤ Život brány (+5)', 40, 'ammo', `jádro: ${run.lives}`, 'buylife', meGems() < 40 ? 'málo 💎' : null);
  return `<div class="shop"><h3>Munice</h3>${shopGrid(ammo)}<h3>Život brány</h3>${shopGrid(life)}</div>`;
}
function abilityDetail(cid) {
  const shLvl = (run && run.shieldLvl) || 0;
  const wu = (run && run.wheelUpgrades) || {};
  return ({
    rytir: `🛡 Zvednout štít (cd 2 s): na ${(shieldBlockTime(shLvl) / 60).toFixed(2)} s vykryje VŠECHNY útoky i střely a odhodí nemrtvé o 10 px.${shLvl > 0 ? ' Odraz ' + Math.round(shieldReflect(shLvl) * 100) + ' % poškození zpět.' : ''} Štít úroveň ${shLvl}/${SHIELD_UP_MAX} (vylepši v obchodě).`,
    lovec: '🏹 Smršt (cd 35 s): na 5 s +70 % rychlost palby a NEKONEČNÁ munice. Žádné náboje/mana se nespotřebují.',
    berserk: `🪓 Volání klanu: přivolá 2 sekerníky (${CLAN_AXEMAN.hp} HP, ${CLAN_AXEMAN.dmg} poškození/úder). Jen při ≤ 50 % HP. Odejdou při smrti / HP > 65 % / konci kola. Poté cd 40 s.`,
    zved: '🗡 Bodnutí do zad (cd 10 s): 5 s neviditelnost (mobové tě ignorují). PRVNÍ útok = okamžité zabití běžného nepřítele, nebo 3× poškození zbraně na bosse. Zabiješ-li silnějšího, cd se resetuje.',
    mag: `☄ Armagedon (cd 12 s): meteor na nejbližší shluk — ${MAG_METEOR_DMG} poškození v okruhu ${MAG_METEOR_RADIUS} + ohnivá zem ${MAG_METEOR_DOT.dps}/s po 3 s. (× magický bonus).`,
    alchymista: `🧟 Abominace (lektvar z 5 žlučí, max 2): 10 s proměna — −50 % obdrž. poškození, −38 % rychlost, POŽÍRÁ pěšáky (+${ABOM_HP_PER_EAT} max HP navždy/kus) a leptá silnější ${ABOM_ACID_BURST} dmg/2,5 s + ${ABOM_ACID_DPS} dmg/s v okruhu ${ABOM_ACID_RADIUS}.`,
    inzenyr: `🔧 Polní věž (cd 8 s): ${1 + (wu.count || 0)}× samostříl (${(720 + (wu.dur || 0) * 180) / 60} s, ${Math.round(90 * (1 + 0.4 * (wu.hp || 0)))} HP, +${(wu.dmg || 0) * 20} % dmg, +${(wu.rate || 0) * 15} % rychlost) + opraví zdi. Zabíjením věžemi plníš „Kolečka se točí".`,
    knez: '✨ Vzkříšení (1× za kolo): oživí padlé v okruhu 220 na 60 % HP, živé vyléčí o 60 HP a spálí nemrtvé za 40 v okruhu 130.',
  })[cid] || 'Aktivní schopnost třídy.';
}
// Přehled trvalých buffů (padají ze sub-bossů) — vlastněné + celý katalog s čísly.
function renderPerksTab() {
  const p = localPlayer() || players[0];
  const owned = Object.keys(p.perks || {});
  const total = owned.reduce((a, id) => a + p.perks[id], 0);
  const ownedHtml = owned.length
    ? owned.map(id => `<div class="card"><div class="scn">${PERKS[id].icon} ${PERKS[id].name} ×${p.perks[id]}/${PERKS[id].cap}</div><div class="scd">${PERKS[id].desc}</div></div>`).join('')
    : '<p style="color:#9aa87e">Zatím žádné. Poraž sub-bosse (každá 5. vlna) a vyber si trvalý buff.</p>';
  const catalog = PERK_KEYS.map(id => { const d = PERKS[id], have = p.perks[id] || 0; return `<div class="card ${have >= d.cap ? '' : 'dis'}" style="opacity:${have ? 1 : 0.7}"><div class="scn">${d.icon} ${d.name} ${have ? '×' + have : ''}</div><div class="scd">${d.desc}</div><div class="scc" style="color:#9aa87e">max ${d.cap}×</div></div>`; }).join('');
  return `<div class="shop"><p style="font-size:12px;color:#9aa87e">Trvalé buffy platí <b>do konce hry</b> a sčítají se. Každý hráč má vlastní. Padají po zabití sub-bosse (každá 5. vlna) a mapového bosse (každá 25.).</p>
    <h3>Tvé buffy (${total})</h3><div class="grid">${ownedHtml}</div>
    <h3>Katalog buffů (${PERK_KEYS.length})</h3><div class="grid">${catalog}</div></div>`;
}
function renderCharTab() {
  const p = localPlayer() || players[0]; const up = run.upgrades; const w = WEAPONS[p.weaponId] || {};
  const ab = ABILITIES[p.classId] || {};
  const stat = (label, val) => `<div class="statrow"><span>${label}</span><b>${val}</b></div>`;
  const critPct = Math.round(((p.passive.crit || 0) + 0.04 * up.crit) * 100);
  const statBlock = `<div class="statbox">
      <div class="statname" style="color:${p.color}">${p.class.icon} ${p.class.name}</div>
      ${stat('❤ Život', p.hpMax)}
      ${stat('⚔ Poškození', '×' + (1 + 0.08 * up.dmg).toFixed(2) + (p.passive.meleeDmg ? ' (blíz +' + Math.round((p.passive.meleeDmg - 1) * 100) + '%)' : ''))}
      ${stat('👟 Rychlost', '×' + ((1 + 0.06 * up.speed) * p.class.spdMod).toFixed(2))}
      ${stat('⚡ Rychlost palby', '+' + Math.round(5 * up.rate + (p.passive.rangedRate ? (1 - p.passive.rangedRate) * 100 : 0)) + '%')}
      ${stat('✦ Kritika', critPct + '%')}
      ${stat('🛡 Pancíř', Math.round(5 * up.armor + (p.passive.block ? p.passive.block * 100 : 0)) + '%')}
      ${stat('🗡 Zbraň', w.name + ' (Lv.' + (run.wUpgrades[p.weaponId] || 0) + ')')}
    </div>
    <div class="statbox">
      <div class="statname" style="color:${p.color}">${ab.icon || '✨'} ${ab.name || 'Schopnost'} <span style="font-size:11px;color:#9aa87e">· cooldown ${Math.round((ab.cd || 600) / 60)}s · tlačítko 🔧/E</span></div>
      <div class="scd" style="font-size:12.5px;color:#c8d0b0;line-height:1.4">${abilityDetail(p.classId)}</div>
    </div>`;
  const upCards = Object.keys(UPGRADES).map(k => {
    const def = UPGRADES[k]; const lv = up[k] || 0; const maxed = lv >= UPGRADE_MAX; const cost = upgradeCost(def, lv);
    const bars = '▮'.repeat(lv) + '▯'.repeat(UPGRADE_MAX - lv);
    return `<div class="card up-card ${maxed || meGems() < cost ? 'dis' : ''}" ${maxed ? '' : `data-act="upstat" data-id="${k}"`}>
      <div class="scn" style="color:${def.color}">${def.icon} ${def.name}</div>
      <div class="scd">${def.unit}</div>
      <div class="upbar">${bars}</div>
      <div class="scc">${maxed ? 'MAX' : '💎 ' + cost}</div>
    </div>`;
  }).join('');
  // Rytíř: vylepšení štítu (delší blok + odraz)
  let shieldCard = '';
  if (players.some(q => q.classId === 'rytir')) {
    const lvl = run.shieldLvl || 0, maxed = lvl >= SHIELD_UP_MAX, cost = shieldUpCost(lvl);
    shieldCard = `<h3>🛡 Štít rytíře (Lv. ${lvl}/${SHIELD_UP_MAX})</h3><div class="grid">
      <div class="card ${maxed || meGems() < cost ? 'dis' : ''}" ${maxed ? '' : 'data-act="upshield"'}>
        <div class="scn" style="color:#8fd0ff">🛡 Vylepšit štít</div>
        <div class="scd">Blok ${(shieldBlockTime(lvl) / 60).toFixed(2)}s → ${(shieldBlockTime(lvl + (maxed ? 0 : 1)) / 60).toFixed(2)}s · odraz ${Math.round(shieldReflect(lvl) * 100)}% → ${Math.round(shieldReflect(lvl + (maxed ? 0 : 1)) * 100)}%</div>
        <div class="upbar">${'▮'.repeat(lvl) + '▯'.repeat(SHIELD_UP_MAX - lvl)}</div>
        <div class="scc">${maxed ? 'MAX' : '💎 ' + cost}</div>
      </div></div>`;
  }
  return `${statBlock}<h3>Vylepšit staty (Lv. max ${UPGRADE_MAX})</h3><div class="grid">${upCards}</div>${shieldCard}`;
}
function buyUpgrade(stat, p) {
  p = p || localPlayer(); const def = UPGRADES[stat]; if (!def) return;
  const lvl = run.upgrades[stat] || 0; if (lvl >= UPGRADE_MAX) return;
  const cost = upgradeCost(def, lvl); if (p.gems < cost) return;
  p.gems -= cost; run.upgrades[stat] = lvl + 1;
  if (stat === 'hp') for (const q of players) recalcPerks(q);   // přepočte hpMax (statové vylepšení + perky)
  sfx.buy(); refreshShop();
}
function buyShield(p) {
  p = p || localPlayer();
  const lvl = run.shieldLvl || 0; if (lvl >= SHIELD_UP_MAX) return;
  const cost = shieldUpCost(lvl); if (p.gems < cost) return;
  p.gems -= cost; run.shieldLvl = lvl + 1; sfx.buy(); refreshShop();
}
function buyWeaponUp(id, p) {
  p = p || localPlayer(); const w = WEAPONS[id]; if (!w || !run.ownedWeapons.includes(id)) return;
  const lvl = run.wUpgrades[id] || 0; if (lvl >= WEAPON_UP_MAX) return;
  const c = weaponUpMat(lvl);           // platí se DŘEVEM + OCELÍ (sdílený pool)
  if ((run.wood || 0) < c.wood || (run.steel || 0) < c.steel) return;
  run.wood -= c.wood; run.steel -= c.steel; run.wUpgrades[id] = lvl + 1; sfx.buy(); refreshShop();
}

function renderRoundEnd() {
  const r = (wave && wave.reward) || { gems: 0, kills: 0, xp: 0 };
  const mapEnd = isMapEndWave(run.wave);
  const subB = isSubBossWave(run.wave);
  const nextMap = mapForWave(run.wave + 1);
  const note = mapEnd
    ? `<p>🏆 <b>Mapa ${currentMap + 1} dokončena!</b> Další zastávka: <b>${MAPS[nextMap].name}</b> (mapa ${nextMap + 1}/${NUM_MAPS}). Na nové mapě si obranu (zdi, věže, pasti) postavíš znovu.</p>`
    : `<p>Jádro brány má ještě <b>${run.lives}</b> životů. Připrav se na vlnu <b>${run.wave + 1}</b> (${waveInMap(run.wave + 1)}/${WAVES_PER_MAP} na mapě).</p>`;
  const me = localPlayer();
  // Nabídka trvalého buffu (po bossovi). Dokud si hráč nevybere, nejde dál.
  let perkHtml = '';
  if (me && me.perkOffer && me.perkOffer.length) {
    const cards = me.perkOffer.map(id => {
      const d = PERKS[id], have = me.perks[id] || 0;
      return `<div class="card perk-card" data-act="perkpick" data-id="${id}" style="border-color:#c8a45c66">
        <div class="scn">${d.icon} ${d.name}</div>
        <div class="scd">${d.desc}</div>
        <div class="scc" style="color:#9aa87e">${have > 0 ? 'máš ' + have + '/' + d.cap : 'do konce hry'}</div>
      </div>`;
    }).join('');
    perkHtml = `<div class="perk-offer"><h3>☠ Trvalý buff za bosse — vyber si jeden</h3>
      <p style="font-size:12px;color:#9aa87e">Platí do konce hry a sčítá se s ostatními buffy. Každý hráč si vybírá vlastní.</p>
      <div class="grid">${cards}</div></div>`;
  }
  const ownedHtml = me && Object.keys(me.perks).length
    ? `<details class="perk-owned"><summary>Tvé buffy (${Object.values(me.perks).reduce((a, b) => a + b, 0)})</summary>
       <div class="perk-list">${Object.keys(me.perks).map(id => `<div>${PERKS[id].icon} ${PERKS[id].name} ×${me.perks[id]} — <span style="color:#9aa87e">${PERKS[id].desc}</span></div>`).join('')}</div></details>`
    : '';
  const gate = me && me.perkOffer && me.perkOffer.length;
  ovContent.innerHTML = `
    <h2>${mapEnd ? '🏆 Boss poražen!' : (subB ? '☠ Sub-boss padl!' : 'Vlna ' + run.wave + ' přežita!')}</h2>
    <div class="wallet">Zabito: <b>${r.kills}</b> · Získáno 💎 <b>${r.gems}</b> · XP <b>+${r.xp}</b></div>
    ${note}
    ${perkHtml}
    ${ownedHtml}
    ${gate ? '<button class="dis" disabled>Nejdřív si vyber buff ☝</button>' : '<button data-act="toshop">Do obchodu</button>'}`;
}
// „Kolečka se točí" — nabídka vylepšení Polní věže (pauza + overlay). Otevírá se po nabití.
let wheelReturn = 'combat';
function openWheelMenu() {
  if (state === 'wheel' || (run.wheelReady || 0) <= 0) return;
  if (net.role === 'guest') return;   // v co-opu řídí stav host
  wheelReturn = (state === 'wheel') ? wheelReturn : state;
  setState('wheel');
}
function renderWheelMenu() {
  const wu = run.wheelUpgrades || {};
  const cards = WHEEL_KEYS.map(k => {
    const d = WHEEL_UPGRADES[k], lv = wu[k] || 0, maxed = lv >= d.max;
    return `<div class="card ${maxed ? 'dis' : ''}" ${maxed ? '' : `data-act="wheelpick" data-id="${k}"`}>
      <div class="scn">${d.icon} ${d.name}</div>
      <div class="scd">${d.desc}</div>
      <div class="upbar">${'▮'.repeat(lv) + '▯'.repeat(d.max - lv)}</div>
      <div class="scc">${maxed ? 'MAX' : 'úroveň ' + lv + '/' + d.max}</div>
    </div>`;
  }).join('');
  ovContent.innerHTML = `<h2>⚙ Kolečka se točí</h2>
    <p>Zabíjením nepřátel věžemi jsi nabil vylepšení <b>Polní věže</b>. Zbývá spinů: <b>${run.wheelReady || 0}</b>. Vyber jedno vylepšení:</p>
    <div class="grid">${cards}</div>`;
}
function chooseWheel(key) {
  const d = WHEEL_UPGRADES[key]; if (!d) return;
  const lv = run.wheelUpgrades[key] || 0; if (lv >= d.max) return;
  run.wheelUpgrades[key] = lv + 1;
  run.wheelReady = Math.max(0, (run.wheelReady || 0) - 1);
  sfx.buy();
  if ((run.wheelReady || 0) > 0) renderWheelMenu();
  else { setState(wheelReturn || 'combat'); if (typeof performance !== 'undefined') lastTime = performance.now(); }
}
function scoreBoardHtml() {
  return loadScores().map((r, i) => `<div class="row"><span class="rank">${i + 1}.</span><span class="nm">${escapeHtml(r.name)}</span><span class="sc">vlna ${r.wave} · ${r.score}</span></div>`).join('') || '<div class="empty">—</div>';
}
function renderGameOver() {
  const score = run ? run.score || 0 : 0;
  ovContent.innerHTML = `
    <h2>Brána padla</h2>
    <div class="wallet">Mapa <b>${currentMap + 1}/${NUM_MAPS}</b> · vlna <b>${run.wave}</b> · Skóre: <b>${score}</b></div>
    <div class="board"><h3>NEJLEPŠÍ SKÓRE</h3>${scoreBoardHtml()}</div>
    <button data-act="menu">Zpět do menu</button>`;
}
function renderVictory() {
  const score = run ? run.score || 0 : 0;
  ovContent.innerHTML = `
    <h2>👑 ZVÍTĚZIL JSI! 👑</h2>
    <p>Prošel jsi všech <b>${NUM_MAPS}</b> map a v pekle jsi porazil <b>Pekelného pána</b>!
    Nemrtví jsou zahnáni a brána stojí.</p>
    <div class="wallet">Finální skóre: <b>${score}</b> · třída ${players.map(p => p.class.name).join(' + ')}</div>
    <div class="board"><h3>NEJLEPŠÍ SKÓRE</h3>${scoreBoardHtml()}</div>
    <button data-act="menu">Do menu</button>`;
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
  if (act === 'joinconnect') { if (typeof netJoinConnect === 'function') netJoinConnect(); return; }
  if (act === 'pickclass') { pickClass(id); return; }
  if (act === 'tab') { shopTab = id; renderShop(); return; }   // lokální přepnutí záložky
  if (act === 'tobuild') { shopReady(); return; }              // ready-gate obchodu (co-op)
  // --- guest: ekonomika a tok = příkazy hostiteli ---
  if (net.role === 'guest') {
    if (['buyweapon', 'buyammo', 'buybuild', 'buylife', 'upstat', 'upweapon', 'toshop', 'perkpick', 'upshield', 'wheelpick'].includes(act)) { netSend({ t: 'cmd', act, id }); if (act === 'perkpick') { const g = players[1]; if (g && g.perkOffer) { g.perkOffer = null; renderRoundEnd(); } } return; }
    return;
  }
  // --- host / solo ---
  const me = localPlayer();
  if (act === 'perkpick') { choosePerk(me, id); return; }
  if (act === 'wheelpick') { chooseWheel(id); return; }
  if (act === 'upshield') { buyShield(me); return; }
  if (act === 'buyweapon') buyWeapon(id, me);
  else if (act === 'buyammo') buyAmmo(id, me);
  else if (act === 'buybuild') buyBuild(id, me);
  else if (act === 'upstat') buyUpgrade(id, me);
  else if (act === 'upweapon') buyWeaponUp(id, me);
  else if (act === 'buylife') buyLife(me);
  else if (act === 'toshop') { setState('shop'); }
});
function buyLife(p) { p = p || localPlayer(); if (p.gems >= 40) { p.gems -= 40; run.lives += 5; sfx.buy(); refreshShop(); } }
// Ready-gate v obchodě: do stavění se jde, až jsou připraveni všichni.
function shopReady() {
  if (!isCoop()) { startBuildPhase(); return; }
  if (net.role === 'guest') { readyGuest = !readyGuest; netSend({ t: 'cmd', act: readyGuest ? 'sready' : 'sunready' }); renderShop(); return; }
  readyHost = !readyHost;
  if (readyHost && readyGuest) startBuildPhase();   // startBuildPhase resetuje ready flagy
  else renderShop();
}

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

function buyWeapon(id, p) {
  p = p || localPlayer(); const w = WEAPONS[id];
  if (profile.playerLevel < w.unlock) return;
  const cost = costOf(w.cost, w.cat === 'melee' ? 'melee' : 'ranged');
  if (p.gems < cost || run.ownedWeapons.includes(id)) return;
  p.gems -= cost; run.ownedWeapons.push(id); grantAmmoFor(id, 2);
  sfx.buy(); refreshShop();
}
function buyAmmo(id, p) {
  p = p || localPlayer(); const cost = costOf(AMMO[id].cost, 'ammo');
  if (p.gems < cost) return;
  p.gems -= cost; run.ammo[id] += AMMO[id].bundle; sfx.buy(); refreshShop();
}
function buyBuild(id, p) {
  p = p || localPlayer(); const def = TRAPS[id] || STRUCTURES[id] || WARRIORS[id];
  const cost = costOf(def.cost, def.cat);
  if (p.gems < cost) return;
  p.gems -= cost; run.owned[id] = (run.owned[id] || 0) + 1; sfx.buy(); refreshShop();
}

/* ============================================================================
   FÁZE STAVĚNÍ
   ========================================================================== */
let buildSel = null;   // vybraná položka z palety
function startBuildPhase() {
  // postup na další mapu po dokončení bossovské (map-end) vlny
  let mapChanged = false;
  if (run.wave > 0 && isMapEndWave(run.wave) && run.wave < FINAL_WAVE) {
    const nextMap = mapForWave(run.wave + 1);
    if (nextMap !== currentMap) { advanceToMap(nextMap); mapChanged = true; }
  }
  // vyléčit a oživit hráče na začátku přípravy
  for (const p of players) { p.hp = p.hpMax; p.downed = false; p.inv = 0; }
  buildSel = null; upgradeMode = false;
  readyHost = false; readyGuest = false;
  setState('build');
  // po přechodu na novou mapu nech viditelné oznámení mapy (setState('build') jinak přepíše banner)
  if (mapChanged) banner = { text: '🗺 MAPA ' + (currentMap + 1) + '/' + NUM_MAPS + ': ' + MAPS[currentMap].name + ' — postav obranu znovu', t: 180 };
  const me = localPlayer(); if (me) updateCamera(me.x, me.y, 1, true);   // kamera k jádru
}
function advanceToMap(i) {
  // NOVÁ MAPA = čerstvá obrana: zdi, věže, pasti i spojenci se NEPŘENÁŠEJÍ — hráč staví znovu.
  // Ekonomika, vylepšení, zbraně a munice (objekt `run`) zůstávají.
  loadMap(i);
  enemies = []; bullets = []; eBullets = []; groundFx = []; pickups = []; decals = []; particles = [];
  walls = []; turrets = []; traps = []; warriors = [];
  flowDirty = true;
  const cx = (CORE.tx + CORE.w / 2) * TILE;
  players.forEach((p, idx) => { p.x = cx + (idx === 0 ? -20 : 20); p.y = (CORE.ty - 1) * TILE; });
  if (players[0]) updateCamera(players[0].x, players[0].y, 1, true);
  banner = { text: '🗺 MAPA ' + (i + 1) + '/' + NUM_MAPS + ': ' + MAPS[i].name, t: 150 };
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
  const blocking = STRUCTURES[buildSel] || (TRAPS[buildSel] && TRAPS[buildSel].arch === 'EMITTER');
  // nestav ZEĎ na dlaždici, kde stojí hráč (zasekl by se); věže jsou průchozí, ty tam vadit nemůžou
  if (STRUCTURES[buildSel] && players.some(p => !p.downed && Math.floor(p.x / TILE) === tx && Math.floor(p.y / TILE) === ty)) { banner = { text: 'STOJÍ TAM HRÁČ!', t: 50, warn: true }; return; }
  if (blocking) {
    // stavba na mřížce — nesmí být obsazená; jen ZEĎ (průchozí věž ne) může zapečetit jádro
    if (grid.structures[i] !== null) return;
    if (STRUCTURES[buildSel] && !pathExistsWith(tx, ty)) { banner = { text: 'ZAPEČETILO BY JÁDRO!', t: 60, warn: true }; return; }
    const hp = Math.round(def.hp * (STRUCTURES[buildSel] ? (teamMax('wallHp') || 1) : 1));
    const obj = { def, defId: buildSel, tx, ty, x, y, r: 15, hp, hpMax: hp, wallCool: 0, fireCool: 0, flash: 0 };
    grid.structures[i] = obj;
    (STRUCTURES[buildSel] ? walls : turrets).push(obj);
    flowDirty = true;
  } else if (TRAPS[buildSel]) {
    // pozemní past (neblokuje)
    if (traps.some(t => t.tx === tx && t.ty === ty)) return;
    traps.push({ def, defId: buildSel, tx, ty, x, y, hp: def.hp || 0, dur: def.dur || Infinity, cool: 0, hitCd: 0 });
  } else if (WARRIORS[buildSel]) {
    if (warriors.length >= MAX_WARRIORS) { banner = { text: 'LIMIT SPOJENCŮ (' + MAX_WARRIORS + ')!', t: 60, warn: true }; return; }
    warriors.push({ def, defId: buildSel, x, y, r: 12, hp: def.hp, hpMax: def.hp, homeX: x, homeY: y, cool: 0, aim: 0, flash: 0 });
  }
  run.owned[buildSel]--;
  if (run.owned[buildSel] <= 0) buildSel = null;
  sfx.place();
  if (navigator.vibrate && profile.settings.haptics) navigator.vibrate(15);
}
function sellAt(tx, ty, seller) {
  seller = seller || localPlayer();
  const i = tileIndex(tx, ty);
  // struktura/věž
  const s = grid.structures[i];
  if (s) {
    grid.structures[i] = null;
    walls = walls.filter(w => w !== s); turrets = turrets.filter(w => w !== s);
    refund(s.defId, seller); flowDirty = true; return true;
  }
  const ti = traps.findIndex(t => t.tx === tx && t.ty === ty);
  if (ti >= 0) { refund(traps[ti].defId, seller); traps.splice(ti, 1); return true; }
  const wi = warriors.findIndex(w => Math.floor(w.x / TILE) === tx && Math.floor(w.y / TILE) === ty);
  if (wi >= 0) { refund(warriors[wi].defId, seller); warriors.splice(wi, 1); return true; }
  return false;
}
function refund(id, seller) {
  const def = defOf(id);
  (seller || localPlayer()).gems += Math.round(costOf(def.cost, def.cat) * 0.5);
  sfx.buy();
}

/* ============================================================================
   VLNY
   ========================================================================== */
function startWave() {
  run.wave++;
  const wv = run.wave;
  // konec předchozího kola: sekerníci klanu odejdou, schopnosti se resetují na kolo
  warriors = warriors.filter(w => !w.clanOwner);
  for (const p of players) {
    if (p._clanActive) { p._clanActive = false; p.clanCd = CLAN_COOLDOWN; }
    p.resurrectUsed = false;                       // vzkříšení: 1× za kolo
    p.blockT = 0; p.invisT = 0; p.backstabArmed = false; p.flurryT = 0;
    if (p.abomT > 0) { p.abomT = 0; p.r = p._preAbomR || 12; }   // ukončí proměnu
  }
  const mapBoss = isMapEndWave(wv);          // konec mapy = velký boss (každá 25.)
  const subBoss = isSubBossWave(wv);         // mini-boss (každá 5. mimo 25.)
  const boss = mapBoss || subBoss;
  const horde = !boss && isHordeWave(wv);
  const queue = [];
  let bossId = null;
  if (boss) {
    bossId = mapBoss ? mapBossForWave(wv) : subBossForWave(wv);
    queue.push(bossId);
    const comp = waveComposition(wv);
    const escort = mapBoss ? (8 + Math.floor(wv / 25)) : (4 + mapForWave(wv));   // doprovod bosse
    for (let k = 0; k < escort; k++) queue.push(pickWeighted(comp));
  } else {
    const comp = horde ? hordeComposition(wv) : waveComposition(wv);
    for (let k = 0, n = waveCount(wv); k < n; k++) queue.push(pickWeighted(comp));
  }
  wave = { queue, spawned: 0, total: queue.length, spawnCool: 20, boss, mapBoss, subBoss, horde,
           bossKind: mapBoss ? 'map' : (subBoss ? 'sub' : null), bossId,
           interval: horde ? 8 : null, kills: 0, reward: { gems: 0, kills: 0, xp: 0 } };
  flowDirty = true;
  setState('combat');
  banner = mapBoss ? { text: '⚠ BOSS: ' + ENEMIES[bossId].name.toUpperCase() + ' ⚠', t: 120, warn: true }
    : (subBoss ? { text: '☠ SUB-BOSS: ' + ENEMIES[bossId].name.toUpperCase(), t: 110, warn: true }
    : (horde ? { text: '🧟 HORDA! VLNA ' + wv, t: 120, warn: true } : { text: 'VLNA ' + wv, t: 110 }));
  if (boss) sfx.boss(); else if (horde) { sfx.groan(); sfx.waveStart(); } else sfx.waveStart();
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
  const mapIdx = mapForWave(run.wave);
  // Škálování: mapoví bossové rostou podle pořadí mapy; sub-bossové mírněji; běžní přes enemyScale.
  let hpMul, spdMul;
  if (base.arch === 'BOSS' && base.sub)      { hpMul = 1 + 0.26 * mapIdx; spdMul = 1; }
  else if (base.arch === 'BOSS')             { hpMul = base.final ? 1 : Math.min(3.2, 1 + 0.16 * mapIdx); spdMul = 1; }
  else                                        { hpMul = sc.hp; spdMul = sc.spd; }
  let dmgMul = base.arch === 'BOSS' ? Math.min(3, 1 + 0.12 * mapIdx) : sc.dmg;
  // elitní přídomek (jen běžní nepřátelé)
  let elite = null;
  if (base.arch !== 'BOSS' && Math.random() < eliteChance(run.wave)) {
    elite = ELITE_KEYS[(Math.random() * ELITE_KEYS.length) | 0];
    const ed = ELITES[elite]; hpMul *= ed.hpMul; spdMul *= ed.spdMul; dmgMul *= ed.dmgMul;
  }
  const hp = Math.round(base.hp * hpMul);
  const e = {
    typeId, arch: base.arch, def: base,
    x: s.x, y: s.y, r: base.size / 2, spawnT: 22,
    hp, hpMax: hp,
    speed: base.speed * spdMul,
    dmg: base.dmg * dmgMul,
    atkRate: base.atkRate, atkCool: 0, fireCool: 60, wallCool: 0,
    color: base.color, flash: 0, elite,
    slowMul: 1, slowTimer: 0, dotDps: 0, dotTimer: 0,
    summonCool: base.summonRate || 0,
  };
  enemies.push(e);
  emitEv({ k: 'spawn', x: e.x, y: e.y });
}
// Ephemerální událost pro guesta (kosmetika: exploze, sfx). Host je posílá dál.
function emitEv(ev) { if (net.role === 'host') netEvents.push(ev); }

/* ============================================================================
   BOJ — zbraně
   ========================================================================== */
function activeWeapon(p) { return WEAPONS[p.weaponId]; }
function rateMod(p, w) {
  let m = 1;
  if (w.cat === 'ranged' && p.passive.rangedRate) m = p.passive.rangedRate;
  m *= (p.passive.rateMul || 1);   // perky: rychlejší palba
  if (p.flurryT > 0) m *= 1 / 1.7; // lovec: smršt +70 % rychlost palby
  if (p.buffRapid > 0) m *= 0.5;   // drop „Rychlopalba"
  if (p.rageT > 0) m *= 0.6;       // berserk zuřivost
  const up = (run && run.upgrades) || {};
  m *= Math.max(0.45, 1 - 0.05 * (up.rate || 0));                       // stat Zručnost
  m *= Math.max(0.5, 1 - 0.03 * ((run.wUpgrades && run.wUpgrades[p.weaponId]) || 0)); // vylepšení zbraně
  return m;
}
function rangeMod(p, w) {
  let m = (p.passive.rangeMul || 1);   // perky: +% dosah
  if (w.cat === 'ranged' && p.passive.rangedRange) m *= p.passive.rangedRange;
  return m;
}
// Vrací {dmg, crit}
function weaponDmg(p, w) {
  let d = w.dmg;
  const pas = p.passive;
  if (w.cat === 'melee') d *= (pas.meleeDmg || 1);
  if (w.ammo === 'mana') d *= (pas.magicDmg || 1);
  if (w.arch === 'THROWN_AOE') d *= (pas.aoeDmg || 1);
  d *= (pas.holyDmg || 1);
  d *= (pas.dmgMul || 1);                                             // perky: +% poškození
  const up = (run && run.upgrades) || {};
  d *= 1 + 0.08 * (up.dmg || 0);                                      // stat Síla
  d *= 1 + 0.10 * ((run.wUpgrades && run.wUpgrades[p.weaponId]) || 0); // vylepšení zbraně
  if (p.buffPower > 0) d *= 1.5;   // drop „Síla"
  if (p.rageT > 0) d *= 1.8;       // berserk zuřivost
  if (pas.berserk) d *= 1 + 0.4 * (1 - p.hp / p.hpMax);
  let crit = false;
  const critCh = (pas.crit || 0) + 0.04 * (up.crit || 0);            // stat Přesnost
  if (critCh > 0 && Math.random() < critCh) { d *= (pas.critMul || 2); crit = true; }
  p._lastCrit = crit;
  return d;
}
function consumeAmmo(p, w) {
  if (p.flurryT > 0) return true;   // lovec: smršt = nekonečná munice (i mana)
  if (w.ammo === 'melee') return true;
  if (w.ammo === 'mana') { if (p.mana < w.ammoPerShot) return false; p.mana -= w.ammoPerShot; return true; }
  const need = w.ammoPerShot || 1;
  if ((run.ammo[w.ammo] || 0) < need) return false;
  if (p.passive.ammoSaveChance && Math.random() < p.passive.ammoSaveChance) return true;  // perk: nespotřebuje munici
  run.ammo[w.ammo] -= need; return true;
}
function fireWeapon(p, w, aim) {
  if (!consumeAmmo(p, w)) return false;
  const range = w.range * rangeMod(p, w);
  const dmg = weaponDmg(p, w);
  const extra = (w.cat === 'ranged' && w.arch !== 'THROWN_AOE') ? (p.passive.projAdd || 0) : 0;  // perk: navíc projektily
  if (w.arch === 'MELEE_SWING') {
    meleeSwing(p, w, aim, range, dmg); sfx.swing();
  } else if (w.arch === 'PROJECTILE') {
    spawnBullet(p, w, aim, range, dmg);
    for (let i = 1; i <= extra; i++) spawnBullet(p, w, aim + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.12, range, dmg);
    rangedSound(w);
  } else if (w.arch === 'MULTISHOT') {
    const n = (w.shots || 3) + extra;
    for (let i = 0; i < n; i++) {
      const a = aim + (i - (n - 1) / 2) * (w.spread || 0.3);
      spawnBullet(p, w, a, range, dmg);
    }
    rangedSound(w);
  } else if (w.arch === 'HITSCAN') {
    hitscan(p, w, aim, range, dmg);
    for (let i = 1; i <= extra; i++) hitscan(p, w, aim + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.12, range, dmg);
    rangedSound(w);
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
    const kb = (w.knockback || 0) + (p.passive.knockbackAdd || 0);   // perk: +odhoz
    if (kb) { e.x += Math.cos(aim) * kb; e.y += Math.sin(aim) * kb; }
    hitAny = true;
  }
  if (hitAny && p.passive.lifesteal) p.hp = Math.min(p.hpMax, p.hp + dmg * p.passive.lifesteal);
}
function spawnBullet(p, w, aim, range, dmg) {
  bullets.push({
    x: p.x + Math.cos(aim) * p.r, y: p.y + Math.sin(aim) * p.r,
    vx: Math.cos(aim) * w.projSpeed, vy: Math.sin(aim) * w.projSpeed,
    r: 4, dmg, pierce: w.pierce || 0, range, traveled: 0, ang: aim,
    dot: w.dot, slow: w.slow, knockback: w.knockback || 0, magic: w.ammo === 'mana',
    color: w.color, hitIds: [], owner: p, crit: p ? p._lastCrit : false,
  });
  effects.push({ type: 'muzzle', x: p.x + Math.cos(aim) * p.r, y: p.y + Math.sin(aim) * p.r, a: aim, t: 4, color: w.color });
}
function spawnThrown(p, w, aim, range, dmg) {
  const rad = (w.aoeRadius || 50) * (p.passive.aoeRadius || 1);
  bullets.push({
    x: p.x + Math.cos(aim) * p.r, y: p.y + Math.sin(aim) * p.r,
    vx: Math.cos(aim) * w.projSpeed, vy: Math.sin(aim) * w.projSpeed,
    r: 6, dmg, pierce: 0, range, traveled: 0, thrown: true, aoeRadius: rad, spin: 0,
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

function damageEnemy(e, dmg, w, p, crit) {
  // zvěd: bodnutí do zad — první útok v neviditelnosti
  let backstab = false;
  if (p && p.classId === 'zved' && p.backstabArmed && p.invisT > 0 && w) {
    p.backstabArmed = false; p.invisT = 0; backstab = true;   // útok prozradí
    const strong = e.arch === 'BOSS' || e.arch === 'TANK';
    if (e.arch === 'BOSS') dmg *= 3;                          // boss: 3× poškození zbraně
    else { dmg = e.hp + 9999; }                               // běžný nepřítel: okamžité zabití
    effects.push({ type: 'text', x: e.x, y: e.y - e.r, txt: strong ? 'KRITICKÉ!' : 'FATÁLNÍ!', t: 34, color: '#ffd35c' });
    e._backstabStrong = strong;
  }
  // pancéřovaní pohltí část poškození
  if (e.def.armored || (e.elite === 'pancerovany')) dmg *= 0.7;
  e.hp -= dmg;
  e.flash = 5;
  if (crit == null && p) crit = p._lastCrit;
  if (w && w.dot) { e.dotDps = Math.max(e.dotDps, w.dot.dps * ((p && p.passive.dotDmg) || 1)); e.dotTimer = w.dot.dur; }
  if (w && w.slow) { e.slowMul = w.slow.mul; e.slowTimer = w.slow.dur; }
  // perk: mrazivé zásahy — šance zpomalit zasaženého
  if (p && p.passive.freezeChance && Math.random() < p.passive.freezeChance) { e.slowMul = Math.min(e.slowMul || 1, 0.4); e.slowTimer = Math.max(e.slowTimer || 0, 120); }
  spawnFloater(e.x, e.y - e.r, Math.round(dmg), crit);
  burst(e.x, e.y, '#ffd0d0', crit ? 6 : 3);
  emitEv({ k: 'hit', x: e.x, y: e.y - e.r, d: Math.round(dmg), c: crit ? 1 : 0 });
  sfx.hitFlesh();
  if (e.hp <= 0) {
    // zvěd: zabití silnějšího nepřítele schopností resetuje cooldown
    if (backstab && e._backstabStrong && p) p.abilityCd = 0;
    if (w && w.fromTurret) registerTurretKill();   // inženýr: plnění koleček
    killEnemy(e, p);
  }
  else if (crit) hitStop = Math.max(hitStop, 2);
}
// Inženýr: zabíjením věžemi se plní „Kolečka se točí". Práh startuje na 2 a zdvojnásobuje se.
function registerTurretKill() {
  if (!run || !players.some(pl => pl.classId === 'inzenyr')) return;
  run.turretKills = (run.turretKills || 0) + 1;
  if (run.turretKills >= (run.wheelThreshold || 2)) {
    run.turretKills = 0;
    run.wheelThreshold = (run.wheelThreshold || 2) * 2;
    run.wheelReady = (run.wheelReady || 0) + 1;
    sfx.levelUp();
    openWheelMenu();
  }
}
function killEnemy(e, killer) {
  if (e.dead) return;
  e.dead = true;
  // combo → násobič skóre a gemů
  run.combo = (run.combo || 0) + 1; run.comboT = 180;
  const mult = comboMult();
  const gems = Math.max(1, Math.round((e.def.bounty || 4) * GEMS_PER_KILL_MUL * mult * (e.elite ? 3 : 1)));
  for (const q of players) q.gems = (q.gems || 0) + Math.max(1, Math.round(gems * (q.passive.gemMul || 1)));  // perk: +% gemů (per hráč)
  run.score = (run.score || 0) + Math.round((e.def.score || 10) * mult * (e.elite ? 3 : 1));
  if (wave) { wave.kills++; wave.reward.kills++; }
  addXp(xpForKill(e.def) * (e.elite ? 3 : 1) * ((killer && killer.passive && killer.passive.xpMul) || 1));  // perk: +% XP
  // perk: výbušné zabití — šance na výbuch v okolí
  if (killer && killer.passive && killer.passive.explodeChance && Math.random() < killer.passive.explodeChance)
    aoeExplosion(e.x, e.y, 55, 20, null, '#ffb020');
  // BOSS (sub i mapový) → nabídka trvalého buffu všem hráčům
  if (e.def.arch === 'BOSS') grantPerkOffer();
  const big = e.arch === 'TANK' || e.arch === 'BOSS';
  const style = e.arch === 'BOSS' ? 2 : (Math.random() * 5) | 0;
  zombieDeath(e.x, e.y, e.color, big, style);
  emitEv({ k: 'die', x: e.x, y: e.y, color: e.color, big: big ? 1 : 0, s: style });
  shake = Math.min(9, shake + (e.arch === 'BOSS' ? 9 : e.arch === 'TANK' ? 3 : 1.2));
  if (e.arch === 'BOSS') hitStop = 6;
  // elita „zhoubný" vybuchne, elita jindy → zaručený drop
  if (e.elite === 'zhoubny' || e.def.arch === 'EXPLODER' && false) aoeExplosion(e.x, e.y, 60, e.dmg, null, '#c060ff');
  if (e.elite) dropPickup(e.x, e.y, true);
  else if (Math.random() < 0.09) dropPickup(e.x, e.y, false);
  // alchymista: z běžné zombie může vytéct žluč (na lektvar proměny)
  if (e.arch !== 'BOSS' && players.some(q => q.classId === 'alchymista') && Math.random() < BILE_DROP_CHANCE)
    pickups.push({ id: 'zluc', x: e.x, y: e.y, t: 900, bob: Math.random() * 6, hold: 0 });
}
// Násobič combo: 1× → až ~3× při dlouhé sérii
function comboMult() { return 1 + Math.min(2, (run.combo || 0) * 0.05); }
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
// Nepřátelé cílí jen ŽIVÉ hráče; když jsou všichni padlí, vrací null → jdou k jádru.
function nearestPlayer(x, y) {
  let best = null, bd = Infinity;
  for (const p of players) { if (p.downed || p.invisT > 0) continue; const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < bd) { bd = d; best = p; } }
  return best;
}

/* ============================================================================
   EFEKTY / ČÁSTICE
   ========================================================================== */
// 5 stylů smrti zombie: krev / rozseknutí / výbuch vnitřností / kosti / rozklad
function zombieDeath(x, y, color, big, style) {
  const n = big ? 1.9 : 1;
  spawnDecal(x, y, big ? 22 : 12);
  const P = (vx, vy, life, decay, size, col, grav) => particles.push({ x, y, vx, vy, life, decay, size, color: col, grav });
  if (style === 0) {           // KREV
    for (let i = 0; i < 18 * n; i++) { const a = Math.random() * Math.PI * 2, s = Math.random() * 4 + 1; P(Math.cos(a) * s, Math.sin(a) * s, 1, 0.03 + Math.random() * 0.03, 2 + Math.random() * 3, '#a01818', 0.06); }
    particles.push({ x, y, ring: true, r: 3, rMax: big ? 40 : 24, life: 1, decay: 0.07, color: '#c02424' });
  } else if (style === 1) {    // ROZSEKNUTÍ — kusy těla létají a padají
    for (let i = 0; i < 7 * n; i++) { const a = Math.random() * Math.PI * 2, s = Math.random() * 3 + 1.5; P(Math.cos(a) * s, Math.sin(a) * s - 1.5, 1, 0.012, 4 + Math.random() * 4, i % 2 ? color : '#7a1818', 0.16); }
    for (let i = 0; i < 10; i++) { const a = Math.random() * Math.PI * 2, s = Math.random() * 3; P(Math.cos(a) * s, Math.sin(a) * s, 1, 0.045, 2, '#a01818', 0.05); }
  } else if (style === 2) {    // VÝBUCH vnitřností
    for (let i = 0; i < 12 * n; i++) { const a = Math.random() * Math.PI * 2, s = Math.random() * 5 + 2; P(Math.cos(a) * s, Math.sin(a) * s, 1, 0.02, 3 + Math.random() * 3, i % 3 ? color : '#b02424', 0.1); }
    particles.push({ x, y, ring: true, r: 4, rMax: big ? 55 : 34, life: 1, decay: 0.05, color: '#ff6a4a' });
    particles.push({ x, y, ring: true, r: 3, rMax: big ? 34 : 22, life: 1, decay: 0.07, color: '#c02424' });
  } else if (style === 3) {    // KOSTI
    for (let i = 0; i < 9 * n; i++) { const a = Math.random() * Math.PI * 2, s = Math.random() * 3 + 1; P(Math.cos(a) * s, Math.sin(a) * s - 1, 1, 0.014, 2 + Math.random() * 3, '#e8e4d0', 0.13); }
    for (let i = 0; i < 6; i++) { const a = Math.random() * Math.PI * 2, s = Math.random() * 3; P(Math.cos(a) * s, Math.sin(a) * s, 1, 0.04, 2, '#901818', 0.05); }
  } else {                     // ROZKLAD (zelený sliz)
    for (let i = 0; i < 16 * n; i++) { const a = Math.random() * Math.PI * 2, s = Math.random() * 3; P(Math.cos(a) * s, Math.sin(a) * s, 1, 0.02 + Math.random() * 0.02, 3 + Math.random() * 3, i % 2 ? '#5fbf47' : '#7ad06a', 0.03); }
    particles.push({ x, y, ring: true, r: 3, rMax: big ? 42 : 26, life: 1, decay: 0.05, color: '#8fe060' });
  }
  sfx.enemyDie();
}
function burst(x, y, color, n = 10) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = Math.random() * 3 + 0.5;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, decay: 0.03 + Math.random() * 0.03, size: 2 + Math.random() * 2, color });
  }
}
function explode(x, y, color, n = 14) {
  burst(x, y, color, n);
  particles.push({ x, y, ring: true, r: 3, rMax: 20 + n, life: 1, decay: 0.07, color });
  // trocha „dýmu"
  for (let i = 0; i < Math.min(6, n / 3); i++) {
    const a = Math.random() * Math.PI * 2, s = Math.random() * 1.5;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.4, life: 1, decay: 0.02, size: 4 + Math.random() * 4, color: 'rgba(40,40,40,0.5)', smoke: true });
  }
}
// Plovoucí číslo poškození
function spawnFloater(x, y, dmg, crit) {
  floaters.push({ x: x + (Math.random() - 0.5) * 6, y, txt: '' + dmg, t: crit ? 46 : 34, crit: !!crit, vy: crit ? -1.1 : -0.8 });
}
// Trvalá krvavá skvrna na zemi
function spawnDecal(x, y, r) {
  decals.push({ x, y, r: r * 0.7 + Math.random() * 4, a: 0.35 });
  if (decals.length > 60) decals.shift();
}
// Drop dočasného bonusu
function dropPickup(x, y, guaranteed) {
  let total = 0; for (const k in DROP_WEIGHTS) total += DROP_WEIGHTS[k];
  let r = Math.random() * total, id = 'heal';
  for (const k in DROP_WEIGHTS) { r -= DROP_WEIGHTS[k]; if (r <= 0) { id = k; break; } }
  pickups.push({ id, x, y, t: 600, bob: Math.random() * 6 });
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
  animClock += dt;
  if (banner && (banner.t -= dt) <= 0) banner = null;
  if (shake > 0) shake = Math.max(0, shake - 0.5 * dt);
  if (flash > 0) flash = Math.max(0, flash - 0.05 * dt);
  if (hitStop > 0) { hitStop -= dt; return; }   // krátké „zamrznutí" po velkém zásahu
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

  if (freezeTimer > 0) freezeTimer -= dt;
  if (run.comboT > 0) { run.comboT -= dt; if (run.comboT <= 0) run.combo = 0; }

  updatePlayers(dt);
  updateEnemies(dt);
  updateWarriors(dt);
  updateTurrets(dt);
  updateTraps(dt);
  updateGroundFx(dt);
  updateBullets(dt);
  updateEnemyBullets(dt);
  updatePickups(dt);
  updateParticles(dt);
  updateFloaters(dt);
  updateEffects(dt);

  // spawn z fronty
  if (wave.spawned < wave.total) {
    wave.spawnCool -= dt;
    if (wave.spawnCool <= 0) {
      spawnEnemy(wave.queue[wave.spawned++]);
      wave.spawnCool = wave.interval || Math.max(10, 40 - run.wave * 1.2);
    }
  }
  // konec vlny
  enemies = enemies.filter(e => !e.dead);
  if (wave.spawned >= wave.total && enemies.length === 0) return endWave();
  // konec hry jen když padne brána (padlí hráči se oživí další vlnu)
  if (run.lives <= 0) return doGameOver();
}

function endWave() {
  wave.reward.gems = waveReward(run.wave);
  creditAll(wave.reward.gems);
  wave.reward.xp = wave.kills * 3;
  if (isFinalWave(run.wave)) return doVictory();   // poražen Pekelný pán → vítězství
  setState('roundEnd');
  sfx.waveWin();
}
function doVictory() {
  run.won = true;
  const name = profile.settings.name || 'Rytíř';
  addScore(name, run.wave, run.score || 0);
  saveProfile(profile);
  sfx.waveWin(); setTimeout(() => { try { sfx.levelUp(); } catch {} }, 300);
  setState('victory');
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
    if (p.abilityCd > 0) p.abilityCd -= dt;
    if (p.buffRapid > 0) p.buffRapid -= dt;
    if (p.buffPower > 0) p.buffPower -= dt;
    if (p.shieldT > 0) p.shieldT -= dt;
    if (p.rageT > 0) p.rageT -= dt;
    if (p.blockT > 0) p.blockT -= dt;         // rytíř: aktivní blok (nezranitelnost)
    if (p.invisT > 0) { p.invisT -= dt; if (p.invisT <= 0) p.backstabArmed = false; }  // zvěd: neviditelnost
    if (p.flurryT > 0) p.flurryT -= dt;       // lovec: smršt
    if (p.clanCd > 0) p.clanCd -= dt;         // berserk: cooldown volání klanu (běží i mimo)
    if (p.abomT > 0) updateAbomination(p, dt);// alchymista: proměna v abominaci
    if (p.mana < p.manaMax) p.mana = Math.min(p.manaMax, p.mana + p.manaRegen * dt);
    // léčivá aura (kněz)
    if (p.passive.healAura) p.hp = Math.min(p.hpMax, p.hp + p.passive.healAura * dt);
    // perk: regenerace (HP/s)
    if (p.passive.regenAdd) p.hp = Math.min(p.hpMax, p.hp + p.passive.regenAdd / 60 * dt);
    // pohyb
    let sp = p.baseSpeed * (1 + 0.06 * ((run.upgrades && run.upgrades.speed) || 0)) * (p.passive.speedMul || 1);
    if (p.abomT > 0) sp *= ABOM_SPEEDMUL;     // abominace je pomalejší (−38 %)
    if (p.passive.berserk && p.hp < p.hpMax * 0.35) sp *= 1.3;
    if (p.rageT > 0) sp *= 1.25;
    if (p.dashT > 0) { // výpad (zvěd) — rychlý pohyb ve směru míření
      p.dashT -= dt; sp *= 3.4; p.input.mx = Math.cos(p.aimAngle); p.input.my = Math.sin(p.aimAngle); p.inv = Math.max(p.inv, 4);
      const near = enemyHash.query(p.x, p.y, p.r + 14);
      for (const e of near) if (!e.dead && dist(p.x, p.y, e.x, e.y) < e.r + p.r + 4) damageEnemy(e, 18 * (p.passive.meleeDmg || 1), null, p);
    }
    const moving = Math.abs(p.input.mx) + Math.abs(p.input.my) > 0.05;
    if (moving) { p.walk += 0.3 * dt; if (Math.random() < 0.12) burst(p.x, p.y + p.r * 0.6, 'rgba(120,110,90,0.5)', 1); } // prach
    // bez auto-míření (a bez ručního míření) se postava otáčí po směru chůze
    if (moving && !p.autoaim && !p.input.aiming) p.aimAngle = Math.atan2(p.input.my, p.input.mx);
    const nx = p.x + p.input.mx * sp * dt, ny = p.y + p.input.my * sp * dt;
    moveEntity(p, nx, ny);
    p.x = clamp(p.x, p.r, ARENA_W - p.r); p.y = clamp(p.y, p.r, ARENA_H - p.r);
    // střelba
    updatePlayerCombat(p, dt);
  }
}
function emitAbilityFx(p) {
  emitEv({ k: 'ability', x: p.x, y: p.y, cls: p.classId });
  effects.push({ type: 'nova', x: p.x, y: p.y, r: 4, rMax: 90, t: 24, color: p.color });
}
// Aktivní schopnost třídy (každá má vlastní gating; přepracováno dle zadání)
function useAbility(p) {
  if (!p || p.downed) return;
  const ab = ABILITIES[p.classId]; if (!ab) return;
  // — schopnosti s vlastním (ne-cooldown) gatingem —
  if (p.classId === 'berserk') {
    if (p.clanCd > 0 || p._clanActive) return;
    if (p.hp > p.hpMax * BERSERK_HP_GATE) { banner = { text: 'Volání klanu jde jen při ≤ 50 % HP!', t: 70, warn: true }; return; }
    spawnClanAxemen(p); p._clanActive = true; emitAbilityFx(p); sfx.groan(); return;
  }
  if (p.classId === 'alchymista') {
    if (p.abomT > 0) return;
    if ((p.potions || 0) <= 0) { banner = { text: 'Potřebuješ lektvar (nasbírej 5 žlučí)!', t: 70, warn: true }; return; }
    p.potions--; startAbomination(p); emitAbilityFx(p); sfx.groan(); return;
  }
  if (p.classId === 'knez') {
    if (p.resurrectUsed) { banner = { text: 'Vzkříšení už bylo v tomto kole použito.', t: 70, warn: true }; return; }
    p.resurrectUsed = true; doResurrect(p); emitAbilityFx(p); return;
  }
  // — schopnosti na klasickém cooldownu —
  if (p.abilityCd > 0) return;
  p.abilityCd = Math.round(ab.cd * (p.passive.cdMul || 1));   // perk Soustředění: −% cooldown

  const a = p.aimAngle;
  emitAbilityFx(p);
  switch (p.classId) {
    case 'rytir': {
      const lvl = run.shieldLvl || 0;
      p.blockT = shieldBlockTime(lvl); p._reflect = shieldReflect(lvl);
      for (const e of enemyHash.query(p.x, p.y, 150)) if (!e.dead) { const an = Math.atan2(e.y - p.y, e.x - p.x); e.x += Math.cos(an) * 10; e.y += Math.sin(an) * 10; }
      sfx.buy(); break;
    }
    case 'lovec': p.flurryT = HUNTER_FLURRY_TIME; sfx.bow(); break;
    case 'zved': p.invisT = SCOUT_INVIS_TIME; p.backstabArmed = true; p.inv = Math.max(p.inv, 8); sfx.throwsnd(); break;
    case 'mag': doArmageddon(p); break;
    case 'inzenyr': deployFieldTurret(p); break;
  }
}
// — Berserk: přivolá 2 sekerníky (dočasní spojenci s vlastním def) —
function spawnClanAxemen(p) {
  const d = CLAN_AXEMAN;
  for (let i = 0; i < 2; i++) {
    const ox = (i === 0 ? -1 : 1) * 22;
    warriors.push({ def: d, defId: 'clan_axeman', x: p.x + ox, y: p.y + 14, r: 12,
      hp: d.hp, hpMax: d.hp, homeX: p.x, homeY: p.y, cool: 0, aim: 0, flash: 0, atkAnim: 0,
      temp: CLAN_LIFETIME, clanOwner: p });
  }
  banner = { text: '🪓 KLAN PŘICHÁZÍ!', t: 80 };
}
// — Alchymista: proměna v abominaci —
function startAbomination(p) {
  p.abomT = ABOM_DURATION; p._abomBurst = 0; p._preAbomR = p.r; p.r = 20;
  p.hp = p.hpMax;   // proměna doléčí
  banner = { text: '🧟 ABOMINACE!', t: 90, warn: true };
}
// běží každý tick z updatePlayers dokud abomT>0
function updateAbomination(p, dt) {
  p.abomT -= dt;
  // požírání pěšáků + leptání silnějších v okruhu
  p._abomBurst = (p._abomBurst || 0) - dt;
  const doBurst = p._abomBurst <= 0;
  if (doBurst) p._abomBurst = ABOM_ACID_BURST_CD;
  const near = enemyHash.query(p.x, p.y, ABOM_ACID_RADIUS + 30);
  for (const e of near) {
    if (e.dead) continue;
    const d = dist(p.x, p.y, e.x, e.y);
    const weak = e.arch === 'WALKER' || e.arch === 'RUNNER' || e.arch === 'EXPLODER';
    if (weak && d < p.r + e.r + 4) {                 // sežrání pěšáka na kontakt
      e.hp = 0; killEnemy(e, p);
      p.bonusHp = (p.bonusHp || 0) + ABOM_HP_PER_EAT; recalcPerks(p);  // +2 max HP navždy
      p.hp = Math.min(p.hpMax, p.hp + 6);
      spawnFloater(p.x, p.y - p.r - 4, 0, false); floaters[floaters.length - 1].txt = '+HP'; floaters[floaters.length - 1].pickup = '#8fd84a';
    } else if (!weak && d < ABOM_ACID_RADIUS + e.r) { // leptání silnějších žíravinou
      e.dotDps = Math.max(e.dotDps, ABOM_ACID_DPS); e.dotTimer = Math.max(e.dotTimer, 40);
      if (doBurst) damageEnemy(e, ABOM_ACID_BURST, null, p);
    }
  }
  // vizuální žíravá aura
  if (Math.random() < 0.4) burst(p.x + (Math.random() - 0.5) * p.r * 2, p.y + (Math.random() - 0.5) * p.r * 2, '#8fd84a', 1);
  if (p.abomT <= 0) { p.r = p._preAbomR || 12; banner = { text: 'Proměna skončila.', t: 50 }; }
}
// — Kněz: vzkříšení padlých + léčení + spálení —
function doResurrect(p) {
  let revived = 0;
  for (const q of players) {
    if (q === p) continue;
    if (q.downed && dist(p.x, p.y, q.x, q.y) <= 220) { q.downed = false; q.hp = Math.round(q.hpMax * 0.6); q.inv = 60; revived++; effects.push({ type: 'nova', x: q.x, y: q.y, r: 4, rMax: 60, t: 24, color: '#f0e0a0' }); }
  }
  for (const q of players) if (!q.downed) q.hp = Math.min(q.hpMax, q.hp + 60);
  aoeExplosion(p.x, p.y, 130, 40, null, '#f0e0a0');
  banner = { text: revived ? '✨ VZKŘÍŠENO: ' + revived : '✨ Svaté světlo', t: 70 };
}
// — Mág: meteor na nejbližší shluk —
function doArmageddon(p) {
  // NEJBLIŽŠÍ shluk: mezi nepřáteli seřazenými dle vzdálenosti vezmi první s ≥3 sousedy,
  // jinak nejbližšího nepřítele (ať meteor vždy někam dopadne).
  let bx = p.x + Math.cos(p.aimAngle) * 160, by = p.y + Math.sin(p.aimAngle) * 160;
  const live = enemies.filter(e => !e.dead).sort((a, b) => ((a.x - p.x) ** 2 + (a.y - p.y) ** 2) - ((b.x - p.x) ** 2 + (b.y - p.y) ** 2));
  if (live.length) {
    bx = live[0].x; by = live[0].y;   // fallback: nejbližší nepřítel
    for (const e of live) { let c = 0; for (const o of enemyHash.query(e.x, e.y, MAG_METEOR_RADIUS)) if (!o.dead) c++; if (c >= 3) { bx = e.x; by = e.y; break; } }
  }
  const dmg = MAG_METEOR_DMG * (p.passive.magicDmg || 1);
  effects.push({ type: 'nova', x: bx, y: by, r: 6, rMax: MAG_METEOR_RADIUS, t: 24, color: '#ff7b3a' });
  aoeExplosion(bx, by, MAG_METEOR_RADIUS, dmg, MAG_METEOR_DOT, '#ff7b3a');
  shake = Math.min(12, shake + 8); sfx.boom();
  banner = { text: '☄ ARMAGEDON!', t: 70, warn: true };
}
// — Inženýr: postaví polní věž(e) dle vylepšení + opraví zdi —
function deployFieldTurret(p) {
  const wu = run.wheelUpgrades || {};
  const count = 1 + (wu.count || 0);
  const dur = 720 + (wu.dur || 0) * 180;        // +3 s za úroveň
  const hp = Math.round(90 * (1 + 0.4 * (wu.hp || 0)));
  const def = TRAPS.samostril;
  let placed = 0;
  const spots = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const btx = Math.floor(p.x / TILE), bty = Math.floor(p.y / TILE);
  for (const [dx, dy] of spots) {
    if (placed >= count) break;
    const tx = btx + dx, ty = bty + dy;
    if (!inBounds(tx, ty) || isBlocked(tx, ty) || grid.coreTiles.includes(tileIndex(tx, ty)) || grid.structures[tileIndex(tx, ty)] !== null) continue;
    const obj = { def, defId: 'samostril', tx, ty, x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, r: 15, hp, hpMax: hp, fireCool: 0, flash: 0, temp: dur, field: true };
    grid.structures[tileIndex(tx, ty)] = obj; turrets.push(obj); placed++;
  }
  for (const s of walls) s.hp = s.hpMax;
  flowDirty = true; sfx.place();
}
function updatePlayerCombat(p, dt) {
  if (p.atkAnim > 0) p.atkAnim -= dt;
  p.cool -= dt;
  const w = activeWeapon(p);
  const range = w.range * rangeMod(p, w);
  const manual = p.input.aiming;             // ruční stick vždy přebíjí
  const tgt = nearestEnemy(p.x, p.y, range);
  let aim = p.aimAngle;
  if (!manual && p.autoaim && tgt) { aim = Math.atan2(tgt.y - p.y, tgt.x - p.x); p.aimAngle = aim; }
  let wantFire = manual;
  if (!manual && p.autofire) {
    // s auto-mířením stačí cíl v dosahu; bez něj střílí kam kouká (jen když je kam)
    wantFire = w.cat === 'melee' ? !!nearestEnemy(p.x, p.y, range) : (p.autoaim ? !!tgt : true);
  }
  if (wantFire && p.cool <= 0) {
    if (fireWeapon(p, w, aim)) { p.cool = w.rate * rateMod(p, w); p.aimAngle = aim; p.atkAnim = w.cat === 'melee' ? 10 : 6; }
    else p.cool = 20; // prázdno – krátká prodleva
  }
}
function damagePlayer(p, amount, src) {
  if (p.inv > 0) return;
  // rytíř: aktivní blok štítem vykryje VŠECHNY útoky (i střely) + volitelně odrazí
  if (p.blockT > 0) {
    effects.push({ type: 'text', x: p.x, y: p.y - 20, txt: 'BLOK', t: 30, color: '#8fd0ff' });
    if (p._reflect && src && !src.dead) damageEnemy(src, amount * p._reflect, null, p);
    sfx.buy(); return;
  }
  if (p.passive.dodge && Math.random() < p.passive.dodge) { effects.push({ type: 'text', x: p.x, y: p.y - 20, txt: 'úhyb', t: 30, color: '#c8c85c' }); return; }
  let dmg = amount;
  if (p.passive.block && Math.random() < p.passive.block) dmg *= 0.4;
  if (p.shieldT > 0) dmg *= 0.35;   // starší štít (kompatibilita)
  if (p.abomT > 0) dmg *= (1 - ABOM_DR);            // abominace: −50 % obdrž. poškození
  dmg *= (p.passive.armorMul || 1);                  // perky: −% obdrženého poškození
  dmg *= Math.max(0.35, 1 - 0.05 * ((run.upgrades && run.upgrades.armor) || 0)); // stat Pancíř
  // perk: trny — vrací část poškození útočníkovi zblízka
  if (p.passive.thorns && src && !src.dead) damageEnemy(src, dmg * p.passive.thorns, null, p);
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
      if (grid.tiles[i] === 1 || structBlocks(grid.structures[i])) return true;  // věže jsou průchozí
    }
  return false;
}
function moveEntity(e, nx, ny) {
  const r = e.r;
  const ox = e.x, oy = e.y;
  const wantX = nx - ox, wantY = ny - oy;
  // Sekvenční řešení os: nejdřív X, pak Y S JIŽ NOVÝM X. Tím se otestuje i
  // diagonální roh (nx,ny) jako celek → entita nikdy neproklouzne skrz roh zdi.
  const blockedX = circleBlocked(nx, oy, r);
  if (!blockedX) e.x = nx;
  const blockedY = circleBlocked(e.x, ny, r);
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
  // Vyprošťuje SMĚREM k volné (walkable) sousední dlaždici → nikdy ne skrz zeď.
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
      // přivolává jen boss, který summon opravdu má (např. Abominace ne)
      if (e.def.summon) {
        e.summonCool -= dt;
        const minions = enemies.reduce((n, o) => n + (o.arch !== 'BOSS' && !o.dead ? 1 : 0), 0);
        if (e.summonCool <= 0 && minions < 10) { spawnEnemy(e.def.summon); e.summonCool = e.def.summonRate; }
        else if (e.summonCool <= 0) { e.summonCool = 40; }
      }
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

    if (e.spawnT > 0) e.spawnT -= dt;   // krátká „nezranitelnost" objevení (jen vizuál)
    const spd = e.speed * e.slowMul * (freezeTimer > 0 ? 0 : 1);
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
    // Pohyb s kolizemi (i boss — NEprochází zdmi; zeď v cestě prokousává).
    const sx0 = e.x, sy0 = e.y;
    moveEntity(e, nx, ny);
    const wanted = Math.hypot(dx, dy) * spd * dt;
    const moved = Math.hypot(e.x - sx0, e.y - sy0);
    if (wanted > 0.15 && moved < 0.15 * wanted) {
      e.stuckT = (e.stuckT || 0) + dt;
      // boss se vyprostí rychleji a razantněji (je velký)
      if (e.stuckT > (e.arch === 'BOSS' ? 8 : 14)) { escapeStuck(e); e.stuckT = 0; }
    } else e.stuckT = 0;

    // kontakt s hráčem
    if (pl && hitCircle(e, pl, 2)) {
      e.atkCool -= dt;
      if (e.arch === 'EXPLODER') { explodeEnemy(e, pl); continue; }
      if (e.atkCool <= 0) { damagePlayer(pl, e.dmg, e); e.atkCool = e.atkRate || 40; }
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
  if (dist(e.x, e.y, target.x, target.y) <= e.def.aoeRadius + target.r) damagePlayer(target, e.dmg, e);
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
    if (wr.atkAnim > 0) wr.atkAnim -= dt;
    // sekerníci klanu: dočasný život + odejdou, když berserk vystoupá nad 65 % HP
    if (wr.clanOwner) {
      if (wr.temp != null) wr.temp -= dt;
      if (wr.clanOwner.hp > wr.clanOwner.hpMax * CLAN_DISMISS_HP) wr.temp = 0;
      wr.homeX = wr.clanOwner.x; wr.homeY = wr.clanOwner.y;
    }
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
        wr.cool = def.rate; wr.atkAnim = 8;
      }
    } else {
      // návrat domů
      const d = dist(wr.x, wr.y, wr.homeX, wr.homeY);
      if (d > 6) { const a = Math.atan2(wr.homeY - wr.y, wr.homeX - wr.x); moveEntity(wr, wr.x + Math.cos(a) * def.speed * dt, wr.y + Math.sin(a) * def.speed * dt); }
    }
  }
  // úklid vypršelých sekerníků (mrtvé kosí i smyčka nepřátel — proto odchod řešíme podle vlastníka níže)
  for (const w of warriors) if (w.clanOwner && w.temp != null && w.temp <= 0) { w.hp = 0; burst(w.x, w.y, w.def.color, 12); }
  warriors = warriors.filter(w => w.hp > 0);
  // po odchodu VŠECH sekerníků: 40s cooldown a odblokování dalšího volání
  for (const p of players) {
    if (p._clanActive && !warriors.some(w => w.clanOwner === p)) { p._clanActive = false; p.clanCd = CLAN_COOLDOWN; banner = { text: 'Klan odešel — cooldown 40 s.', t: 60 }; }
  }
}

/* ---------- Věže (EMITTER) ---------- */
function updateTurrets(dt) {
  for (const t of turrets) {
    if (t.flash > 0) t.flash -= dt;
    if (t.temp != null) { t.temp -= dt; if (t.temp <= 0) { t.hp = 0; damageStructure(t, 0); continue; } }
    t.fireCool -= dt;
    const def = t.def;
    const wu = (run && run.wheelUpgrades) || {};
    const dmgMul = (t.up || 1) * (t.field ? (1 + 0.2 * (wu.dmg || 0)) : 1);   // wheel: +dmg polní věže
    const rate = def.rate * teamRate('emitterRate') * (t.field ? 1 / (1 + 0.15 * (wu.rate || 0)) : 1);  // wheel: +rychlost
    if (t.fireCool <= 0) {
      const tgt = nearestEnemy(t.x, t.y, def.range);
      if (tgt) {
        const a = Math.atan2(tgt.y - t.y, tgt.x - t.x);
        bullets.push({ x: t.x, y: t.y, vx: Math.cos(a) * def.projSpeed, vy: Math.sin(a) * def.projSpeed, r: 4, dmg: def.dmg * dmgMul, pierce: def.pierce || 0, range: def.range, traveled: 0, color: '#ffe08a', hitIds: [], owner: null, fromTurret: true });
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
      // TRVALÁ nášlapná past — zasáhne JEDNOHO nepřítele na dlaždici a chvíli
      // se „nabíjí". Nízké poškození → mob potřebuje víc zásahů, nezmizí.
      t.hitCd -= dt;
      if (t.hitCd <= 0) {
        const cand = enemyHash.query(t.x, t.y, TILE * 0.7);
        for (const e of cand) {
          if (e.dead) continue;
          if (dist(t.x, t.y, e.x, e.y) < TILE * 0.6 + e.r) {
            damageEnemy(e, def.dmg * (t.up || 1), null, null); t.hitCd = 16;
            burst(t.x, t.y, '#ffffff', 5);
            break;
          }
        }
      }
    } else if (def.arch === 'DOT_AOE') {
      t.dur -= dt;
      const cand = enemyHash.query(t.x, t.y, def.radius);
      for (const e of cand) { if (!e.dead && dist(t.x, t.y, e.x, e.y) <= def.radius + e.r) { e.hp -= def.dps * (t.up || 1) * dt / 60; if (e.hp <= 0) killEnemy(e); } }
      if (Math.random() < 0.3) burst(t.x + (Math.random() - 0.5) * def.radius, t.y + (Math.random() - 0.5) * def.radius, def.color, 1);
    }
    // SLOW se aplikuje v updateEnemies
  }
  // pasti jsou trvalé v rámci mapy; odstraní se jen výslovně časované (dur)
  traps = traps.filter(t => !(t.def.arch === 'DOT_AOE' && t.dur <= 0));
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
        damageEnemy(e, b.dmg, b, b.owner, b.crit); b.hitIds.push(e);
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
      if (!p.downed && p.inv <= 0 && hitCircle(b, p)) { damagePlayer(p, b.dmg); b.dead = true; break; }
    }
    for (const wr of warriors) { if (hitCircle(b, wr)) { wr.hp -= b.dmg; wr.flash = 5; b.dead = true; break; } }
  }
  eBullets = eBullets.filter(b => !b.dead);
}
function updateParticles(dt) {
  for (const p of particles) {
    if (p.ring) { p.r += (p.rMax - p.r) * 0.2 * dt; p.life -= p.decay * dt; continue; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; p.life -= p.decay * dt;
    if (p.grav) p.vy += p.grav * dt;
    if (p.smoke) p.size += 0.3 * dt;
  }
  particles = particles.filter(p => p.life > 0);
}
function updateFloaters(dt) {
  for (const f of floaters) { f.y += f.vy * dt; f.vy *= 0.94; f.t -= dt; }
  floaters = floaters.filter(f => f.t > 0);
}
function updatePickups(dt) {
  for (const pu of pickups) {
    pu.t -= dt; pu.bob += 0.1 * dt;
    // žluč: sbírá jen alchymista a musí u ní stát 1 s (harvest)
    if (pu.id === 'zluc') {
      const al = players.find(p => !p.downed && p.classId === 'alchymista' && dist(pu.x, pu.y, p.x, p.y) < p.r + 16);
      if (al) { pu.hold = (pu.hold || 0) + dt; if (pu.hold >= BILE_HARVEST_TIME) { applyPickup(pu, al); pu.dead = true; } }
      else pu.hold = 0;
      continue;
    }
    for (const p of players) {
      if (p.downed) continue;
      if (dist(pu.x, pu.y, p.x, p.y) < (p.r + 14) * (p.passive.pickupMul || 1)) { applyPickup(pu, p); pu.dead = true; break; }
    }
  }
  pickups = pickups.filter(pu => !pu.dead && pu.t > 0);
}
function applyPickup(pu, p) {
  const d = DROPS[pu.id];
  // drop platí VŠEM hráčům najednou (buff/léčení/gemy/mráz)
  if (d.kind === 'buff') { for (const q of players) { if (pu.id === 'rapid') q.buffRapid = d.dur; else q.buffPower = d.dur; } }
  else if (d.kind === 'freeze') { freezeTimer = 150; emitEv({ k: 'freeze' }); }
  else if (d.kind === 'heal') { for (const q of players) if (!q.downed) q.hp = Math.min(q.hpMax, q.hp + 45); }
  else if (d.kind === 'gems') { creditAll(d.gems); }
  else if (d.kind === 'mat') { run[d.mat] = (run[d.mat] || 0) + d.amt; }
  else if (d.kind === 'bile') {
    p.bile = (p.bile || 0) + 1;
    if (p.bile >= BILE_PER_POTION && (p.potions || 0) < BILE_MAX_POTIONS) { p.bile -= BILE_PER_POTION; p.potions = (p.potions || 0) + 1; banner = { text: '⚗ Lektvar abominace hotov! (' + p.potions + '/' + BILE_MAX_POTIONS + ')', t: 80 }; }
    else if (p.bile >= BILE_PER_POTION) p.bile = BILE_PER_POTION;   // strop, když jsou lektvary plné
  }
  burst(pu.x, pu.y, d.color, 14);
  spawnFloater(pu.x, pu.y - 8, 0, false); floaters[floaters.length - 1].txt = d.icon + ' ' + d.name; floaters[floaters.length - 1].pickup = d.color;
  sfx.heal();
  emitEv({ k: 'pick', x: pu.x, y: pu.y, color: d.color });
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
  if (state === 'menu' || state === 'class' || state === 'host' || state === 'join' || state === 'gameOver' || state === 'victory') { drawMenuBg(); return; }
  const cp = localPlayer();
  if (cp && state !== 'build') updateCamera(cp.x, cp.y, 1);   // ve stavění kamerou hýbe hráč ručně
  else clampCamera();
  ctx.save();
  if (shake > 0.2) ctx.translate((Math.random() - 0.5) * shake * 2, (Math.random() - 0.5) * shake * 2);
  applyCamera();
  drawArena();
  drawDecals();
  drawGroundFx();
  drawTraps();
  drawStructures();
  drawPickups();
  drawWarriors();
  drawEnemies();
  drawBullets();
  drawEffects();
  drawPlayers();
  if (state === 'build') drawBuildGhost();
  drawParticles();
  drawFloaters();
  ctx.restore();

  // překryvy v prostoru obrazovky
  if (freezeTimer > 0) { ctx.fillStyle = 'rgba(140,220,255,0.12)'; ctx.fillRect(0, 0, VIEWW, VIEWH); }
  drawVignette();
  if (state === 'combat' || state === 'build') drawHud();
  if (banner) drawBanner();
  if (flash > 0.01) { ctx.fillStyle = `rgba(255,40,40,${flash})`; ctx.fillRect(0, 0, W, VIEWH); }
}
function drawVignette() {
  if (!vignetteCache) {
    vignetteCache = document.createElement('canvas'); vignetteCache.width = VIEWW; vignetteCache.height = VIEWH;
    const g = vignetteCache.getContext('2d');
    const rg = g.createRadialGradient(VIEWW / 2, VIEWH / 2, VIEWH * 0.35, VIEWW / 2, VIEWH / 2, VIEWH * 0.72);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(0,0,0,0.42)');
    g.fillStyle = rg; g.fillRect(0, 0, VIEWW, VIEWH);
  }
  ctx.drawImage(vignetteCache, 0, 0);
}
let vignetteCache = null;

function drawMenuBg() {
  if (terrainCanvas) ctx.drawImage(terrainCanvas, 0, 0, ARENA_W, ARENA_H, 0, 0, W, H);
  else { ctx.fillStyle = '#243018'; ctx.fillRect(0, 0, W, H); }
  ctx.fillStyle = 'rgba(8,10,6,0.55)'; ctx.fillRect(0, 0, W, H);
}
function drawArena() {
  if (terrainCanvas) ctx.drawImage(terrainCanvas, 0, 0);
  // animované spawn portály
  for (const s of SPAWNS) {
    const px = clamp(s.x, 12, ARENA_W - 12), py = clamp(s.y, 12, ARENA_H - 12);
    const pulse = 0.6 + Math.sin(animClock * 0.08 + px) * 0.25;
    ctx.save(); ctx.translate(px, py);
    ctx.fillStyle = 'rgba(120,30,60,0.35)'; ctx.beginPath(); ctx.ellipse(0, 0, 13, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = `rgba(200,60,90,${pulse})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 0, 11, 6, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.rotate(animClock * 0.05);
    ctx.fillStyle = 'rgba(180,50,80,0.5)'; ctx.beginPath(); ctx.arc(9, 0, 1.6, 0, Math.PI * 2); ctx.arc(-9, 0, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  drawGate();
}
function drawGate() {
  const cx = CORE.tx * TILE, cy = CORE.ty * TILE, cw = CORE.w * TILE, ch = CORE.h * TILE;
  // stín
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; roundRect(cx + 3, cy + ch - 6, cw - 6, 10, 4); ctx.fill();
  // hradba
  ctx.fillStyle = '#6a7078'; roundRect(cx + 2, cy + 4, cw - 4, ch - 6, 4); ctx.fill();
  ctx.fillStyle = '#7c828a'; roundRect(cx + 5, cy + 7, cw - 10, ch - 12, 3); ctx.fill();
  // cimbuří
  ctx.fillStyle = '#5a6068';
  for (let i = 0; i < CORE.w * 2; i++) if (i % 2 === 0) ctx.fillRect(cx + 4 + i * 8, cy, 8, 8);
  // brána (dřevo)
  const gw = cw * 0.5, gx = cx + cw / 2 - gw / 2;
  ctx.fillStyle = '#4a3420'; roundRect(gx, cy + 12, gw, ch - 16, 4); ctx.fill();
  ctx.strokeStyle = '#2e2214'; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(gx + i * gw / 4, cy + 12); ctx.lineTo(gx + i * gw / 4, cy + ch - 4); ctx.stroke(); }
  // věže po stranách + vlajka
  for (const bx of [cx - 2, cx + cw - 10]) {
    ctx.fillStyle = '#5a6068'; roundRect(bx, cy - 6, 12, ch + 6, 3); ctx.fill();
    ctx.fillStyle = '#7c828a'; roundRect(bx + 2, cy - 4, 8, 8, 2); ctx.fill();
  }
  // vlajka na levé věži
  const fx = cx, fy = cy - 6;
  ctx.strokeStyle = '#cfcfcf'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(fx + 6, fy); ctx.lineTo(fx + 6, fy - 16); ctx.stroke();
  ctx.fillStyle = players[0] ? players[0].color : '#c8a45c';
  const fw = 12 + Math.sin(animClock * 0.15) * 2;
  ctx.beginPath(); ctx.moveTo(fx + 6, fy - 16); ctx.lineTo(fx + 6 + fw, fy - 13); ctx.lineTo(fx + 6, fy - 10); ctx.fill();
  // pochodně (blikají)
  for (const tx of [cx + 2, cx + cw - 4]) drawTorch(tx, cy + 6);
}
function drawTorch(x, y) {
  ctx.fillStyle = '#3a2a18'; ctx.fillRect(x - 1.5, y, 3, 10);
  const fl = 4 + Math.sin(animClock * 0.4 + x) * 1.5;
  ctx.fillStyle = 'rgba(255,160,40,0.25)'; ctx.beginPath(); ctx.arc(x, y - 2, fl * 2.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffb020'; ctx.beginPath(); ctx.ellipse(x, y - 3, fl * 0.6, fl, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff0a0'; ctx.beginPath(); ctx.ellipse(x, y - 2, fl * 0.3, fl * 0.5, 0, 0, Math.PI * 2); ctx.fill();
}
function drawDecals() {
  for (const d of decals) { if (!onScreen(d.x, d.y, d.r + 10)) continue; ctx.fillStyle = `rgba(90,20,20,${d.a})`; ctx.beginPath(); ctx.ellipse(d.x, d.y, d.r, d.r * 0.6, 0, 0, Math.PI * 2); ctx.fill(); }
}
function drawPickups() {
  for (const pu of pickups) {
    const d = DROPS[pu.id]; const yy = pu.y + Math.sin(pu.bob) * 3;
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(pu.x, pu.y + 8, 8, 3, 0, 0, Math.PI * 2); ctx.fill();
    const glow = 0.4 + Math.sin(animClock * 0.15) * 0.2;
    ctx.fillStyle = d.color; ctx.globalAlpha = 0.3; ctx.beginPath(); ctx.arc(pu.x, yy, 12 * glow + 6, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect((pu.x - 9) | 0, (yy - 9) | 0, 18, 18);
    ctx.fillStyle = d.color; ctx.fillRect((pu.x - 8) | 0, (yy - 8) | 0, 16, 16);
    ctx.fillStyle = '#1a1a1a'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(d.icon, pu.x, yy + 1); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  }
}
function drawFloaters() {
  for (const f of floaters) {
    ctx.globalAlpha = clamp(f.t / 20, 0, 1);
    ctx.textAlign = 'center';
    if (f.pickup) { ctx.fillStyle = f.pickup; ctx.font = 'bold 12px system-ui'; ctx.fillText(f.txt, f.x, f.y); }
    else if (f.crit) { ctx.fillStyle = '#fff'; ctx.font = 'bold 18px system-ui'; ctx.fillText(f.txt + '!', f.x, f.y); ctx.fillStyle = '#ffd35c'; ctx.font = 'bold 17px system-ui'; ctx.fillText(f.txt + '!', f.x, f.y - 0.5); }
    else { ctx.fillStyle = '#ffe0e0'; ctx.font = 'bold 12px system-ui'; ctx.fillText(f.txt, f.x, f.y); }
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
  }
}
// Bloková dlaždice s pixelovou texturou (dřevo = prkna, kámen = dlažba)
function drawBlockTile(x, y, hex, flash, wood) {
  const c = hexRGB(flash > 0 ? '#ffffff' : hex); const CP = 4, N = TILE / CP;
  const rs = mulberry32(((x * 41 + y * 91) & 0xffff) >>> 0);
  for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
    const v = rs(); let k = Math.floor((v - 0.5) * 26);
    if (wood) { if (gy % 2 === 0) k -= 18; }             // prkna: tmavší pruhy
    else if (gx % 4 === 0 || gy % 4 === 0) k = -30;      // dlažba: spáry
    ctx.fillStyle = `rgb(${clamp(c[0] + k, 0, 255)},${clamp(c[1] + k, 0, 255)},${clamp(c[2] + k, 0, 255)})`;
    ctx.fillRect(x + gx * CP, y + gy * CP, CP, CP);
  }
}
function drawStructures() {
  for (const s of [...walls, ...turrets]) {
    if (!onScreen(s.x, s.y, TILE)) continue;
    const x = s.tx * TILE, y = s.ty * TILE, T = TILE, fl = s.flash > 0;
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(x + 2, y + T - 4, T - 4, 5);
    if (s.def.arch === 'EMITTER') {
      // dřevěná věž + otáčecí kuše
      ctx.fillStyle = fl ? '#fff' : '#5a4326'; ctx.fillRect(x + 3, y + 3, T - 6, T - 6);
      ctx.fillStyle = fl ? '#fff' : '#6e5230'; ctx.fillRect(x + 5, y + 5, T - 10, T - 10);
      ctx.fillStyle = '#3a2c18'; ctx.fillRect(x + 5, y + T * 0.45, T - 10, 3);
      const tgt = nearestEnemy(s.x, s.y, s.def.range);
      const a = tgt ? Math.atan2(tgt.y - s.y, tgt.x - s.x) : -Math.PI / 2;
      ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(a);
      ctx.fillStyle = '#3a2a18'; ctx.fillRect(-3, -7, 6, 14);                 // příčník
      ctx.fillStyle = '#8a6a3a'; ctx.fillRect(0, -2, 13, 4);                  // lůžko
      ctx.fillStyle = '#c8ccd4'; ctx.fillRect(6, -1, 9, 2);                   // šipka
      ctx.restore();
    } else if (s.defId === 'drevena_barikada') {
      ctx.fillStyle = fl ? '#fff' : '#7a4f28'; ctx.fillRect(x + 2, y + 2, T - 4, T - 4);
      ctx.fillStyle = fl ? '#fff' : '#8a5c30'; for (let p = 0; p < 3; p++) ctx.fillRect(x + 3, y + 4 + p * 9, T - 6, 7);  // prkna
      ctx.fillStyle = '#3a2410'; for (let p = 0; p < 3; p++) ctx.fillRect(x + 3, y + 3 + p * 9, T - 6, 1);
      ctx.fillStyle = '#2a1c0e'; [[6, 6], [T - 8, 6], [6, T - 8], [T - 8, T - 8]].forEach(n => ctx.fillRect(x + n[0], y + n[1], 2, 2)); // hřebíky
      ctx.fillStyle = 'rgba(60,40,20,0.8)'; ctx.save(); ctx.beginPath(); ctx.rect(x + 2, y + 2, T - 4, T - 4); ctx.clip(); ctx.fillRect(x + 2, y + T - 6, T, 4); ctx.restore();
    } else if (s.defId === 'kamenna_zed') {
      ctx.fillStyle = fl ? '#fff' : '#4a4f56'; ctx.fillRect(x + 2, y + 2, T - 4, T - 4);   // malta
      const cob = fl ? '#fff' : '#8a9098'; const c2 = fl ? '#fff' : '#767c84';
      // nepravidelné kameny
      ctx.fillStyle = cob; ctx.fillRect(x + 3, y + 3, 12, 9); ctx.fillRect(x + 17, y + 4, 11, 7);
      ctx.fillStyle = c2; ctx.fillRect(x + 3, y + 14, 9, 8); ctx.fillRect(x + 14, y + 13, 14, 9);
      ctx.fillStyle = cob; ctx.fillRect(x + 4, y + 24, 13, 5); ctx.fillRect(x + 19, y + 24, 9, 5);
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x + 4, y + 4, 5, 2);
    } else if (s.defId === 'zelezna_brana') {
      ctx.fillStyle = fl ? '#fff' : '#2f343a'; ctx.fillRect(x + 2, y + 2, T - 4, T - 4);
      ctx.fillStyle = fl ? '#fff' : '#6a7078'; for (let b = 0; b < 3; b++) ctx.fillRect(x + 5 + b * 8, y + 3, 4, T - 6);  // svislé mříže
      ctx.fillStyle = '#565b62'; ctx.fillRect(x + 3, y + 7, T - 6, 3); ctx.fillRect(x + 3, y + T - 10, T - 6, 3);          // příčky
      ctx.fillStyle = '#c8ccd4'; [[6, 8], [22, 8], [6, T - 9], [22, T - 9]].forEach(n => ctx.fillRect(x + n[0], y + n[1], 2, 2)); // nýty
    } else { // bodcova_zed
      ctx.fillStyle = fl ? '#fff' : '#6a4530'; ctx.fillRect(x + 5, y + 5, T - 10, T - 10);
      ctx.fillStyle = fl ? '#fff' : '#c0c6ce';
      const spike = (cx, cy, dx, dy) => { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + dx, cy + dy); ctx.lineTo(cx + (dy ? 4 : 0), cy + (dx ? 4 : 0)); ctx.closePath(); ctx.fill(); };
      for (let k = 0; k < 3; k++) { spike(x + 8 + k * 8, y + 5, 0, -5); spike(x + 8 + k * 8, y + T - 5, 0, 5); spike(x + 5, y + 8 + k * 8, -5, 0); spike(x + T - 5, y + 8 + k * 8, 5, 0); }
    }
    if (s.temp != null) { ctx.strokeStyle = `rgba(140,220,255,${0.4 + Math.sin(animClock * 0.3) * 0.3})`; ctx.lineWidth = 1.5; ctx.strokeRect(x + 1, y + 1, T - 2, T - 2); }
    if (s.hp < s.hpMax) {
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(x + 3, y - 3, T - 6, 3);
      ctx.fillStyle = '#5cff8a'; ctx.fillRect(x + 3, y - 3, (T - 6) * (s.hp / s.hpMax), 3);
    }
    if (s.level) drawLevelBadge(x + T - 4, y + 4);
  }
}
function drawLevelBadge(x, y) {
  ctx.fillStyle = '#2a6ad0'; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#8fc0ff'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 7px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('⬆', x, y + 0.5); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}
function drawTraps() {
  for (const t of traps) {
    if (!onScreen(t.x, t.y, TILE)) continue;
    const d = t.def, x = t.tx * TILE, y = t.ty * TILE, T = TILE;
    if (d.arch === 'ONESHOT') {
      // dřevěná deska s ocelovými bodci
      ctx.fillStyle = '#2a2018'; ctx.fillRect(x + 4, y + 4, T - 8, T - 8);
      ctx.fillStyle = '#3a2c1c'; ctx.fillRect(x + 5, y + 5, T - 10, T - 10);
      for (let k = 0; k < 3; k++) for (let r = 0; r < 2; r++) {
        const sx = x + 8 + k * 8, sy = y + 9 + r * 10;
        ctx.fillStyle = '#c8ccd4'; ctx.beginPath(); ctx.moveTo(sx, sy + 5); ctx.lineTo(sx + 2.5, sy - 5); ctx.lineTo(sx + 5, sy + 5); ctx.fill();
        ctx.fillStyle = '#eef0f4'; ctx.fillRect(sx + 1.5, sy - 5, 1, 6);
      }
    } else if (d.arch === 'SLOW') {
      // lepkavá smůla — lesklá tmavá louže
      ctx.fillStyle = '#1a160c'; ctx.fillRect(x + 2, y + 2, T - 4, T - 4);
      ctx.fillStyle = '#2a2410'; ctx.fillRect(x + 4, y + 5, T - 8, T - 9);
      const bub = Math.sin(animClock * 0.15 + t.x) * 0.5 + 0.5;
      ctx.fillStyle = `rgba(120,100,50,${0.4 + bub * 0.3})`; ctx.fillRect(t.x - 3, t.y - 3, 3, 3); ctx.fillRect(t.x + 3, t.y + 1, 2, 2);
      ctx.fillStyle = 'rgba(200,180,120,0.25)'; ctx.fillRect(x + 6, y + 6, 5, 2);
    } else if (d.arch === 'DOT_AOE') {
      const isFire = d.color === '#ff7b3a';
      const rgb = hexRGB(d.color), lite = shade(d.color, 0.35);
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.10)`; ctx.beginPath(); ctx.arc(t.x, t.y, d.radius, 0, Math.PI * 2); ctx.fill();
      if (isFire) { // ohniště: kameny + polena
        ctx.fillStyle = '#5a5f66'; for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; ctx.fillRect(t.x + Math.cos(a) * 9 - 2, t.y + Math.sin(a) * 9 - 2, 4, 4); }
        ctx.fillStyle = '#4a3018'; ctx.fillRect(t.x - 7, t.y + 2, 14, 3); ctx.fillRect(t.x - 2, t.y - 6, 3, 12);
      } else { ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.5)`; ctx.beginPath(); ctx.arc(t.x, t.y, 9, 0, Math.PI * 2); ctx.fill(); } // louže/kruh
      // plápolání/bublání v barvě pasti (kruh, jed, oheň, kyselina, světlo)
      const fr = mulberry32((animClock * 0.25 | 0) ^ (t.tx * 31 + t.ty * 17));
      for (let k = 0; k < 7; k++) {
        const fx = t.x - 6 + (fr() * 12 | 0), h = (isFire ? 5 : 3) + (fr() * 7 | 0);
        ctx.fillStyle = d.color; ctx.fillRect(fx, t.y - h, 3, h);
        ctx.fillStyle = lite; ctx.fillRect(fx, t.y - h + 2, 3, Math.max(2, h - 4));
      }
      if (fr() < 0.5) particles.push({ x: t.x + (Math.random() - 0.5) * 8, y: t.y - 6, vx: 0, vy: -0.5, life: 0.6, decay: 0.05, size: 2, color: lite, smoke: true });
    }
    if (t.level) drawLevelBadge(t.tx * TILE + TILE - 4, t.ty * TILE + 4);
  }
}
function drawGroundFx() {
  for (const g of groundFx) {
    if (!onScreen(g.x, g.y, g.radius)) continue;
    ctx.fillStyle = 'rgba(255,90,20,.10)'; ctx.beginPath(); ctx.arc(g.x, g.y, g.radius, 0, Math.PI * 2); ctx.fill();
    // hořící zem — rozházené pixelové plamínky
    const fr = mulberry32((animClock * 0.3 | 0) ^ ((g.x | 0) * 13 + (g.y | 0) * 7));
    for (let k = 0; k < 10; k++) {
      const a = fr() * Math.PI * 2, rr = fr() * g.radius, fx = g.x + Math.cos(a) * rr, fy = g.y + Math.sin(a) * rr, h = 4 + (fr() * 6 | 0);
      ctx.fillStyle = '#ff5a10'; ctx.fillRect(fx | 0, (fy - h) | 0, 3, h);
      ctx.fillStyle = '#ffc030'; ctx.fillRect(fx | 0, (fy - h + 2) | 0, 3, Math.max(1, h - 3));
    }
  }
}
function drawWarriors() {
  for (const wr of warriors) {
    if (!onScreen(wr.x, wr.y, wr.r + 20)) continue;
    drawShadow(wr.x, wr.y, wr.r);
    const col = wr.flash > 0 ? '#ffffff' : wr.def.color;
    const ranged = wr.def.arch === 'RANGED';
    drawBlockyHumanoid(wr.x, wr.y, wr.r, wr.aim || -Math.PI / 2, animClock * 0.2, clamp((wr.atkAnim || 0) / 8, 0, 1), {
      skin: '#d8a878', shirt: col, dark: shade(wr.def.color, -0.4), hat: '#c8ccd4', pants: '#3a3444',
      weaponShape: ranged ? 'bow' : (wr.defId === 'rytir_np' ? 'greatsword' : 'sword'),
    });
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(wr.x - 12, wr.y - wr.r - 9, 24, 3);
    ctx.fillStyle = '#5cff8a'; ctx.fillRect(wr.x - 12, wr.y - wr.r - 9, 24 * (wr.hp / wr.hpMax), 3);
  }
}
function drawEnemies() {
  for (const e of enemies) {
    if (!onScreen(e.x, e.y, e.r + 30)) continue;
    const walkAmp = e.arch === 'RUNNER' ? 1 : 0.6;
    const walkPh = animClock * (e.arch === 'RUNNER' ? 0.4 : 0.25) + e.x * 0.1;
    const bob = Math.sin(walkPh) * (e.arch === 'RUNNER' ? 1.6 : 1.0);
    drawShadow(e.x, e.y, e.r);
    if (e.elite) { const g = ELITES[e.elite].glow; ctx.fillStyle = g; ctx.globalAlpha = 0.25 + Math.sin(animClock * 0.2) * 0.1; ctx.beginPath(); ctx.arc(e.x, e.y + bob, e.r + 5, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; }
    // směr „obličeje" = k jádru (zombie se šourají dolů)
    const cx = (CORE.tx + CORE.w / 2) * TILE, cy = (CORE.ty + CORE.h / 2) * TILE;
    const fa = Math.atan2(cy - e.y, cx - e.x);
    const col = e.flash > 0 ? '#ffffff' : e.color;
    const dark = e.flash > 0 ? '#ffffff' : shade(e.color, -0.32);
    const lite = e.flash > 0 ? '#ffffff' : shade(e.color, 0.18);
    ctx.save(); ctx.translate(Math.round(e.x), Math.round(e.y + bob)); ctx.rotate(fa);
    if (e.spawnT > 0) ctx.globalAlpha = 1 - e.spawnT / 30;
    if (e.arch === 'BOSS') drawBossMob(e, col, dark, lite, walkPh);
    else if (e.arch === 'EXPLODER') drawCreeper(e, col, dark, walkPh);
    else if (e.typeId === 'ohar') drawHound(e, col, dark, walkPh);
    else drawZombie(e, col, dark, lite, walkPh);
    ctx.restore(); ctx.globalAlpha = 1;
    if (freezeTimer > 0) { ctx.strokeStyle = '#bfefff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(e.x, e.y + bob, e.r + 2, 0, Math.PI * 2); ctx.stroke(); }
    // HP proužek
    if (e.hp < e.hpMax && e.arch !== 'BOSS') {
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(e.x - e.r, e.y - e.r - 8, e.r * 2, 3);
      ctx.fillStyle = e.elite ? ELITES[e.elite].glow : '#ff8a4a'; ctx.fillRect(e.x - e.r, e.y - e.r - 8, e.r * 2 * (e.hp / e.hpMax), 3);
    }
  }
}
// --- Oblé mob figury (rotovaný rámec, +x = obličej) ---
function drawZombie(e, col, dark, lite, ph) {
  const R = e.r, lp = Math.sin(ph);
  // nohy (capsule)
  rrect(-R * 0.62 + lp * R * 0.24, -R * 0.46, R * 0.4, R * 0.34, R * 0.15, dark);
  rrect(-R * 0.62 - lp * R * 0.24, R * 0.12, R * 0.4, R * 0.34, R * 0.15, dark);
  // trup
  rrect(-R * 0.46, -R * 0.55, R * 0.92, R * 1.1, R * 0.34, dark);
  rrect(-R * 0.38, -R * 0.47, R * 0.76, R * 0.94, R * 0.28, col);
  // ruce natažené dopředu
  const reach = R * 0.72 + Math.sin(ph) * R * 0.06;
  rrect(R * 0.28, -R * 0.5, reach, R * 0.26, R * 0.12, col); rrect(R * 0.28, R * 0.24, reach, R * 0.26, R * 0.12, col);
  ctx.fillStyle = lite; ctx.beginPath(); ctx.arc(R * 0.28 + reach, -R * 0.37, R * 0.15, 0, Math.PI * 2); ctx.arc(R * 0.28 + reach, R * 0.37, R * 0.15, 0, Math.PI * 2); ctx.fill();
  // hlava
  ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, 0, R * 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = lite; ctx.beginPath(); ctx.arc(-R * 0.1, -R * 0.1, R * 0.34, 0, Math.PI * 2); ctx.fill();
  if (e.def && e.def.armored) { ctx.strokeStyle = '#d0d8e0'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, R * 0.5, -0.9, 0.9); ctx.stroke(); }
  ctx.fillStyle = e.arch === 'RANGED' ? '#9dffc0' : '#20140a';
  ctx.beginPath(); ctx.arc(R * 0.24, -R * 0.15, R * 0.1, 0, Math.PI * 2); ctx.arc(R * 0.24, R * 0.15, R * 0.1, 0, Math.PI * 2); ctx.fill();
  if (e.arch === 'RANGED') { ctx.fillStyle = '#2a4a1a'; ctx.beginPath(); ctx.arc(R * 0.38, 0, R * 0.08, 0, Math.PI * 2); ctx.fill(); }
}
function drawCreeper(e, col, dark, ph) {
  const R = e.r, lp = Math.sin(ph * 1.4);
  const green = e.flash > 0 ? '#ffffff' : '#5fbf47', gd = e.flash > 0 ? '#ffffff' : '#3f8a30';
  rrect(-R * 0.58 + lp * R * 0.18, -R * 0.55, R * 0.34, R * 0.34, R * 0.12, gd);
  rrect(-R * 0.58 - lp * R * 0.18, R * 0.22, R * 0.34, R * 0.34, R * 0.12, gd);
  rrect(R * 0.28 - lp * R * 0.18, -R * 0.55, R * 0.34, R * 0.34, R * 0.12, gd);
  rrect(R * 0.28 + lp * R * 0.18, R * 0.22, R * 0.34, R * 0.34, R * 0.12, gd);
  rrect(-R * 0.5, -R * 0.55, R, R * 1.1, R * 0.26, gd);
  rrect(-R * 0.42, -R * 0.47, R * 0.84, R * 0.94, R * 0.2, green);
  ctx.fillStyle = '#12210d';
  rrect(R * 0.03, -R * 0.34, R * 0.2, R * 0.24, R * 0.05); rrect(R * 0.03, R * 0.1, R * 0.2, R * 0.24, R * 0.05);
  rrect(R * 0.26, -R * 0.14, R * 0.15, R * 0.28, R * 0.05);
  const pz = 0.35 + Math.sin(animClock * 0.5) * 0.35;
  ctx.strokeStyle = `rgba(255,120,40,${pz})`; ctx.lineWidth = 2; roundRect(-R * 0.5, -R * 0.55, R, R * 1.1, R * 0.26); ctx.stroke();
}
function drawHound(e, col, dark, ph) {
  const R = e.r, lp = Math.sin(ph);
  const body = e.flash > 0 ? '#ffffff' : '#a05442', bd = e.flash > 0 ? '#ffffff' : '#6e3c2c';
  rrect(-R * 0.3 + lp * R * 0.4, -R * 0.55, R * 0.24, R * 0.4, R * 0.1, bd);
  rrect(-R * 0.3 - lp * R * 0.4, R * 0.15, R * 0.24, R * 0.4, R * 0.1, bd);
  rrect(R * 0.35 - lp * R * 0.4, -R * 0.55, R * 0.24, R * 0.4, R * 0.1, bd);
  rrect(R * 0.35 + lp * R * 0.4, R * 0.15, R * 0.24, R * 0.4, R * 0.1, bd);
  rrect(-R * 0.98, -R * 0.12, R * 0.4, R * 0.24, R * 0.1, bd);           // ocas
  rrect(-R * 0.62, -R * 0.4, R * 1.2, R * 0.8, R * 0.3, bd);            // tělo
  rrect(-R * 0.56, -R * 0.32, R * 1.05, R * 0.64, R * 0.26, body);
  ctx.fillStyle = body; ctx.beginPath(); ctx.arc(R * 0.62, 0, R * 0.42, 0, Math.PI * 2); ctx.fill();  // hlava
  rrect(R * 0.46, -R * 0.62, R * 0.16, R * 0.22, R * 0.05, bd); rrect(R * 0.46, R * 0.4, R * 0.16, R * 0.22, R * 0.05, bd); // uši
  rrect(R * 0.86, -R * 0.16, R * 0.34, R * 0.32, R * 0.1, bd);          // čenich
  ctx.fillStyle = '#ff3a2a'; ctx.beginPath(); ctx.arc(R * 0.6, -R * 0.16, R * 0.08, 0, Math.PI * 2); ctx.arc(R * 0.6, R * 0.16, R * 0.08, 0, Math.PI * 2); ctx.fill();
}
function drawBossMob(e, col, dark, lite, ph) {
  const R = e.r, lp = Math.sin(ph * 0.8), fade = e.spawnT > 0 ? 1 - e.spawnT / 30 : 1;
  ctx.globalAlpha = (0.18 + Math.sin(animClock * 0.1) * 0.07) * fade;
  ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, 0, R * 1.2, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = fade;
  rrect(-R * 0.6 + lp * R * 0.18, -R * 0.5, R * 0.5, R * 0.5, R * 0.18, dark); rrect(-R * 0.6 - lp * R * 0.18, R * 0.0, R * 0.5, R * 0.5, R * 0.18, dark);
  rrect(-R * 0.72, -R * 0.72, R * 1.44, R * 1.5, R * 0.4, dark);
  rrect(-R * 0.6, -R * 0.6, R * 1.2, R * 1.3, R * 0.34, col);
  const reach = R * 0.8 + Math.sin(animClock * 0.15) * R * 0.1;
  rrect(R * 0.3, -R * 0.9, reach, R * 0.42, R * 0.16, col); rrect(R * 0.3, R * 0.48, reach, R * 0.42, R * 0.16, col);
  ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(R * 0.3 + reach, -R * 0.69, R * 0.2, 0, Math.PI * 2); ctx.arc(R * 0.3 + reach, R * 0.69, R * 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = lite; ctx.beginPath(); ctx.arc(0, 0, R * 0.5, 0, Math.PI * 2); ctx.fill();
  // rohy
  ctx.fillStyle = dark; ctx.beginPath(); ctx.moveTo(-R * 0.5, -R * 0.4); ctx.lineTo(-R * 0.66, -R * 0.66); ctx.lineTo(-R * 0.34, -R * 0.5); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-R * 0.5, R * 0.4); ctx.lineTo(-R * 0.66, R * 0.66); ctx.lineTo(-R * 0.34, R * 0.5); ctx.fill();
  ctx.fillStyle = e.def && e.def.final ? '#ffdd33' : '#ff2a1a'; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 8;
  ctx.beginPath(); ctx.arc(R * 0.22, -R * 0.18, R * 0.11, 0, Math.PI * 2); ctx.arc(R * 0.22, R * 0.18, R * 0.11, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
}
// ztmavení/zesvětlení hex barvy
function shade(hex, amt) {
  if (!hex || hex[0] !== '#') return hex;
  let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  r = clamp(Math.round(r + r * amt), 0, 255); g = clamp(Math.round(g + g * amt), 0, 255); b = clamp(Math.round(b + b * amt), 0, 255);
  return `rgb(${r},${g},${b})`;
}
function drawBullets() {
  for (const b of bullets) {
    if (!onScreen(b.x, b.y, 20)) continue;
    const col = b.color || '#ffe08a';
    if (b.thrown) {
      b.spin = (b.spin || 0) + 0.3;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.spin);
      ctx.fillStyle = '#3a2a1a'; ctx.beginPath(); ctx.arc(0, 0, b.r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(-1, -1, b.r * 0.5, 0, Math.PI * 2); ctx.fill();
      // jiskra zápalnice
      ctx.fillStyle = '#ffd35c'; ctx.beginPath(); ctx.arc(b.r * 0.7, -b.r * 0.7, 1.5 + Math.random(), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else if (b.magic) {
      ctx.fillStyle = col; ctx.globalAlpha = 0.4; ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 3, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.7, 0, Math.PI * 2); ctx.fill();
      particles.push({ x: b.x, y: b.y, vx: 0, vy: 0, life: 0.5, decay: 0.08, size: 2, color: col });
    } else {
      // šíp
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.ang != null ? b.ang : Math.atan2(b.vy, b.vx));
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(5, 0); ctx.stroke();
      ctx.fillStyle = '#e8e8e8'; ctx.beginPath(); ctx.moveTo(5, 0); ctx.lineTo(1, -2.5); ctx.lineTo(1, 2.5); ctx.fill(); // hrot
      ctx.strokeStyle = 'rgba(220,220,220,0.8)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(-4, -2); ctx.moveTo(-6, 0); ctx.lineTo(-4, 2); ctx.stroke(); // opeření
      if (b.crit) { ctx.fillStyle = '#ffd35c'; ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
  }
  for (const b of eBullets) {
    ctx.fillStyle = b.color || '#8affb0'; ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 2, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
  }
}
function drawEffects() {
  for (const e of effects) {
    if (e.type === 'swing') {
      // mávnutý klín od postavy (jasně melee, ne projektil)
      const prog = 1 - e.t / 8;
      const a = e.aim - e.spread + prog * 2 * e.spread;   // ostří přejíždí obloukem
      const rad = e.range * 0.9;
      ctx.globalAlpha = clamp(e.t / 8, 0, 0.5);
      ctx.fillStyle = e.color || '#dfe4ec';
      ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.arc(e.x, e.y, rad, e.aim - e.spread, a); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = clamp(e.t / 8, 0, 0.95);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(e.x, e.y, rad, a - 0.18, a + 0.05); ctx.stroke();
      ctx.lineWidth = 1; ctx.lineCap = 'butt'; ctx.globalAlpha = 1;
    } else if (e.type === 'beam') {
      ctx.globalAlpha = clamp(e.t / 6, 0, 0.4); ctx.strokeStyle = e.color || '#9ad0ff'; ctx.lineWidth = 8;
      ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke();
      ctx.globalAlpha = clamp(e.t / 6, 0, 1); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (e.type === 'muzzle') {
      ctx.globalAlpha = clamp(e.t / 4, 0, 1); ctx.fillStyle = '#fff6c0';
      ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(e.a);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(10, -4); ctx.lineTo(14, 0); ctx.lineTo(10, 4); ctx.fill();
      ctx.restore(); ctx.globalAlpha = 1;
    } else if (e.type === 'nova') {
      const prog = 1 - e.t / 24; const rr = Math.max(0, e.rMax * prog);   // rr nesmí být záporný (arc by spadl)
      ctx.globalAlpha = clamp(e.t / 24, 0, 0.7); ctx.strokeStyle = e.color || '#fff'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(e.x, e.y, rr, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
    } else if (e.type === 'text') {
      ctx.globalAlpha = clamp(e.t / 30, 0, 1); ctx.fillStyle = e.color; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(e.txt, e.x, e.y - (30 - e.t) * 0.5); ctx.globalAlpha = 1; ctx.textAlign = 'left';
    }
  }
}
function drawPlayers() {
  const lp = localPlayer();
  for (const p of players) {
    if (p.downed) {
      drawShadow(p.x, p.y, p.r);
      ctx.globalAlpha = 0.3; ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y - Math.sin(animClock * 0.1) * 2, p.r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('✝', p.x, p.y - p.r - 6); ctx.textAlign = 'left';
      continue;
    }
    drawShadow(p.x, p.y, p.r);
    const bob = Math.sin(p.walk) * 1.5;
    const blink = p.inv > 0 && Math.floor(p.inv / 5) % 2;
    // aury schopností
    if (p.shieldT > 0) { ctx.strokeStyle = `rgba(120,200,255,${0.5 + Math.sin(animClock * 0.3) * 0.3})`; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(p.x, p.y + bob, p.r + 6, 0, Math.PI * 2); ctx.stroke(); }
    if (p.rageT > 0) { ctx.fillStyle = `rgba(255,60,40,${0.15 + Math.sin(animClock * 0.4) * 0.1})`; ctx.beginPath(); ctx.arc(p.x, p.y + bob, p.r + 8, 0, Math.PI * 2); ctx.fill(); }
    if (p.buffPower > 0 || p.buffRapid > 0) { ctx.strokeStyle = p.buffPower > 0 ? 'rgba(255,120,230,0.6)' : 'rgba(120,220,255,0.6)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y + bob, p.r + 4, 0, Math.PI * 2); ctx.stroke(); }
    if (isCoop() && p === lp) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(p.x, p.y + bob, p.r + 9, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
    // alchymista: proměna v abominaci — jiné tělo + žíravá aura
    if (p.abomT > 0) { drawAbomination(p.x, p.y + bob, p.r, p.aimAngle, p.walk); continue; }
    if (blink) continue;
    const w0 = WEAPONS[p.weaponId] || {};
    const atk = clamp(p.atkAnim / 10, 0, 1);
    if (p.invisT > 0) ctx.globalAlpha = 0.28;   // zvěd: neviditelnost (poloprůhledný)
    drawBlockyHumanoid(p.x, p.y + bob, p.r, p.aimAngle, p.walk, atk, {
      skin: '#d8a878', shirt: p.color, dark: shade(p.color, -0.4), hat: shade(p.color, 0.22), pants: '#39344f',
      weaponShape: WEAPON_SHAPE[p.weaponId] || (w0.cat === 'melee' ? 'sword' : 'bow'), weaponColor: w0.color,
    });
    ctx.globalAlpha = 1;
    // rytíř: aktivní blok — velký štít napřažený ve směru míření
    if (p.blockT > 0) drawKnightShield(p.x, p.y + bob, p.r, p.aimAngle);
  }
}
// Štít rytíře (vizuál aktivního bloku): kovová deska s bosem, natočená ve směru míření.
function drawKnightShield(x, y, r, ang) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  const d = r * 1.15, w = r * 1.0;
  ctx.fillStyle = '#c8cdd6'; rrect(d, -w * 0.55, r * 0.5, w * 1.1, r * 0.22, '#c8cdd6');
  ctx.strokeStyle = '#8a9099'; ctx.lineWidth = 2; ctx.strokeRect(d, -w * 0.55, r * 0.5, w * 1.1);
  ctx.fillStyle = '#ffd35c'; ctx.beginPath(); ctx.arc(d + r * 0.25, 0, r * 0.16, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = `rgba(150,210,255,${0.5 + Math.sin(animClock * 0.5) * 0.3})`; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, r + 7, ang - 1.1 - ang, ang + 1.1 - ang); ctx.stroke();
  ctx.restore();
}
// Tělo abominace: velké shrbené monstrum s tesáky a leptavou aurou.
function drawAbomination(x, y, r, ang, walk) {
  const R = r * 1.5, lp = Math.sin(walk || 0);
  // žíravá aura
  ctx.fillStyle = `rgba(120,200,60,${0.10 + Math.sin(animClock * 0.3) * 0.05})`;
  ctx.beginPath(); ctx.arc(x, y, ABOM_ACID_RADIUS, 0, Math.PI * 2); ctx.fill();
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  // paže/drápy
  for (const s of [-1, 1]) { rrect(R * 0.1, s * R * 0.5 - R * 0.16, R * 0.7, R * 0.32, R * 0.14, '#6f8a3a'); rrect(R * 0.7, s * R * 0.5 - R * 0.1, R * 0.22, R * 0.2, R * 0.06, '#dfe6c0'); }
  // trup
  rrect(-R * 0.5, -R * 0.6, R * 1.05, R * 1.2, R * 0.34, '#4e6a2c');
  rrect(-R * 0.4, -R * 0.5, R * 0.85, R * 1.0, R * 0.3, '#6f9a3a');
  // boule/nádory
  ctx.fillStyle = '#8fd84a'; for (const o of [[-0.2, -0.3], [0.1, 0.25], [-0.28, 0.2]]) { ctx.beginPath(); ctx.arc(o[0] * R, o[1] * R, R * 0.13, 0, Math.PI * 2); ctx.fill(); }
  // hlava + tesáky + oči
  ctx.fillStyle = '#5e7a30'; ctx.beginPath(); ctx.arc(R * 0.15, 0, R * 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f4f0d0'; for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(R * 0.5, s * R * 0.14); ctx.lineTo(R * 0.72, s * R * 0.05); ctx.lineTo(R * 0.5, s * R * 0.02); ctx.fill(); }
  ctx.fillStyle = '#ffd344'; ctx.beginPath(); ctx.arc(R * 0.3, -R * 0.16, R * 0.09, 0, Math.PI * 2); ctx.arc(R * 0.3, R * 0.16, R * 0.09, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
// Oblá postava shora, natočená ve směru míření (ang): trup, hlava, 2 ruce, 2 nohy.
function drawBlockyHumanoid(x, y, r, ang, walk, atk, pal) {
  const R = r * 1.12; const lp = Math.sin(walk || 0); const sw = atk ? Math.sin(atk * Math.PI) : 0;
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  // NOHY (capsule) — střídavě dopředu/dozadu
  for (const s of [-1, 1]) { const ly = s * R * 0.26, lx = -R * 0.5 + lp * s * R * 0.3; rrect(lx, ly - R * 0.18, R * 0.44, R * 0.36, R * 0.16, pal.pants); }
  // TRUP
  rrect(-R * 0.42, -R * 0.5, R * 0.84, R * 1.0, R * 0.3, pal.dark);
  rrect(-R * 0.34, -R * 0.42, R * 0.68, R * 0.84, R * 0.26, pal.shirt);
  // RUCE (pravá se s útokem napřáhne dopředu)
  const armF = sw * R * 0.55;
  rrect(-R * 0.12, -R * 0.86, R * 0.3, R * 0.34, R * 0.14, pal.shirt); rrect(R * 0.06, -R * 0.86, R * 0.13, R * 0.34, R * 0.1, pal.skin);
  rrect(-R * 0.12 + armF, R * 0.52, R * 0.3, R * 0.34, R * 0.14, pal.shirt); rrect(R * 0.06 + armF, R * 0.52, R * 0.13, R * 0.34, R * 0.1, pal.skin);
  // HLAVA (kruh) + helma (zadní polokoule) + obličej
  ctx.fillStyle = pal.skin; ctx.beginPath(); ctx.arc(0, 0, R * 0.46, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = pal.hat; ctx.beginPath(); ctx.arc(0, 0, R * 0.46, Math.PI * 0.5, Math.PI * 1.5); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.arc(-R * 0.12, -R * 0.14, R * 0.12, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1c1f26'; ctx.beginPath(); ctx.arc(R * 0.25, -R * 0.16, R * 0.08, 0, Math.PI * 2); ctx.arc(R * 0.25, R * 0.16, R * 0.08, 0, Math.PI * 2); ctx.fill();
  drawWeaponBlocky(pal.weaponShape, R, atk, armF, pal.weaponColor);
  ctx.restore();
}
// Design zbraně podle tvaru (od ruky dopředu = +x). g = cílové plátno (default hlavní ctx).
function drawWeaponBlocky(shape, R, atk, armF, wcol, g) {
  g = g || ctx;
  const thrust = sinP(atk) * R * 0.55;
  g.save(); g.translate(R * 0.35 + armF, R * 0.68);
  const wood = '#6a4a2a', dark = '#3a2a1a', steel = '#c8ccd4', steelL = '#eef0f4', gold = '#c8a45c';
  const F = (x) => x + thrust;
  const tri = (x1, y1, x2, y2, x3, y3) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.lineTo(x3, y3); g.fill(); };
  if (shape === 'sword' || shape === 'greatsword') {
    const len = shape === 'greatsword' ? 1.5 : 1.05, wid = shape === 'greatsword' ? 0.26 : 0.18;
    g.fillStyle = wood; g.fillRect(F(-0.15) * R, -R * 0.09, R * 0.28, R * 0.18);
    g.fillStyle = gold; g.fillRect(F(0.08) * R, -R * 0.24, R * 0.1, R * 0.48);
    g.fillStyle = steel; g.fillRect(F(0.16) * R, -R * wid / 2, R * len, R * wid);
    g.fillStyle = steelL; g.fillRect(F(0.16) * R, -R * wid / 2, R * len, R * wid * 0.4);
    g.fillStyle = steel; tri(F(0.16 + len) * R, -R * wid / 2, F(0.16 + len + 0.18) * R, 0, F(0.16 + len) * R, R * wid / 2);
  } else if (shape === 'dagger') {
    g.fillStyle = wood; g.fillRect(F(-0.12) * R, -R * 0.08, R * 0.22, R * 0.16);
    g.fillStyle = gold; g.fillRect(F(0.08) * R, -R * 0.16, R * 0.08, R * 0.32);
    g.fillStyle = steelL; g.fillRect(F(0.14) * R, -R * 0.07, R * 0.5, R * 0.14);
    g.fillStyle = steel; tri(F(0.64) * R, -R * 0.07, F(0.82) * R, 0, F(0.64) * R, R * 0.07);
  } else if (shape === 'axe') {
    g.fillStyle = wood; g.fillRect(F(-0.1) * R, -R * 0.08, R * 1.0, R * 0.16);
    g.fillStyle = steel; g.fillRect(F(0.62) * R, -R * 0.42, R * 0.34, R * 0.84);
    g.fillStyle = steelL; g.fillRect(F(0.62) * R, -R * 0.42, R * 0.12, R * 0.84);
    g.fillStyle = dark; g.fillRect(F(0.9) * R, -R * 0.2, R * 0.08, R * 0.4);
  } else if (shape === 'spear') {
    g.fillStyle = wood; g.fillRect(F(-0.2) * R, -R * 0.06, R * 1.5, R * 0.12);
    g.fillStyle = steel; tri(F(1.3) * R, -R * 0.16, F(1.7) * R, 0, F(1.3) * R, R * 0.16);
    g.fillStyle = steelL; g.fillRect(F(1.3) * R, -R * 0.05, R * 0.3, R * 0.05);
  } else if (shape === 'halberd') {
    g.fillStyle = wood; g.fillRect(F(-0.2) * R, -R * 0.06, R * 1.5, R * 0.12);
    g.fillStyle = steel; tri(F(1.3) * R, -R * 0.14, F(1.66) * R, 0, F(1.3) * R, R * 0.14);
    g.fillStyle = steel; g.fillRect(F(1.0) * R, -R * 0.5, R * 0.32, R * 0.42);
    g.fillStyle = steelL; g.fillRect(F(1.0) * R, -R * 0.5, R * 0.1, R * 0.42);
  } else if (shape === 'scythe') {
    g.fillStyle = wood; g.fillRect(F(-0.15) * R, -R * 0.07, R * 1.25, R * 0.14);
    g.fillStyle = steel; g.fillRect(F(1.0) * R, -R * 0.7, R * 0.14, R * 0.7);
    g.fillStyle = steelL; g.fillRect(F(0.55) * R, -R * 0.7, R * 0.6, R * 0.14);
  } else if (shape === 'mace') {
    g.fillStyle = wood; g.fillRect(F(-0.1) * R, -R * 0.08, R * 0.85, R * 0.16);
    g.fillStyle = steel; g.fillRect(F(0.66) * R, -R * 0.3, R * 0.44, R * 0.6);
    g.fillStyle = dark; g.fillRect(F(0.6) * R, -R * 0.12, R * 0.12, R * 0.24);
    g.fillRect(F(1.06) * R, -R * 0.12, R * 0.12, R * 0.24); g.fillRect(F(0.82) * R, -R * 0.42, R * 0.14, R * 0.12); g.fillRect(F(0.82) * R, R * 0.3, R * 0.14, R * 0.12);
  } else if (shape === 'hammer') {
    g.fillStyle = wood; g.fillRect(F(-0.1) * R, -R * 0.08, R * 0.9, R * 0.16);
    g.fillStyle = steel; g.fillRect(F(0.68) * R, -R * 0.44, R * 0.5, R * 0.88);
    g.fillStyle = steelL; g.fillRect(F(0.68) * R, -R * 0.44, R * 0.16, R * 0.88);
  } else if (shape === 'flail') {
    g.fillStyle = wood; g.fillRect(F(-0.1) * R, -R * 0.08, R * 0.6, R * 0.16);
    g.fillStyle = '#8a8f96'; for (let k = 0; k < 3; k++) g.fillRect(F(0.5 + k * 0.12) * R, -R * 0.05, R * 0.08, R * 0.1);
    g.fillStyle = steel; g.fillRect(F(0.86) * R, -R * 0.26, R * 0.42, R * 0.52);
    g.fillStyle = dark; g.fillRect(F(0.8) * R, -R * 0.08, R * 0.1, R * 0.16); g.fillRect(F(1.24) * R, -R * 0.08, R * 0.1, R * 0.16);
  } else if (shape === 'club') {
    g.fillStyle = dark; g.fillRect(F(-0.15) * R, -R * 0.12, R * 0.5, R * 0.24);
    g.fillStyle = wood; g.fillRect(F(0.35) * R, -R * 0.26, R * 0.7, R * 0.52);
    g.fillStyle = '#5a3a20'; g.fillRect(F(0.6) * R, -R * 0.2, R * 0.1, R * 0.1); g.fillRect(F(0.85) * R, R * 0.05, R * 0.1, R * 0.1);
  } else if (shape === 'bow') {
    g.fillStyle = wood; g.fillRect(R * 0.25, -R * 0.6, R * 0.14, R * 1.2);
    g.fillStyle = wood; g.fillRect(R * 0.15, -R * 0.6, R * 0.14, R * 0.2); g.fillRect(R * 0.15, R * 0.4, R * 0.14, R * 0.2);
    g.strokeStyle = 'rgba(235,235,235,0.85)'; g.lineWidth = 1; g.beginPath(); g.moveTo(R * 0.2, -R * 0.55); g.lineTo(R * 0.32, 0); g.lineTo(R * 0.2, R * 0.55); g.stroke();
    g.fillStyle = steel; g.fillRect(R * 0.32, -R * 0.03, R * 0.5, R * 0.06);
  } else if (shape === 'crossbow') {
    g.fillStyle = wood; g.fillRect(-R * 0.05, -R * 0.1, R * 1.0, R * 0.2);
    g.fillStyle = dark; g.fillRect(R * 0.5, -R * 0.5, R * 0.12, R * 1.0);
    g.fillStyle = steel; g.fillRect(R * 0.6, -R * 0.03, R * 0.5, R * 0.06);
  } else if (shape === 'sling') {
    g.fillStyle = dark; g.fillRect(R * 0.1, -R * 0.4, R * 0.05, R * 0.35); g.fillRect(R * 0.1, R * 0.05, R * 0.05, R * 0.35);
    g.fillStyle = wood; g.fillRect(R * 0.05, -R * 0.12, R * 0.22, R * 0.24);
    g.fillStyle = '#9a9a9a'; g.fillRect(R * 0.1, -R * 0.06, R * 0.12, R * 0.12);
  } else if (shape === 'musket') {
    g.fillStyle = wood; g.fillRect(-R * 0.25, -R * 0.14, R * 0.6, R * 0.28);
    g.fillStyle = '#4a4f55'; g.fillRect(R * 0.3, -R * 0.09, R * 1.05, R * 0.18);
    g.fillStyle = dark; g.fillRect(R * 1.3, -R * 0.11, R * 0.1, R * 0.22);
  } else if (shape === 'bomb') {
    g.fillStyle = '#20242c'; g.beginPath(); g.arc(R * 0.6, 0, R * 0.32, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#4a4f55'; g.beginPath(); g.arc(R * 0.5, -R * 0.12, R * 0.1, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#6a4a2a'; g.fillRect(R * 0.55, -R * 0.44, R * 0.08, R * 0.18);
    g.fillStyle = '#ffd35c'; g.fillRect(R * 0.54, -R * 0.52, R * 0.1, R * 0.1);
  } else { // staff
    g.fillStyle = wood; g.fillRect(-R * 0.1, -R * 0.08, R * 0.95, R * 0.16);
    const c = wcol || '#9ad0ff'; g.fillStyle = c; g.globalAlpha = 0.4; g.beginPath(); g.arc(R * 0.88, 0, R * 0.3, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
    g.beginPath(); g.arc(R * 0.88, 0, R * 0.2, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(R * 0.82, -R * 0.06, R * 0.08, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}
function sinP(a) { return Math.sin((a || 0) * Math.PI); }

/* ---------- Ikony podle skutečných designů (obchod + stavění) ---------- */
function paintIcon(g, k, id, S) {
  g.save();
  if (k === 'weapon') {
    const shape = WEAPON_SHAPE[id] || 'sword', R = S * 0.24;
    g.translate(S * 0.14, S * 0.5 - R * 0.68);
    drawWeaponBlocky(shape, R, 0, 0, (WEAPONS[id] || {}).color, g);
  } else if (k === 'wall') drawWallIcon(g, id, S);
  else if (k === 'trap') drawTrapIcon(g, id, S);
  else if (k === 'warrior') drawWarriorIcon(g, (WARRIORS[id] || {}).color, (WARRIORS[id] || {}).arch === 'RANGED', S);
  else if (k === 'enemy') drawEnemyIcon(g, id, S);
  g.restore();
}
// Ikona nepřítele do bestiáře — stylizované tělo v jeho barvě + rys archetypu.
function drawEnemyIcon(g, id, S) {
  const e = ENEMIES[id] || {}, col = e.color || '#86c15a', c = S / 2;
  const boss = e.arch === 'BOSS';
  const rad = boss ? S * 0.42 : (e.arch === 'TANK' ? S * 0.38 : S * 0.32);
  // tělo (oblý obdélník kreslený přímo na lokální kontext g)
  const bx = c - rad, by = c - rad * 0.9, bw = rad * 2, bh = rad * 1.9, br = rad * 0.5;
  g.fillStyle = col;
  g.beginPath();
  g.moveTo(bx + br, by);
  g.arcTo(bx + bw, by, bx + bw, by + bh, br);
  g.arcTo(bx + bw, by + bh, bx, by + bh, br);
  g.arcTo(bx, by + bh, bx, by, br);
  g.arcTo(bx, by, bx + bw, by, br);
  g.fill();
  // stín/kontura
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(c - rad, c + rad * 0.55, rad * 2, rad * 0.35);
  // oči
  g.fillStyle = boss ? '#ffef8a' : '#f4f4e0';
  const ey = c - rad * 0.15, ex = rad * 0.42;
  g.beginPath(); g.arc(c - ex, ey, S * 0.07, 0, 7); g.arc(c + ex, ey, S * 0.07, 0, 7); g.fill();
  g.fillStyle = '#201812';
  g.beginPath(); g.arc(c - ex, ey, S * 0.035, 0, 7); g.arc(c + ex, ey, S * 0.035, 0, 7); g.fill();
  // archetyp: brnění/koruna/výbuch
  if (e.armored) { g.fillStyle = '#c8ccd4'; g.fillRect(c - rad * 0.7, c - rad * 0.1, rad * 1.4, S * 0.06); }
  if (boss) { g.fillStyle = '#ffd24a'; g.beginPath(); for (let i = -1; i <= 1; i++) { const x = c + i * rad * 0.5; g.moveTo(x - S * 0.05, c - rad * 0.85); g.lineTo(x, c - rad * 1.15); g.lineTo(x + S * 0.05, c - rad * 0.85); } g.fill(); }
  if (e.arch === 'EXPLODER') { g.strokeStyle = '#ff5a2a'; g.lineWidth = 2; g.beginPath(); g.arc(c, c, rad + 3, 0, 7); g.stroke(); }
  if (e.arch === 'RANGED') { g.fillStyle = '#8affb0'; g.beginPath(); g.arc(c + rad * 0.7, c - rad * 0.5, S * 0.06, 0, 7); g.fill(); }
}
function drawWallIcon(g, id, S) {
  const p = S * 0.12, w = S - p * 2;
  if (id === 'drevena_barikada') {
    g.fillStyle = '#7a4f28'; g.fillRect(p, p, w, w);
    g.fillStyle = '#8a5c30'; for (let i = 0; i < 3; i++) g.fillRect(p + 1, p + 2 + i * (w / 3), w - 2, w / 3 - 2);
    g.fillStyle = '#2a1c0e'; [[p + 3, p + 3], [p + w - 5, p + 3], [p + 3, p + w - 5], [p + w - 5, p + w - 5]].forEach(n => g.fillRect(n[0], n[1], 2, 2));
  } else if (id === 'kamenna_zed') {
    g.fillStyle = '#4a4f56'; g.fillRect(p, p, w, w);
    g.fillStyle = '#8a9098'; g.fillRect(p + 1, p + 1, w * 0.5, w * 0.4); g.fillRect(p + w * 0.55, p + 2, w * 0.42, w * 0.34);
    g.fillStyle = '#767c84'; g.fillRect(p + 1, p + w * 0.46, w * 0.4, w * 0.32); g.fillRect(p + w * 0.46, p + w * 0.44, w * 0.5, w * 0.4);
  } else if (id === 'zelezna_brana') {
    g.fillStyle = '#2f343a'; g.fillRect(p, p, w, w);
    g.fillStyle = '#6a7078'; for (let b = 0; b < 3; b++) g.fillRect(p + 2 + b * (w / 3), p + 1, w * 0.16, w);
    g.fillStyle = '#c8ccd4'; [[p + 3, p + 4], [p + w - 5, p + 4], [p + 3, p + w - 6], [p + w - 5, p + w - 6]].forEach(n => g.fillRect(n[0], n[1], 2, 2));
  } else { // bodcova_zed
    g.fillStyle = '#6a4530'; g.fillRect(p + 3, p + 3, w - 6, w - 6);
    g.fillStyle = '#c0c6ce'; for (let k = 0; k < 3; k++) { const t = p + 5 + k * (w - 10) / 2; g.beginPath(); g.moveTo(t, p); g.lineTo(t + 3, p + 5); g.lineTo(t + 6, p); g.fill(); g.beginPath(); g.moveTo(t, p + w); g.lineTo(t + 3, p + w - 5); g.lineTo(t + 6, p + w); g.fill(); }
  }
}
function drawTrapIcon(g, id, S) {
  const c = S / 2, d = TRAPS[id] || {}, arch = d.arch, col = d.color || '#ff7b3a';
  if (arch === 'ONESHOT') {
    g.fillStyle = '#2a2018'; g.fillRect(S * 0.15, S * 0.15, S * 0.7, S * 0.7);
    g.fillStyle = col; for (let k = 0; k < 3; k++) { const x = S * 0.24 + k * S * 0.22; g.beginPath(); g.moveTo(x, S * 0.75); g.lineTo(x + S * 0.08, S * 0.2); g.lineTo(x + S * 0.16, S * 0.75); g.fill(); }
    if (id === 'medvedka' || id === 'cakan') { g.strokeStyle = '#888e96'; g.lineWidth = 2; g.beginPath(); g.arc(c, c, S * 0.3, 0.2, Math.PI - 0.2); g.stroke(); }
  } else if (arch === 'SLOW') {
    g.fillStyle = shade(col, -0.5); g.beginPath(); g.ellipse(c, c, S * 0.36, S * 0.3, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = col; g.globalAlpha = 0.6; g.beginPath(); g.arc(c - 4, c - 3, 3, 0, Math.PI * 2); g.arc(c + 4, c + 2, 2.5, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
  } else if (arch === 'DOT_AOE') {
    g.fillStyle = col; g.globalAlpha = 0.2; g.beginPath(); g.arc(c, c, S * 0.4, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
    if (id === 'ohniste') { g.fillStyle = '#5a5f66'; for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2; g.fillRect(c + Math.cos(a) * S * 0.28 - 2, c + Math.sin(a) * S * 0.28 - 2, 4, 4); } }
    g.fillStyle = col; g.beginPath(); g.moveTo(c - 7, c + 7); g.lineTo(c, c - 10); g.lineTo(c + 7, c + 7); g.fill();
    g.fillStyle = shade(col, 0.4); g.beginPath(); g.moveTo(c - 4, c + 7); g.lineTo(c, c - 3); g.lineTo(c + 4, c + 7); g.fill();
  } else { // EMITTER (věž)
    g.fillStyle = '#5a4326'; g.fillRect(S * 0.2, S * 0.2, S * 0.6, S * 0.6);
    g.fillStyle = '#6e5230'; g.fillRect(S * 0.28, S * 0.28, S * 0.44, S * 0.44);
    g.fillStyle = '#3a2c18'; g.fillRect(c - 2, c - 8, 4, 16); g.fillStyle = col; g.fillRect(c - 8, c - 1.5, 16, 3);
  }
}
function drawWarriorIcon(g, color, ranged, S) {
  const c = S / 2;
  g.fillStyle = '#3a3444'; g.fillRect(c - S * 0.16, c - S * 0.05, S * 0.14, S * 0.3); g.fillRect(c + S * 0.02, c - S * 0.05, S * 0.14, S * 0.3); // nohy
  g.fillStyle = shade(color || '#5c78c8', -0.35); roundRect(c - S * 0.2, c - S * 0.28, S * 0.4, S * 0.42, S * 0.12); g.fill();
  g.fillStyle = color || '#5c78c8'; roundRect(c - S * 0.14, c - S * 0.22, S * 0.28, S * 0.32, S * 0.1); g.fill();
  g.fillStyle = '#d8a878'; g.beginPath(); g.arc(c, c - S * 0.18, S * 0.16, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#c8ccd4'; g.beginPath(); g.arc(c, c - S * 0.18, S * 0.16, Math.PI, Math.PI * 2); g.fill(); // helma
  g.fillStyle = ranged ? '#8a6a3a' : '#c8ccd4';
  if (ranged) { g.fillRect(c + S * 0.18, c - S * 0.24, S * 0.05, S * 0.4); }
  else { g.fillRect(c + S * 0.16, c - S * 0.04, S * 0.22, S * 0.06); g.fillStyle = '#6a4a2a'; g.fillRect(c + S * 0.12, c - S * 0.06, S * 0.06, S * 0.1); }
}
// překreslí <canvas class="ico"> v obchodě podle designů
function paintShopIcons() {
  const list = ovContent.querySelectorAll('canvas.ico');
  list.forEach(cv => { const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height); try { paintIcon(g, cv.dataset.k, cv.dataset.id, cv.width); } catch {} });
}
function ico(k, id) { return `<canvas class="ico" width="34" height="34" data-k="${k}" data-id="${id}"></canvas>`; }

function drawBuildGhost() {
  if (!buildSel) return;
  // ghost pod „posledním dotykem" — použijeme uložený hover
  if (buildHover) {
    const { tx, ty } = buildHover;
    const i = tileIndex(tx, ty);
    let ok = inBounds(tx, ty) && grid.tiles[i] !== 1 && !grid.coreTiles.includes(i);
    if (STRUCTURES[buildSel] || (TRAPS[buildSel] && TRAPS[buildSel].arch === 'EMITTER')) { ok = ok && grid.structures[i] === null; if (STRUCTURES[buildSel]) ok = ok && pathExistsWith(tx, ty); }
    ctx.globalAlpha = 0.35; ctx.fillStyle = ok ? '#5cff8a' : '#ff5c5c';
    roundRect(tx * TILE + 1, ty * TILE + 1, TILE - 2, TILE - 2, 5); ctx.fill();
    ctx.globalAlpha = 0.9;
    const kind = STRUCTURES[buildSel] ? 'wall' : (WARRIORS[buildSel] ? 'warrior' : 'trap');
    ctx.save(); ctx.translate(tx * TILE, ty * TILE); paintIcon(ctx, kind, buildSel, TILE); ctx.restore();
    ctx.globalAlpha = 1;
  }
}
function drawParticles() {
  for (const p of particles) {
    if (!onScreen(p.x, p.y, 30)) continue;
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
  const me = localPlayer() || players[0];
  // horní info
  ctx.fillStyle = '#e8ecd8'; ctx.font = 'bold 15px system-ui'; ctx.textAlign = 'left';
  ctx.fillText('💎 ' + meGems(), 8, 22);
  ctx.fillText('❤ ' + run.lives, 8, 42);
  ctx.textAlign = 'center'; ctx.fillStyle = '#f0e0a0';
  ctx.fillText((wave && wave.boss ? 'BOSS ' : 'VLNA ') + run.wave, W / 2, 20);
  if (state === 'combat' && wave) {
    ctx.fillStyle = 'rgba(0,0,0,.4)'; roundRect(W / 2 - 70, 27, 140, 6, 3); ctx.fill();
    const prog = (wave.total - enemies.length - (wave.total - wave.spawned)) / wave.total;
    ctx.fillStyle = '#5cff8a'; roundRect(W / 2 - 70, 27, 140 * clamp(prog, 0, 1), 6, 3); ctx.fill();
  }
  // combo
  if (state === 'combat' && run.combo >= 3) {
    ctx.textAlign = 'right'; ctx.fillStyle = '#ffd35c'; ctx.font = 'bold 16px system-ui';
    ctx.fillText('x' + run.combo + ' KOMBO', W - 8, 22);
    ctx.fillStyle = 'rgba(255,211,92,0.25)'; ctx.fillRect(W - 108, 27, 100, 4);
    ctx.fillStyle = '#ffd35c'; ctx.fillRect(W - 108, 27, 100 * clamp(run.comboT / 180, 0, 1), 4);
    ctx.textAlign = 'left';
  }
  // boss HP lišta
  const boss = enemies.find(e => e.arch === 'BOSS');
  if (boss) {
    const bw = W - 80, bx = 40, by = 46;
    ctx.fillStyle = 'rgba(0,0,0,.55)'; roundRect(bx, by, bw, 9, 4); ctx.fill();
    ctx.fillStyle = '#ff4a7a'; roundRect(bx, by, bw * clamp(boss.hp / boss.hpMax, 0, 1), 9, 4); ctx.fill();
    ctx.textAlign = 'center'; ctx.fillStyle = '#ffd0dc'; ctx.font = 'bold 11px system-ui';
    ctx.fillText('☠ ' + boss.def.name.toUpperCase(), W / 2, by + 7.5); ctx.textAlign = 'left';
  }
  // HUD pás pozadí
  ctx.fillStyle = '#12160e'; ctx.fillRect(0, VIEWH, W, HUD_H);
  ctx.fillStyle = '#1a2010'; ctx.fillRect(0, VIEWH, W, 2);
  ctx.strokeStyle = '#2a331f'; ctx.beginPath(); ctx.moveTo(0, VIEWH); ctx.lineTo(W, VIEWH); ctx.stroke();

  if (state === 'combat') {
    const w = activeWeapon(me);
    const ammoTxt = w.ammo === 'melee' ? '∞' : (w.ammo === 'mana' ? Math.floor(me.mana) + '⚡' : (run.ammo[w.ammo] || 0));
    drawButton(BTN.weapon, (w.cat === 'melee' ? '🗡 ' : '🏹 ') + w.name, false);
    ctx.fillStyle = (w.ammo !== 'melee' && w.ammo !== 'mana' && (run.ammo[w.ammo] || 0) === 0) ? '#ff7a6a' : '#b0c090';
    ctx.font = '11px system-ui'; ctx.textAlign = 'left';
    ctx.fillText('munice: ' + ammoTxt, BTN.weapon.x + 6, BTN.weapon.y + BTN.weapon.h - 3);
    drawButton(BTN.switch2, '⇄ zbraň', false);
    drawButton(BTN.autoaim, (profile.settings.autoaim ? '🎯 míř' : '🎯 vyp'), profile.settings.autoaim);
    drawButton(BTN.autofire, (profile.settings.autofire ? '🔥 palba' : '🔥 vyp'), profile.settings.autofire);
    drawButton(BTN.pause, '⏸', false);
    drawAbilityButton(me);
    if (w.ammo === 'mana') { ctx.fillStyle = 'rgba(120,180,255,.3)'; ctx.fillRect(BTN.weapon.x, BTN.weapon.y - 5, BTN.weapon.w, 3); ctx.fillStyle = '#8fbaff'; ctx.fillRect(BTN.weapon.x, BTN.weapon.y - 5, BTN.weapon.w * (me.mana / me.manaMax), 3); }
    // HP hráče
    ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(8, VIEWH - 10, W - 16, 5);
    ctx.fillStyle = me.hp < me.hpMax * 0.3 ? '#ff3a3a' : '#ff6a6a'; ctx.fillRect(8, VIEWH - 10, (W - 16) * clamp(me.hp / me.hpMax, 0, 1), 5);
    drawStick(moveStick, '#8fd08f'); drawStick(aimStick, '#f0c060');
  } else if (state === 'build') {
    drawBuildBar();
  }
}
function drawAbilityButton(me) {
  const r = BTN.ability, ab = ABILITIES[me.classId];
  // připravenost + doplňkový popisek podle typu gatingu
  let ready = me.abilityCd <= 0, frac = ab ? Math.max(0, me.abilityCd / ab.cd) : 0, extra = '';
  if (me.classId === 'berserk') { ready = me.clanCd <= 0 && !me._clanActive && me.hp <= me.hpMax * BERSERK_HP_GATE; frac = me.clanCd > 0 ? me.clanCd / CLAN_COOLDOWN : 0; extra = me._clanActive ? 'klan v poli' : (me.hp > me.hpMax * BERSERK_HP_GATE ? '≤50% HP' : ''); }
  else if (me.classId === 'alchymista') { ready = (me.potions || 0) > 0 && me.abomT <= 0; frac = 0; extra = me.abomT > 0 ? Math.ceil(me.abomT / 60) + 's' : '🧪' + (me.potions || 0) + ' (' + (me.bile || 0) + '/' + BILE_PER_POTION + ')'; }
  else if (me.classId === 'knez') { ready = !me.resurrectUsed; frac = 0; extra = me.resurrectUsed ? 'příště v dalším kole' : ''; }
  ctx.fillStyle = ready ? '#3a5a34' : '#241a10';
  roundRect(r.x, r.y, r.w, r.h, 8); ctx.fill();
  ctx.strokeStyle = ready ? '#8fd08f' : '#4a3a2a'; ctx.lineWidth = 1.5; roundRect(r.x, r.y, r.w, r.h, 8); ctx.stroke();
  ctx.fillStyle = ready ? '#e8ecd8' : '#8a7a5a'; ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText((ab ? ab.icon : '✦') + ' ' + (ab ? ab.name : '') + (extra ? ' · ' + extra : ''), r.x + r.w / 2, r.y + r.h / 2);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  if (frac > 0) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(r.x, r.y, r.w * frac, r.h); }
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
  ctx.fillStyle = '#e8ecd8'; ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'left';
  ctx.fillText('💎 ' + meGems() + '  ·  Táhni prstem = posun kamery · Klepni = ' + (upgradeMode ? 'VYLEPŠIT' : (buildSel ? 'postavit' : 'prodat')), 8, VIEWH + 18);
  drawButton(BTN.upgrade, upgradeMode ? '🔧 VYLEPŠIT ✔' : '🔧 Vylepšit', upgradeMode);
  const size = 40, gap = 6; let x = 8, y = VIEWH + 26;
  paletteRects = [];
  for (const id of items) {
    const def = defOf(id);
    const r = { x, y, w: size, h: size, id };
    paletteRects.push(r);
    ctx.fillStyle = buildSel === id ? '#3a5a34' : '#20261c';
    roundRect(x, y, size, size, 6); ctx.fill();
    ctx.strokeStyle = buildSel === id ? '#8fd08f' : '#3a442c'; ctx.lineWidth = 2; roundRect(x, y, size, size, 6); ctx.stroke();
    const kind = STRUCTURES[id] ? 'wall' : (WARRIORS[id] ? 'warrior' : 'trap');
    ctx.save(); ctx.translate(x + 3, y + 2); paintIcon(ctx, kind, id, size - 6); ctx.restore();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'right';
    ctx.fillText('×' + run.owned[id], x + size - 3, y + size - 3);
    x += size + gap;
    if (x + size > W - 140) { x = 8; y += size + gap; }
  }
  if (!items.length) { ctx.fillStyle = '#8a9070'; ctx.font = '12px system-ui'; ctx.fillText('Nemáš co stavět — nakup v obchodu.', 8, VIEWH + 50); }
  const meReady = net.role === 'guest' ? readyGuest : readyHost;
  const label = !isCoop() ? '▶ START VLNY' : (meReady ? '✔ PŘIPRAVEN' : '▶ PŘIPRAVEN?');
  drawButton(BTN.start, label, meReady);
  if (isCoop()) {
    const other = net.role === 'guest' ? readyHost : readyGuest;
    ctx.fillStyle = other ? '#8fd08f' : '#c0a060'; ctx.font = '11px system-ui'; ctx.textAlign = 'right';
    ctx.fillText(other ? 'spoluhráč připraven ✔' : 'spoluhráč staví…', W - 6, VIEWH + 46); ctx.textAlign = 'left';
  }
}
let paletteRects = [];
function drawBanner() {
  ctx.globalAlpha = clamp(banner.t / 40, 0, 1); ctx.textAlign = 'center';
  ctx.fillStyle = banner.warn ? '#ff5c8a' : '#f0e0a0'; ctx.font = 'bold 26px system-ui';
  ctx.fillText(banner.text, W / 2, VIEWH * 0.42);
  ctx.globalAlpha = 1; ctx.textAlign = 'left';
}

/* ============================================================================
   OVLÁDÁNÍ (touch twin-stick + build + klávesnice/myš fallback)
   ========================================================================== */
const moveStick = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
const aimStick = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
let buildHover = null;
let buildPan = null;       // tažení kamery ve fázi stavění
let upgradeMode = false;   // režim vylepšování položených barikád/věží

function evtPos(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return { x: (clientX - r.left) * (W / r.width), y: (clientY - r.top) * (H / r.height) };
}
function hudTap(x, y) {
  if (state === 'combat') {
    if (inRect(x, y, BTN.pause)) { togglePause(); return true; }
    if (inRect(x, y, BTN.autoaim)) { profile.settings.autoaim = !profile.settings.autoaim; saveProfile(profile); return true; }
    if (inRect(x, y, BTN.autofire)) { profile.settings.autofire = !profile.settings.autofire; saveProfile(profile); return true; }
    if (inRect(x, y, BTN.ability)) { localUseAbility(); return true; }
    if (inRect(x, y, BTN.weapon) || inRect(x, y, BTN.switch2)) { localCycleWeapon(); return true; }
    return true; // klik do HUD pásu neřeší stick
  }
  if (state === 'build') {
    if (inRect(x, y, BTN.start)) { toggleReady(); return true; }
    if (inRect(x, y, BTN.upgrade)) { upgradeMode = !upgradeMode; if (upgradeMode) buildSel = null; return true; }
    for (const r of paletteRects) if (inRect(x, y, r)) { buildSel = (buildSel === r.id ? null : r.id); upgradeMode = false; return true; }
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
function localUseAbility() {
  if (net.role === 'guest') { netSend({ t: 'cmd', act: 'ability' }); return; }
  useAbility(players[0]);
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
    if (state === 'build') {
      // dotek v aréně = táhni kamerou; krátký tap (bez pohybu) = akce na dlaždici
      if (!buildPan) { const wp = screenToWorld(pos.x, pos.y); buildHover = tileOf(wp.x, wp.y); buildPan = { id: t.identifier, sx: pos.x, sy: pos.y, camx: camera.x, camy: camera.y, moved: false }; }
      continue;
    }
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
    else if (buildPan && buildPan.id === t.identifier) {
      const dx = pos.x - buildPan.sx, dy = pos.y - buildPan.sy;
      if (Math.hypot(dx, dy) > 6) buildPan.moved = true;
      camera.x = buildPan.camx - dx; camera.y = buildPan.camy - dy; clampCamera();
      const wp = screenToWorld(pos.x, pos.y); buildHover = tileOf(wp.x, wp.y);
    }
  }
}, { passive: false });
canvas.addEventListener('touchend', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (moveStick.id === t.identifier) endStick(moveStick);
    else if (aimStick.id === t.identifier) endStick(aimStick);
    else if (buildPan && buildPan.id === t.identifier) { if (!buildPan.moved) { const wp = screenToWorld(buildPan.sx, buildPan.sy); handleBuildTap(wp.x, wp.y); } buildPan = null; }
  }
}, { passive: false });
canvas.addEventListener('touchcancel', e => {
  for (const t of e.changedTouches) { if (moveStick.id === t.identifier) endStick(moveStick); else if (aimStick.id === t.identifier) endStick(aimStick); else if (buildPan && buildPan.id === t.identifier) buildPan = null; }
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
    if (buildSel) netSend({ t: 'cmd', act: 'place', sel: buildSel, tx, ty });
    else if (upgradeMode) netSend({ t: 'cmd', act: 'upgrade', tx, ty });
    else netSend({ t: 'cmd', act: 'sell', tx, ty });
    return;
  }
  if (buildSel) { placeAt(tx, ty); return; }
  if (upgradeMode) { upgradeAt(tx, ty, localPlayer()); return; }
  sellAt(tx, ty);
}
// Vylepšení položené barikády/věže/pasti (+HP, +poškození). Max Lv.5.
function upgradeAt(tx, ty, p) {
  p = p || localPlayer();
  const i = tileIndex(tx, ty);
  let obj = grid.structures[i] || traps.find(t => t.tx === tx && t.ty === ty);
  if (!obj || obj.temp != null) return;
  const lvl = obj.level || 0; if (lvl >= 5) return;
  const cost = Math.round((obj.def.cost || 60) * 0.55 * Math.pow(1.5, lvl));
  if (p.gems < cost) return;
  p.gems -= cost; obj.level = lvl + 1; obj.up = (obj.up || 1) + 0.35;
  if (obj.hpMax) { obj.hpMax = Math.round(obj.hpMax * 1.45); obj.hp = obj.hpMax; }
  burst(obj.x, obj.y, '#8fd0ff', 12); sfx.buy();
  if (typeof netPush === 'function' && net.role === 'host') netPush();
}

/* ---------- Klávesnice + myš (desktop) ---------- */
const keys = {};
window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase(); keys[k] = true;
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
  if (k === 'p') togglePause();
  if (k === 'm') { muted = !muted; profile.settings.muted = muted; saveProfile(profile); if (!muted) initAudio(); }
  if (k === 'q' && run) localCycleWeapon();
  if (k === 'e' && run) localUseAbility();
});
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
canvas.addEventListener('mousemove', e => {
  const pos = evtPos(e.clientX, e.clientY);
  const lp = localPlayer();
  const wp = screenToWorld(pos.x, pos.y);
  if (state === 'combat' && lp) { myInput.aimAngle = Math.atan2(wp.y - lp.y, wp.x - lp.x); if (mouseDown) myInput.aiming = true; }
  if (state === 'build') {
    buildHover = tileOf(wp.x, wp.y);
    if (buildPan && buildPan.id === 'mouse') { const dx = pos.x - buildPan.sx, dy = pos.y - buildPan.sy; if (Math.hypot(dx, dy) > 6) buildPan.moved = true; camera.x = buildPan.camx - dx; camera.y = buildPan.camy - dy; clampCamera(); }
  }
});
canvas.addEventListener('mousedown', e => {
  initAudio(); const pos = evtPos(e.clientX, e.clientY);
  if (state === 'paused') { togglePause(); return; }
  if (!inArena(pos.y)) { hudTap(pos.x, pos.y); return; }
  if (state === 'build') { buildPan = { id: 'mouse', sx: pos.x, sy: pos.y, camx: camera.x, camy: camera.y, moved: false }; return; }
  if (state === 'combat') myInput.aiming = true;
});
canvas.addEventListener('mouseup', () => {
  if (buildPan && buildPan.id === 'mouse') { if (!buildPan.moved) { const wp = screenToWorld(buildPan.sx, buildPan.sy); handleBuildTap(wp.x, wp.y); } buildPan = null; }
  myInput.aiming = false;
});
// Posun kamery šipkami/WASD ve fázi stavění.
function buildCamKeys(dt) {
  const sp = 8 * dt; let mx = 0, my = 0;
  if (keys['a'] || keys['arrowleft']) mx -= sp; if (keys['d'] || keys['arrowright']) mx += sp;
  if (keys['w'] || keys['arrowup']) my -= sp; if (keys['s'] || keys['arrowdown']) my += sp;
  if (mx || my) { camera.x += mx; camera.y += my; clampCamera(); }
}
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
    if (state === 'build') buildCamKeys(dt);   // šipky posouvají kameru při stavění
    if (net.role === 'guest') {
      // guest nepočítá simulaci — jen posílá vstup, žene lokální kosmetiku a vykresluje
      if (state === 'combat') keyboardMove();
      if (typeof netSendInput === 'function') netSendInput();
      animClock += dt;
      if (state === 'combat') { updateParticles(dt); updateFloaters(dt); if (shake > 0) shake = Math.max(0, shake - 0.5 * dt); if (flash > 0) flash = Math.max(0, flash - 0.05 * dt); }
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
loadMap(0);
fitCanvas();
setState('menu');
requestAnimationFrame(loop);

// Service worker (PWA)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
