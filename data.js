/* ============================================================================
   RYTÍŘI A NEMRTVÍ — datové tabulky (obsah hry)
   Vše je čisté „data": zbraně/nepřátelé/… = archetyp + statblok.
   Enginu (engine.js) i logice (game.js) stačí číst tyhle globální konstanty.
   ========================================================================== */

/* ---------- Mapa / aréna ---------- */
const TILE = 32;
const COLS = 15;
const ROWS = 22;                 // herní pole 480 × 704 px
const ARENA_W = COLS * TILE;     // 480
const ARENA_H = ROWS * TILE;     // 704
const HUD_H = 96;                // spodní pás s ovládáním
const VIEW_W = ARENA_W;          // 480
const VIEW_H = ARENA_H + HUD_H;  // 800

// Jádro (brána hradu), které se brání — 3×2 dlaždice dole uprostřed.
const CORE = { tx: 6, ty: 19, w: 3, h: 2 };
// Spawn brány nemrtvých (horní hrana + rohy). Souřadnice ve světových px.
const SPAWNS = [
  { x: TILE * 2.5,  y: -20 },
  { x: TILE * 7.5,  y: -20 },
  { x: TILE * 12.5, y: -20 },
  { x: -20,         y: TILE * 4 },
  { x: ARENA_W + 20, y: TILE * 4 },
];
// Statické překážky (skály/stromy) — dlaždice [tx,ty], neprůchodné, nedají se stavět.
const OBSTACLES = [
  [3,5],[4,5],[10,5],[11,5],
  [1,9],[2,9],[12,9],[13,9],
  [6,8],[7,8],[8,8],
  [4,13],[5,13],[9,13],[10,13],
  [2,15],[12,15],
];

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

/* ---------- Nepřátelé (nemrtví) ---------- */
/* Archetypy: WALKER | RUNNER | TANK | RANGED | EXPLODER | BOSS
   Runtime staty = base × škálování(wave). */
const ENEMIES = {
  chodec:    { name:'Chodec',    arch:'WALKER',   hp:20,  speed:0.7, dmg:6,  atkRate:40, size:24, bounty:4,  score:10,  leak:1, color:'#7ea06a' },
  behac:     { name:'Běhač',     arch:'RUNNER',   hp:13,  speed:1.7, dmg:5,  atkRate:28, size:20, bounty:5,  score:15,  leak:1, color:'#c9b04a' },
  obr:       { name:'Obr',       arch:'TANK',     hp:110, speed:0.42,dmg:16, atkRate:60, size:40, bounty:14, score:45,  leak:2, color:'#8a5a3a' },
  plivac:    { name:'Plivač',    arch:'RANGED',   hp:18,  speed:0.5, dmg:7,  atkRate:90, size:24, bounty:8,  score:25,  leak:1, color:'#5a8a6a', projSpeed:4.2, keepDist:170 },
  vybusny:   { name:'Výbušný',   arch:'EXPLODER', hp:16,  speed:1.15,dmg:34, atkRate:0,  size:26, bounty:10, score:30,  leak:1, color:'#b04a4a', aoeRadius:72 },
  nekromant: { name:'Nekromant', arch:'BOSS',     hp:650, speed:0.55,dmg:24, atkRate:70, size:52, bounty:140,score:600, leak:5, color:'#7a3a9a', summon:'chodec', summonRate:200 },
};
// Škálování dle čísla vlny (wave = 1,2,3…):
function enemyScale(wave) {
  return {
    hp:  1 + 0.16 * (wave - 1),
    spd: Math.min(1.6, 1 + 0.025 * (wave - 1)),
    dmg: 1 + 0.10 * (wave - 1),
  };
}
// Váhy výskytu typů podle vlny (boss řešen zvlášť: každá 5. vlna).
function waveComposition(wave) {
  const w = { chodec: 1 };
  if (wave >= 2) w.behac   = 0.25 + Math.min(0.4, wave * 0.03);
  if (wave >= 4) w.obr     = 0.12 + Math.min(0.3, (wave - 4) * 0.03);
  if (wave >= 5) w.plivac  = 0.15 + Math.min(0.3, (wave - 5) * 0.025);
  if (wave >= 6) w.vybusny = 0.12 + Math.min(0.3, (wave - 6) * 0.03);
  return w;
}
function isBossWave(wave) { return wave % 5 === 0; }
// Kolik nepřátel v dané vlně
function waveCount(wave) { return 8 + Math.floor(wave * 2.2); }

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

/* ---------- Odměny a progrese ---------- */
const GEMS_PER_KILL_MUL = 1;          // × bounty nepřítele
function waveReward(wave) { return 60 + wave * 18; }   // bonus gemů za dokončení vlny
function xpForKill(e) { return Math.round((e.score || 10) / 5); }
function xpToLevel(level) { return 100 + (level - 1) * 60; } // XP na další úroveň profilu

/* ---------- LocalStorage klíče ---------- */
const PROFILE_KEY = 'rytiri_profile_v1';
const SCORES_KEY  = 'rytiri_scores_v1';
