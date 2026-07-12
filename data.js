/* ============================================================================
   RYTÍŘI A NEMRTVÍ — datové tabulky (obsah hry)
   Vše je čisté „data": zbraně/nepřátelé/… = archetyp + statblok.
   Enginu (engine.js) i logice (game.js) stačí číst tyhle globální konstanty.
   ========================================================================== */

/* ---------- Mapa / aréna ---------- */
const TILE = 32;
const HUD_H = 96;                 // spodní pás s ovládáním
const VIEWW = 480;               // viditelné okno (šířka obrazovky)
const VIEWH = 704;               // viditelné okno (výška nad HUD)
// Rozměry AKTUÁLNÍ mapy (nastavuje applyMapDims / loadMap). Mohou být větší než okno → kamera scrolluje.
let COLS = 16, ROWS = 24;
let ARENA_W = COLS * TILE, ARENA_H = ROWS * TILE;
let CORE = { tx: 6, ty: 21, w: 3, h: 2 };
let SPAWNS = [];
let OBSTACLES = [];
let currentMap = 0;

/* ---------- 15 map / biomů (poslední = peklo s finálním bossem) ---------- */
// pal: [tráva1, tráva2, skála, akcent, mlha/overlay], fog = průhledná barva navrch
const MAPS = [
  { name: 'Zelená louka',    cols: 16, rows: 24, seed: 101, pal: ['#284020', '#2c4224', '#5a5f66', '#3f7030'], fog: null },
  { name: 'Temný les',       cols: 16, rows: 26, seed: 202, pal: ['#1f3018', '#24381c', '#4a4f46', '#2c5024'], fog: 'rgba(10,20,10,0.18)' },
  { name: 'Starý hřbitov',   cols: 17, rows: 26, seed: 303, pal: ['#2a2e28', '#30352d', '#6a6f78', '#4a5a4a'], fog: 'rgba(30,30,40,0.2)' },
  { name: 'Hnilobná bažina', cols: 17, rows: 27, seed: 404, pal: ['#24301e', '#2a3820', '#4a4a3a', '#3a5a2a'], fog: 'rgba(40,50,20,0.22)' },
  { name: 'Zříceniny',       cols: 18, rows: 27, seed: 505, pal: ['#3a3630', '#403c34', '#7a756a', '#5a5040'], fog: null },
  { name: 'Zamrzlá pláň',    cols: 18, rows: 28, seed: 606, pal: ['#a8c0d0', '#b8ccda', '#8a98a6', '#cfe0ec'], fog: 'rgba(200,225,245,0.15)' },
  { name: 'Spálená poušť',   cols: 19, rows: 28, seed: 707, pal: ['#b89a5a', '#c2a666', '#9a7a4a', '#d8bc7a'], fog: 'rgba(230,200,120,0.12)' },
  { name: 'Temná jeskyně',   cols: 19, rows: 29, seed: 808, pal: ['#20242a', '#262b32', '#3a4048', '#4a4050'], fog: 'rgba(0,0,10,0.32)' },
  { name: 'Prokleté pole',   cols: 20, rows: 29, seed: 909, pal: ['#2a2420', '#302a24', '#5a504a', '#5a3a5a'], fog: 'rgba(40,20,40,0.22)' },
  { name: 'Sopečná stráň',   cols: 20, rows: 30, seed: 111, pal: ['#3a2620', '#42281f', '#5a4038', '#8a3a20'], fog: 'rgba(60,20,10,0.2)' },
  { name: 'Kostěná pustina', cols: 21, rows: 30, seed: 121, pal: ['#3a3830', '#403e36', '#c8c0a8', '#8a8270'], fog: 'rgba(50,45,35,0.18)' },
  { name: 'Stínový hvozd',   cols: 21, rows: 31, seed: 131, pal: ['#181c20', '#1e2228', '#3a3040', '#40206a'], fog: 'rgba(20,10,40,0.3)' },
  { name: 'Krvavé bažiny',   cols: 22, rows: 31, seed: 141, pal: ['#2a1a1a', '#301e1e', '#5a3a3a', '#7a2020'], fog: 'rgba(60,10,10,0.24)' },
  { name: 'Brána podsvětí',  cols: 22, rows: 32, seed: 151, pal: ['#241820', '#2a1c26', '#4a3040', '#6a2050'], fog: 'rgba(50,10,40,0.28)' },
  { name: 'Peklo',           cols: 23, rows: 34, seed: 161, pal: ['#3a1410', '#461812', '#6a2a1a', '#ff5a20'], fog: 'rgba(90,15,5,0.26)', hell: true },
];
const NUM_MAPS = MAPS.length;
const WAVES_PER_MAP = 5;                 // každá mapa = 5 vln, 5. vlna = boss = konec mapy
const FINAL_WAVE = NUM_MAPS * WAVES_PER_MAP;  // 75
function mapForWave(wave) { return Math.min(NUM_MAPS - 1, Math.floor((Math.max(1, wave) - 1) / WAVES_PER_MAP)); }
function isMapEndWave(wave) { return wave % WAVES_PER_MAP === 0; }   // boss vlna = konec mapy
function isFinalWave(wave) { return wave >= FINAL_WAVE; }

// Nastaví rozměry, jádro a spawny podle mapy (bez generování překážek – to dělá loadMap v engine).
function applyMapDims(i) {
  const m = MAPS[clampIdx(i)];
  COLS = m.cols; ROWS = m.rows;
  ARENA_W = COLS * TILE; ARENA_H = ROWS * TILE;
  CORE = { tx: Math.floor(COLS / 2) - 1, ty: ROWS - 3, w: 3, h: 2 };   // dolní střed
  // spawny: horní hrana (3 body) + boky
  SPAWNS = [
    { x: COLS * TILE * 0.2, y: -20 }, { x: COLS * TILE * 0.5, y: -20 }, { x: COLS * TILE * 0.8, y: -20 },
    { x: -20, y: ROWS * TILE * 0.25 }, { x: ARENA_W + 20, y: ROWS * TILE * 0.25 },
    { x: -20, y: ROWS * TILE * 0.5 }, { x: ARENA_W + 20, y: ROWS * TILE * 0.5 },
  ];
}
function clampIdx(i) { return Math.max(0, Math.min(NUM_MAPS - 1, i)); }
applyMapDims(0);

/* ---------- Munice (nakupuje se ve shopu; 'melee' a 'mana' se neřeší) ---------- */
const AMMO = {
  sip:    { name: 'Šípy',          bundle: 30, cost: 20, color: '#c9b072' },
  sipka:  { name: 'Šipky',         bundle: 20, cost: 26, color: '#b8b8c0' },
  kamen:  { name: 'Kameny',        bundle: 40, cost: 14, color: '#9a9a9a' },
  vrh:    { name: 'Vrhací zbraně', bundle: 15, cost: 24, color: '#c88a55' },
  prach:  { name: 'Střelný prach', bundle: 12, cost: 34, color: '#6a6a6a' },
  bomba:  { name: 'Bomby',         bundle: 6,  cost: 42, color: '#d05050' },
};

/* ---------- Zbraně ---------- */
/* Archetypy: MELEE_SWING | PROJECTILE | HITSCAN | THROWN_AOE | MULTISHOT
   Pole: dmg, range(px), rate(framy mezi výstřely), spread(rad),
         projSpeed, pierce, aoeRadius, dot{dps,dur}, slow{mul,dur}, chain,
         knockback, shots(multishot), ammo, ammoPerShot, tier, unlock(úroveň),
         cost(gemy), cat('melee'|'ranged'), color                                */
const WEAPONS = {
  /* ===== NABLÍZKO (11) ===== */
  rezavy_mec:      { name:'Rezavý meč',      arch:'MELEE_SWING', dmg:9,  range:46, rate:24, spread:0.9,  knockback:4, ammo:'melee', tier:0, unlock:1, cost:0,   cat:'melee', color:'#c7cdd6' },
  dyka:            { name:'Dýka',            arch:'MELEE_SWING', dmg:6,  range:36, rate:12, spread:0.6,  knockback:2, ammo:'melee', tier:1, unlock:1, cost:45,  cat:'melee', color:'#d6d6de' },
  sekera:          { name:'Sekera',          arch:'MELEE_SWING', dmg:15, range:48, rate:32, spread:0.8,  knockback:6, ammo:'melee', tier:1, unlock:2, cost:75,  cat:'melee', color:'#b0a080' },
  kopi:            { name:'Kopí',            arch:'MELEE_SWING', dmg:12, range:74, rate:28, spread:0.35, knockback:5, ammo:'melee', tier:2, unlock:3, cost:95,  cat:'melee', color:'#c2b59b' },
  kosa:            { name:'Kosa',            arch:'MELEE_SWING', dmg:13, range:54, rate:34, spread:1.7,  knockback:3, ammo:'melee', tier:2, unlock:4, cost:120, cat:'melee', color:'#b8c0c8' },
  palcat:          { name:'Palcát',          arch:'MELEE_SWING', dmg:17, range:44, rate:34, spread:0.7,  knockback:8, ammo:'melee', tier:2, unlock:4, cost:130, cat:'melee', color:'#9aa0a8' },
  remdih:          { name:'Řemdih',          arch:'MELEE_SWING', dmg:16, range:52, rate:30, spread:1.1,  knockback:7, ammo:'melee', tier:3, unlock:5, cost:150, cat:'melee', color:'#8f9298' },
  kyj:             { name:'Kyj',             arch:'MELEE_SWING', dmg:20, range:46, rate:40, spread:0.9,  knockback:9, ammo:'melee', tier:2, unlock:3, cost:110, cat:'melee', color:'#7a5a3a' },
  halapartna:      { name:'Halapartna',      arch:'MELEE_SWING', dmg:19, range:80, rate:38, spread:0.5,  knockback:7, ammo:'melee', tier:3, unlock:6, cost:185, cat:'melee', color:'#c2b59b' },
  valecne_kladivo: { name:'Válečné kladivo', arch:'MELEE_SWING', dmg:28, range:50, rate:50, spread:0.8,  knockback:12,ammo:'melee', tier:3, unlock:7, cost:220, cat:'melee', color:'#8a8f96' },
  obour_mec:       { name:'Obouruční meč',   arch:'MELEE_SWING', dmg:24, range:58, rate:46, spread:1.15, knockback:8, ammo:'melee', tier:3, unlock:6, cost:200, cat:'melee', color:'#d2d8e0' },

  /* ===== NA DÁLKU (18) ===== */
  kratky_luk:    { name:'Krátký luk',    arch:'PROJECTILE', dmg:9,  range:300, rate:22, projSpeed:9.5, pierce:0, ammo:'sip',   ammoPerShot:1, tier:1, unlock:1, cost:60,  cat:'ranged', color:'#c9b072' },
  dlouhy_luk:    { name:'Dlouhý luk',    arch:'PROJECTILE', dmg:16, range:420, rate:36, projSpeed:12,  pierce:1, ammo:'sip',   ammoPerShot:1, tier:2, unlock:3, cost:125, cat:'ranged', color:'#b89a52' },
  ohnivy_sip:    { name:'Ohnivý šíp',    arch:'PROJECTILE', dmg:12, range:340, rate:32, projSpeed:11,  pierce:0, dot:{dps:8,dur:120},  ammo:'sip', ammoPerShot:1, tier:2, unlock:5, cost:155, cat:'ranged', color:'#ff8a3a' },
  kuse:          { name:'Kuše',          arch:'PROJECTILE', dmg:24, range:360, rate:50, projSpeed:14,  pierce:1, ammo:'sipka', ammoPerShot:1, tier:2, unlock:2, cost:115, cat:'ranged', color:'#b8b8c0' },
  tezka_kuse:    { name:'Těžká kuše',    arch:'PROJECTILE', dmg:40, range:400, rate:70, projSpeed:15,  pierce:2, knockback:6, ammo:'sipka', ammoPerShot:1, tier:3, unlock:6, cost:210, cat:'ranged', color:'#a0a0aa' },
  jedovata_kuse: { name:'Jedovatá kuše', arch:'PROJECTILE', dmg:14, range:340, rate:44, projSpeed:12,  pierce:0, dot:{dps:12,dur:180}, ammo:'sipka', ammoPerShot:1, tier:3, unlock:5, cost:170, cat:'ranged', color:'#7ad06a' },
  balista:       { name:'Balista',       arch:'PROJECTILE', dmg:55, range:460, rate:90, projSpeed:16,  pierce:4, knockback:8, ammo:'sipka', ammoPerShot:2, tier:3, unlock:8, cost:300, cat:'ranged', color:'#8a7a5a' },
  opakovaci_kuse:{ name:'Opakovací kuše',arch:'MULTISHOT',  dmg:7,  range:260, rate:30, projSpeed:11, spread:0.32, shots:3, pierce:0, ammo:'sipka', ammoPerShot:3, tier:3, unlock:5, cost:205, cat:'ranged', color:'#c0c0c8' },
  prak:          { name:'Prak',          arch:'PROJECTILE', dmg:7,  range:260, rate:20, projSpeed:10,  pierce:0, ammo:'kamen', ammoPerShot:1, tier:1, unlock:1, cost:50,  cat:'ranged', color:'#9a9a9a' },
  ostep:         { name:'Oštěp',         arch:'PROJECTILE', dmg:22, range:300, rate:40, projSpeed:12,  pierce:2, knockback:6, ammo:'vrh', ammoPerShot:1, tier:2, unlock:3, cost:120, cat:'ranged', color:'#c2b59b' },
  vrhaci_nuz:    { name:'Vrhací nůž',    arch:'PROJECTILE', dmg:8,  range:240, rate:14, projSpeed:12,  pierce:0, ammo:'vrh', ammoPerShot:1, tier:1, unlock:1, cost:55,  cat:'ranged', color:'#d6d6de' },
  vrhaci_sekera: { name:'Vrhací sekera', arch:'PROJECTILE', dmg:18, range:260, rate:34, projSpeed:10,  pierce:1, knockback:5, ammo:'vrh', ammoPerShot:1, tier:2, unlock:4, cost:140, cat:'ranged', color:'#b0a080' },
  musketa:       { name:'Ruční mušketa', arch:'HITSCAN',    dmg:36, range:380, rate:70, knockback:5, ammo:'prach', ammoPerShot:1, tier:3, unlock:7, cost:240, cat:'ranged', color:'#6a6a6a' },
  bomba:         { name:'Bomba',         arch:'THROWN_AOE', dmg:42, range:220, rate:80, projSpeed:6.5, aoeRadius:66, ammo:'bomba', ammoPerShot:1, tier:2, unlock:4, cost:160, cat:'ranged', color:'#d05050' },
  recky_ohen:    { name:'Řecký oheň',    arch:'THROWN_AOE', dmg:14, range:210, rate:90, projSpeed:6,   aoeRadius:74, dot:{dps:16,dur:180}, ammo:'bomba', ammoPerShot:1, tier:3, unlock:6, cost:225, cat:'ranged', color:'#ff6a2a' },
  blesk_hul:     { name:'Blesková hůl',  arch:'HITSCAN',    dmg:18, range:320, rate:40, chain:3, ammo:'mana', ammoPerShot:8,  tier:3, unlock:5, cost:230, cat:'ranged', color:'#9ad0ff' },
  ohniva_hul:    { name:'Ohnivá hůl',    arch:'THROWN_AOE', dmg:22, range:240, rate:56, projSpeed:7, aoeRadius:70, dot:{dps:10,dur:120}, ammo:'mana', ammoPerShot:12, tier:3, unlock:6, cost:260, cat:'ranged', color:'#ff7b3a' },
  mraziva_hul:   { name:'Mrazivá hůl',   arch:'PROJECTILE', dmg:12, range:300, rate:30, projSpeed:10, pierce:1, slow:{mul:0.45,dur:120}, ammo:'mana', ammoPerShot:6, tier:3, unlock:5, cost:240, cat:'ranged', color:'#8fe0ff' },
};

// Vizuální tvar každé zbraně (kreslí se blokově, viz drawWeaponBlocky).
const WEAPON_SHAPE = {
  rezavy_mec: 'sword', dyka: 'dagger', sekera: 'axe', kopi: 'spear', kosa: 'scythe',
  palcat: 'mace', remdih: 'flail', kyj: 'club', halapartna: 'halberd',
  valecne_kladivo: 'hammer', obour_mec: 'greatsword',
  kratky_luk: 'bow', dlouhy_luk: 'bow', ohnivy_sip: 'bow',
  kuse: 'crossbow', tezka_kuse: 'crossbow', jedovata_kuse: 'crossbow', opakovaci_kuse: 'crossbow', balista: 'crossbow',
  prak: 'sling', ostep: 'spear', vrhaci_nuz: 'dagger', vrhaci_sekera: 'axe',
  musketa: 'musket', bomba: 'bomb', recky_ohen: 'bomb',
  blesk_hul: 'staff', ohniva_hul: 'staff', mraziva_hul: 'staff',
};

/* ---------- Nepřátelé (nemrtví) ---------- */
/* Archetypy: WALKER | RUNNER | TANK | RANGED | EXPLODER | BOSS
   Runtime staty = base × škálování(wave). */
const ENEMIES = {
  chodec:    { name:'Chodec',    arch:'WALKER',   hp:20,  speed:0.7, dmg:6,  atkRate:40, size:24, bounty:4,  score:10,  leak:1, color:'#7ea06a' },
  behac:     { name:'Běhač',     arch:'RUNNER',   hp:13,  speed:1.7, dmg:5,  atkRate:28, size:20, bounty:5,  score:15,  leak:1, color:'#c9b04a' },
  ohar:      { name:'Ohař',      arch:'RUNNER',   hp:10,  speed:2.3, dmg:7,  atkRate:24, size:18, bounty:6,  score:18,  leak:1, color:'#9a3a3a' },
  obr:       { name:'Obr',       arch:'TANK',     hp:110, speed:0.42,dmg:16, atkRate:60, size:40, bounty:14, score:45,  leak:2, color:'#8a5a3a' },
  brnenec:   { name:'Brněnec',   arch:'TANK',     hp:70,  speed:0.6, dmg:12, atkRate:50, size:30, bounty:12, score:40,  leak:1, color:'#6a7a8a', armored:true },
  plivac:    { name:'Plivač',    arch:'RANGED',   hp:18,  speed:0.5, dmg:7,  atkRate:90, size:24, bounty:8,  score:25,  leak:1, color:'#5a8a6a', projSpeed:4.2, keepDist:170 },
  vybusny:   { name:'Výbušný',   arch:'EXPLODER', hp:16,  speed:1.15,dmg:34, atkRate:0,  size:26, bounty:10, score:30,  leak:1, color:'#b04a4a', aoeRadius:72 },
  // Bossové (cyklují se – viz bossForWave)
  nekromant: { name:'Nekromant', arch:'BOSS',     hp:650, speed:0.55,dmg:24, atkRate:70, size:52, bounty:140,score:600, leak:5, color:'#7a3a9a', summon:'chodec', summonRate:200 },
  abominace: { name:'Abominace', arch:'BOSS',     hp:1100,speed:0.4, dmg:34, atkRate:60, size:66, bounty:200,score:800, leak:6, color:'#6a4a2a', enrage:true },
  lich:      { name:'Lich',      arch:'BOSS',     hp:820, speed:0.5, dmg:20, atkRate:55, size:50, bounty:220,score:900, leak:5, color:'#3a6a8a', summon:'behac', summonRate:170, volley:true },
  pekelny_pan:{name:'Pekelný pán',arch:'BOSS',    hp:3200,speed:0.5, dmg:44, atkRate:45, size:80, bounty:1000,score:5000,leak:20,color:'#ff3a10', summon:'vybusny', summonRate:120, volley:true, enrage:true, final:true },
};
const BOSS_CYCLE = ['nekromant', 'abominace', 'lich'];
function bossForWave(wave) {
  if (isFinalWave(wave)) return 'pekelny_pan';
  return BOSS_CYCLE[(Math.floor(wave / 5) - 1) % BOSS_CYCLE.length];
}

/* ---------- Elitní přídomky (náhodně na běžných nepřátelích od pozdějších vln) ---------- */
const ELITES = {
  rychly:      { name:'Rychlý',      hpMul:1.3, spdMul:1.6, dmgMul:1.1, glow:'#5cf0ff' },
  pancerovany: { name:'Pancéřovaný', hpMul:2.6, spdMul:0.9, dmgMul:1.4, glow:'#c0c8d0' },
  zhoubny:     { name:'Zhoubný',     hpMul:1.6, spdMul:1.1, dmgMul:1.3, glow:'#c060ff', explode:true },
};
const ELITE_KEYS = Object.keys(ELITES);
function eliteChance(wave) { return wave < 3 ? 0 : Math.min(0.22, 0.04 + wave * 0.012); }

/* ---------- Dočasné dropy (padají z nepřátel; elita dropne vždy) ---------- */
const DROPS = {
  rapid:  { name:'Rychlopalba', icon:'»', color:'#5cd8ff', dur:480, kind:'buff' },
  power:  { name:'Síla',        icon:'★', color:'#ff7be5', dur:480, kind:'buff' },
  freeze: { name:'Mráz',        icon:'❄', color:'#8fe0ff', kind:'freeze' },
  heal:   { name:'Léčení',      icon:'✚', color:'#5cff8a', kind:'heal' },
  truhla: { name:'Truhla',      icon:'💰', color:'#ffd35c', kind:'gems', gems:40 },
};
const DROP_WEIGHTS = { rapid: 5, power: 5, freeze: 3, heal: 4, truhla: 3 };
// Škálování dle čísla vlny (kampaň má 75 vln přes 15 map → mírnější + stropy):
function enemyScale(wave) {
  return {
    hp:  Math.min(9, 1 + 0.09 * (wave - 1)),
    spd: Math.min(1.7, 1 + 0.02 * (wave - 1)),
    dmg: Math.min(4, 1 + 0.05 * (wave - 1)),
  };
}
// Váhy výskytu typů podle vlny (boss řešen zvlášť: každá 5. vlna).
function waveComposition(wave) {
  const w = { chodec: 1 };
  if (wave >= 2) w.behac   = 0.25 + Math.min(0.4, wave * 0.03);
  if (wave >= 3) w.ohar    = 0.12 + Math.min(0.35, (wave - 3) * 0.03);
  if (wave >= 4) w.obr     = 0.12 + Math.min(0.3, (wave - 4) * 0.03);
  if (wave >= 4) w.brnenec = 0.10 + Math.min(0.28, (wave - 4) * 0.025);
  if (wave >= 5) w.plivac  = 0.15 + Math.min(0.3, (wave - 5) * 0.025);
  if (wave >= 6) w.vybusny = 0.12 + Math.min(0.3, (wave - 6) * 0.03);
  return w;
}
function isBossWave(wave) { return wave % 5 === 0; }
// Kolik nepřátel v dané vlně (se stropem, ať se to dá zvládnout)
function waveCount(wave) { return Math.min(36, 8 + Math.floor(wave * 1.3)); }

/* ---------- Pasti ---------- */
/* Archetypy: ONESHOT | SLOW | DOT_AOE | EMITTER */
const TRAPS = {
  bodce:     { name:'Bodce',     arch:'ONESHOT', dmg:50, charges:3, cost:40,  color:'#b8b8c0', cat:'trap' },
  smola:     { name:'Smola',     arch:'SLOW',    slow:{mul:0.4}, hp:70,  cost:55,  color:'#3a3320', cat:'trap' },
  ohniste:   { name:'Ohniště',   arch:'DOT_AOE', dps:12, radius:52, dur:600, cost:70, color:'#ff7b3a', cat:'trap' },
  samostril: { name:'Samostříl', arch:'EMITTER', dmg:11, range:210, rate:38, projSpeed:10, hp:90, cost:120, color:'#8a7a5a', cat:'trap' },
  balista_v: { name:'Věž s balistou', arch:'EMITTER', dmg:28, range:300, rate:80, projSpeed:15, pierce:3, hp:130, cost:220, color:'#7a6a4a', cat:'trap' },
};

/* ---------- Zdi / stavby (blokují pohyb + mají HP) ---------- */
const STRUCTURES = {
  drevena_barikada: { name:'Dřevěná barikáda', hp:120, cost:30,  color:'#8a5a34', blocksProj:false, cat:'wall' },
  kamenna_zed:      { name:'Kamenná zeď',      hp:320, cost:70,  color:'#8a8f96', blocksProj:true,  cat:'wall' },
  zelezna_brana:    { name:'Železná brána',    hp:230, cost:95,  color:'#6a6f78', blocksProj:true,  cat:'wall', gate:true },
  bodcova_zed:      { name:'Bodcová zeď',      hp:170, cost:115, color:'#9a5a5a', blocksProj:false, cat:'wall', contactDmg:6 },
};

/* ---------- Váleční spojenci (jednoduchá AI) ---------- */
/* Archetypy: MELEE | RANGED */
const WARRIORS = {
  mecenos:  { name:'Mečenoš',   arch:'MELEE',  hp:90,  dmg:11, range:42,  rate:26, speed:1.2, seek:220, cost:100, color:'#5c78c8', cat:'warrior' },
  lucistnik:{ name:'Lučištník', arch:'RANGED', hp:55,  dmg:9,  range:300, rate:34, speed:1.0, seek:320, cost:130, color:'#5cb87a', projSpeed:11, cat:'warrior' },
  rytir_np: { name:'Rytíř',     arch:'MELEE',  hp:200, dmg:15, range:46,  rate:30, speed:0.9, seek:200, cost:210, color:'#c8a45c', cat:'warrior' },
};

/* ---------- Třídy (8) ---------- */
/* Mění: startovní výbavu (start = vlastněné zbraně), startGems, hpMod, spdMod,
   costMul{melee,ranged,trap,wall,warrior,ammo}, passive{…} (viz game.js). */
const CLASSES = {
  rytir: {
    name:'Rytíř', icon:'⚔', color:'#c8a45c', desc:'Odolný boj zblízka, štít a levné meče.',
    start:['rezavy_mec'], startGems:130, hpMod:1.4, spdMod:0.95,
    costMul:{ melee:0.8, ranged:1, trap:1, wall:1, warrior:1, ammo:1 },
    passive:{ meleeDmg:1.15, block:0.12 },
  },
  lovec: {
    name:'Lovec', icon:'🏹', color:'#5cb87a', desc:'Mistr dálkového boje, delší dostřel a levná munice.',
    start:['rezavy_mec','kratky_luk'], startGems:130, hpMod:1.0, spdMod:1.1,
    costMul:{ melee:1, ranged:0.8, trap:1, wall:1, warrior:1, ammo:0.7 },
    passive:{ rangedRate:0.85, rangedRange:1.15 },
  },
  berserk: {
    name:'Berserker', icon:'🪓', color:'#d05050', desc:'Ničivý melee, vysává životy, zrychlí když je zle.',
    start:['rezavy_mec','sekera'], startGems:120, hpMod:0.85, spdMod:1.05,
    costMul:{ melee:0.85, ranged:1.1, trap:1, wall:1, warrior:1, ammo:1 },
    passive:{ meleeDmg:1.3, lifesteal:0.12, berserk:true },
  },
  zved: {
    name:'Zvěd', icon:'🗡', color:'#c8c85c', desc:'Rychlý, kritické zásahy a úhyby, levné vrhací zbraně.',
    start:['rezavy_mec','vrhaci_nuz'], startGems:130, hpMod:0.9, spdMod:1.35,
    costMul:{ melee:1, ranged:0.85, trap:1, wall:1, warrior:1, ammo:0.8 },
    passive:{ crit:0.2, critMul:2.2, dodge:0.12, moveSpeed:1.1 },
  },
  mag: {
    name:'Mág', icon:'🔮', color:'#9a7bff', desc:'Magie na dálku – blesk, oheň, mráz. Málo HP, mana.',
    start:['rezavy_mec','ohniva_hul'], startGems:150, hpMod:0.8, spdMod:1.0,
    costMul:{ melee:1.1, ranged:0.85, trap:1, wall:1, warrior:1, ammo:1 },
    passive:{ magicDmg:1.2, manaMax:1.5, manaRegen:1.5 },
  },
  alchymista: {
    name:'Alchymista', icon:'⚗', color:'#5cc8a4', desc:'Pasti a plošné poškození, větší výbuchy, jed a oheň.',
    start:['rezavy_mec','bomba'], startGems:160, hpMod:0.9, spdMod:1.0,
    costMul:{ melee:1, ranged:1, trap:0.7, wall:1, warrior:1, ammo:1 },
    passive:{ aoeRadius:1.25, aoeDmg:1.2, dotDmg:1.3 },
  },
  inzenyr: {
    name:'Inženýr', icon:'🛠', color:'#c88a3a', desc:'Levné zdi, věže a spojenci; umí opravovat.',
    start:['rezavy_mec'], startGems:150, hpMod:1.0, spdMod:1.0,
    costMul:{ melee:1, ranged:1, trap:0.75, wall:0.7, warrior:0.7, ammo:1 },
    passive:{ wallHp:1.3, canRepair:true, emitterRate:0.85 },
  },
  knez: {
    name:'Kněz', icon:'✝', color:'#f0e0a0', desc:'Léčí, posiluje spojence, svěcené poškození proti nemrtvým.',
    start:['rezavy_mec'], startGems:140, hpMod:1.1, spdMod:1.0,
    costMul:{ melee:1, ranged:1, trap:1, wall:1, warrior:0.85, ammo:1 },
    passive:{ holyDmg:1.25, healAura:0.05, warriorBuff:1.2 },
  },
};

/* ---------- Aktivní schopnosti tříd (tlačítko + cooldown ve framech) ---------- */
const ABILITIES = {
  rytir:      { name:'Bojový pokřik', icon:'🛡', cd:600, desc:'Štít a provokace okolních nepřátel.' },
  lovec:      { name:'Salva šípů',    icon:'🏹', cd:540, desc:'Vystřelí vějíř šípů.' },
  berserk:    { name:'Zuřivost',      icon:'🩸', cd:660, desc:'Dočasně obří poškození a vysávání.' },
  zved:       { name:'Úprk',          icon:'💨', cd:360, desc:'Prudký výpad, nezranitelnost, sekne po cestě.' },
  mag:        { name:'Mrazivá nova',  icon:'❄', cd:600, desc:'Zmrazí a zraní vše kolem.' },
  alchymista: { name:'Kobercový nálet', icon:'💣', cd:720, desc:'Rozhází několik bomb kolem sebe.' },
  inzenyr:    { name:'Polní věž',      icon:'🔧', cd:660, desc:'Postaví dočasnou věž a opraví zdi.' },
  knez:       { name:'Svaté světlo',   icon:'✨', cd:600, desc:'Vyléčí tým a spálí nemrtvé kolem.' },
};

/* ---------- Vylepšování statů postavy (za gemy, v rámci běhu, sdílené týmem) ---------- */
const UPGRADES = {
  hp:    { name:'Vitalita',   icon:'❤', unit:'+12% max HP',   base:60, step:0.12, color:'#ff6a6a' },
  dmg:   { name:'Síla',       icon:'⚔', unit:'+8% poškození', base:75, step:0.08, color:'#ffb060' },
  speed: { name:'Hbitost',    icon:'👟', unit:'+6% rychlost',  base:60, step:0.06, color:'#8fd08f' },
  rate:  { name:'Zručnost',   icon:'⚡', unit:'-5% prodleva',   base:75, step:0.05, color:'#8fbaff' },
  crit:  { name:'Přesnost',   icon:'✦', unit:'+4% kritika',    base:85, step:0.04, color:'#ffd35c' },
  armor: { name:'Pancíř',     icon:'🛡', unit:'-5% obdržené',   base:70, step:0.05, color:'#c0c8d0' },
};
const UPGRADE_MAX = 10;
function upgradeCost(def, lvl) { return Math.round(def.base * Math.pow(1.55, lvl)); }
// vylepšení konkrétní zbraně (+% poškození, -% prodleva na úroveň)
const WEAPON_UP_MAX = 6;
function weaponUpCost(w, lvl) { return Math.round((w.cost * 0.5 + 40) * Math.pow(1.6, lvl)); }

/* ---------- Odměny a progrese ---------- */
const GEMS_PER_KILL_MUL = 1;          // × bounty nepřítele
function waveReward(wave) { return 60 + wave * 18; }   // bonus gemů za dokončení vlny
function xpForKill(e) { return Math.round((e.score || 10) / 5); }
function xpToLevel(level) { return 100 + (level - 1) * 60; } // XP na další úroveň profilu

/* ---------- LocalStorage klíče ---------- */
const PROFILE_KEY = 'rytiri_profile_v1';
const SCORES_KEY  = 'rytiri_scores_v1';
