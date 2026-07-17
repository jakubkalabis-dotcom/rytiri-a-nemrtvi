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
  { name: 'Zelená louka',    cols: 22, rows: 30, seed: 101, pal: ['#3f7a2e', '#4a8a33', '#8a9098', '#6fc23e'], fog: null },
  { name: 'Temný les',       cols: 22, rows: 31, seed: 202, pal: ['#2c5424', '#33632a', '#6a7060', '#4aa036'], fog: 'rgba(10,30,10,0.14)' },
  { name: 'Starý hřbitov',   cols: 23, rows: 32, seed: 303, pal: ['#48504a', '#525c54', '#aab0ba', '#7a9a6a'], fog: 'rgba(40,45,60,0.16)' },
  { name: 'Hnilobná bažina', cols: 23, rows: 33, seed: 404, pal: ['#3a5228', '#42602c', '#6a6a4a', '#7aa838'], fog: 'rgba(60,80,20,0.16)' },
  { name: 'Zříceniny',       cols: 24, rows: 34, seed: 505, pal: ['#5e584c', '#6a6254', '#b0a890', '#8a7a56'], fog: null },
  { name: 'Zamrzlá pláň',    cols: 24, rows: 35, seed: 606, pal: ['#c2d8e6', '#d2e4ee', '#9aa8b6', '#eaf4ff'], fog: 'rgba(210,235,255,0.12)' },
  { name: 'Spálená poušť',   cols: 25, rows: 36, seed: 707, pal: ['#d6b566', '#e2c274', '#b09258', '#f0d488'], fog: 'rgba(255,220,140,0.1)' },
  { name: 'Temná jeskyně',   cols: 25, rows: 37, seed: 808, pal: ['#3a4048', '#434b54', '#5a6470', '#6a5a80'], fog: 'rgba(0,0,15,0.28)' },
  { name: 'Prokleté pole',   cols: 26, rows: 38, seed: 909, pal: ['#4a4038', '#544840', '#7a6e64', '#9a5a9a'], fog: 'rgba(60,25,60,0.18)' },
  { name: 'Sopečná stráň',   cols: 26, rows: 39, seed: 111, pal: ['#5a382a', '#663e2c', '#7a5648', '#ff6a30'], fog: 'rgba(90,30,10,0.16)' },
  { name: 'Kostěná pustina', cols: 27, rows: 40, seed: 121, pal: ['#5a564a', '#645e50', '#e0d8bc', '#b0a684'], fog: 'rgba(70,60,45,0.14)' },
  { name: 'Stínový hvozd',   cols: 27, rows: 41, seed: 131, pal: ['#2a2e3c', '#333850', '#5a4a70', '#7a3adf'], fog: 'rgba(30,15,60,0.26)' },
  { name: 'Krvavé bažiny',   cols: 28, rows: 42, seed: 141, pal: ['#4a2626', '#582c2c', '#7a4a4a', '#c02828'], fog: 'rgba(90,15,15,0.2)' },
  { name: 'Brána podsvětí',  cols: 28, rows: 43, seed: 151, pal: ['#3c2436', '#482940', '#6a4864', '#b0308a'], fog: 'rgba(80,15,60,0.24)' },
  { name: 'Utopený chrám',   cols: 29, rows: 44, seed: 171, pal: ['#1e3a3e', '#244a4c', '#3a6a68', '#3ad0c8'], fog: 'rgba(10,50,55,0.24)' },
  { name: 'Popelová pláň',   cols: 29, rows: 45, seed: 181, pal: ['#3a3634', '#444040', '#6a6460', '#ff7040'], fog: 'rgba(50,40,35,0.2)' },
  { name: 'Peklo',           cols: 30, rows: 47, seed: 161, pal: ['#6a1e14', '#7c261a', '#a04030', '#ff7a20'], fog: 'rgba(120,25,5,0.22)', hell: true },
];
const NUM_MAPS = MAPS.length;
const WAVES_PER_MAP = 25;                // každá mapa = 25 vln; každá 5. vlna = sub-boss, 25. = mapový boss
const FINAL_WAVE = NUM_MAPS * WAVES_PER_MAP;  // poslední vlna kampaně (počet map × 25) — po ní lze vstoupit do Nekonečna (viz ASCENSION_CURSES)
function mapForWave(wave) { return Math.min(NUM_MAPS - 1, Math.floor((Math.max(1, wave) - 1) / WAVES_PER_MAP)); }
function waveInMap(wave) { return ((Math.max(1, wave) - 1) % WAVES_PER_MAP) + 1; }   // 1..25
function isMapEndWave(wave) { return wave % WAVES_PER_MAP === 0; }   // mapový boss = konec mapy (každá 25.)
function isSubBossWave(wave) { return wave % 5 === 0 && wave % WAVES_PER_MAP !== 0; } // sub-boss každou 5. (mimo 25.)
function isFinalWave(wave) { return wave >= FINAL_WAVE; }
// souvislý ukazatel postupu 0..~15 (mapa + zlomek uvnitř mapy) — pro škálování obtížnosti
function waveProgress(wave) { return mapForWave(wave) + (waveInMap(wave) - 1) / WAVES_PER_MAP; }

// Nastaví rozměry, jádro a spawny podle mapy (bez generování překážek – to dělá loadMap v engine).
function applyMapDims(i) {
  const m = MAPS[clampIdx(i)];
  COLS = m.cols; ROWS = m.rows;
  ARENA_W = COLS * TILE; ARENA_H = ROWS * TILE;
  CORE = { tx: Math.floor(COLS / 2) - 1, ty: ROWS - 3, w: 3, h: 2 };   // dolní střed
  // Koridor: prostřední ~50 % šířky; po stranách barikáda (viz genObstacles).
  const side = corridorSide();
  const x0 = side * TILE, x1 = (COLS - side) * TILE;
  SPAWNS = [
    { x: x0 + (x1 - x0) * 0.22, y: -20 }, { x: x0 + (x1 - x0) * 0.4, y: -20 }, { x: x0 + (x1 - x0) * 0.5, y: -20 },
    { x: x0 + (x1 - x0) * 0.6, y: -20 }, { x: x0 + (x1 - x0) * 0.78, y: -20 },
  ];
}
// šířka boční barikády (v dlaždicích) na každé straně — tenká, jen naznačuje okraj
function corridorSide() { return Math.max(1, Math.floor(COLS * 0.11)); }
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
  dyka:            { name:'Dýka',            arch:'MELEE_SWING', dmg:4,  range:36, rate:12, spread:0.6,  knockback:2, ammo:'melee', tier:1, unlock:1, cost:45,  cat:'melee', color:'#d6d6de' },
  sekera:          { name:'Sekera',          arch:'MELEE_SWING', dmg:11, range:48, rate:32, spread:0.8,  knockback:6, ammo:'melee', tier:1, unlock:2, cost:75,  cat:'melee', color:'#b0a080' },
  kopi:            { name:'Kopí',            arch:'MELEE_SWING', dmg:12, range:74, rate:28, spread:0.35, knockback:5, ammo:'melee', tier:2, unlock:3, cost:95,  cat:'melee', color:'#c2b59b' },
  kosa:            { name:'Kosa',            arch:'MELEE_SWING', dmg:14, range:54, rate:34, spread:1.7,  knockback:3, ammo:'melee', tier:2, unlock:4, cost:120, cat:'melee', color:'#b8c0c8' },
  palcat:          { name:'Palcát',          arch:'MELEE_SWING', dmg:17, range:44, rate:34, spread:0.7,  knockback:8, ammo:'melee', tier:2, unlock:4, cost:130, cat:'melee', color:'#9aa0a8' },
  remdih:          { name:'Řemdih',          arch:'MELEE_SWING', dmg:18, range:52, rate:30, spread:1.1,  knockback:7, ammo:'melee', tier:3, unlock:5, cost:150, cat:'melee', color:'#8f9298' },
  kyj:             { name:'Kyj',             arch:'MELEE_SWING', dmg:20, range:46, rate:40, spread:0.9,  knockback:9, ammo:'melee', tier:2, unlock:3, cost:110, cat:'melee', color:'#7a5a3a' },
  halapartna:      { name:'Halapartna',      arch:'MELEE_SWING', dmg:23, range:80, rate:38, spread:0.5,  knockback:7, ammo:'melee', tier:3, unlock:6, cost:185, cat:'melee', color:'#c2b59b' },
  valecne_kladivo: { name:'Válečné kladivo', arch:'MELEE_SWING', dmg:31, range:50, rate:50, spread:0.8,  knockback:12,ammo:'melee', tier:3, unlock:7, cost:220, cat:'melee', color:'#8a8f96' },
  obour_mec:       { name:'Obouruční meč',   arch:'MELEE_SWING', dmg:28, range:58, rate:46, spread:1.15, knockback:8, ammo:'melee', tier:3, unlock:6, cost:200, cat:'melee', color:'#d2d8e0' },

  /* ===== NA DÁLKU (18) ===== */
  kratky_luk:    { name:'Krátký luk',    arch:'PROJECTILE', dmg:8,  range:300, rate:22, projSpeed:9.5, pierce:0, ammo:'sip',   ammoPerShot:1, tier:1, unlock:1, cost:60,  cat:'ranged', color:'#c9b072' },
  dlouhy_luk:    { name:'Dlouhý luk',    arch:'PROJECTILE', dmg:16, range:420, rate:36, projSpeed:12,  pierce:1, ammo:'sip',   ammoPerShot:1, tier:2, unlock:3, cost:125, cat:'ranged', color:'#b89a52' },
  ohnivy_sip:    { name:'Ohnivý šíp',    arch:'PROJECTILE', dmg:12, range:340, rate:32, projSpeed:11,  pierce:0, dot:{dps:8,dur:120},  ammo:'sip', ammoPerShot:1, tier:2, unlock:5, cost:155, cat:'ranged', color:'#ff8a3a' },
  kuse:          { name:'Kuše',          arch:'PROJECTILE', dmg:24, range:360, rate:50, projSpeed:14,  pierce:1, ammo:'sipka', ammoPerShot:1, tier:2, unlock:2, cost:115, cat:'ranged', color:'#b8b8c0' },
  tezka_kuse:    { name:'Těžká kuše',    arch:'PROJECTILE', dmg:43, range:400, rate:70, projSpeed:15,  pierce:2, knockback:6, ammo:'sipka', ammoPerShot:1, tier:3, unlock:6, cost:210, cat:'ranged', color:'#a0a0aa' },
  jedovata_kuse: { name:'Jedovatá kuše', arch:'PROJECTILE', dmg:16, range:340, rate:44, projSpeed:12,  pierce:0, dot:{dps:16,dur:180}, ammo:'sipka', ammoPerShot:1, tier:3, unlock:5, cost:170, cat:'ranged', color:'#7ad06a' },
  balista:       { name:'Balista',       arch:'PROJECTILE', dmg:55, range:460, rate:90, projSpeed:16,  pierce:4, knockback:8, ammo:'sipka', ammoPerShot:2, tier:3, unlock:8, cost:300, cat:'ranged', color:'#8a7a5a' },
  opakovaci_kuse:{ name:'Opakovací kuše',arch:'MULTISHOT',  dmg:7,  range:260, rate:30, projSpeed:11, spread:0.32, shots:3, pierce:0, ammo:'sipka', ammoPerShot:3, tier:3, unlock:5, cost:205, cat:'ranged', color:'#c0c0c8' },
  prak:          { name:'Prak',          arch:'PROJECTILE', dmg:7,  range:260, rate:20, projSpeed:10,  pierce:0, ammo:'kamen', ammoPerShot:1, tier:1, unlock:1, cost:50,  cat:'ranged', color:'#9a9a9a' },
  ostep:         { name:'Oštěp',         arch:'PROJECTILE', dmg:22, range:300, rate:40, projSpeed:12,  pierce:2, knockback:6, ammo:'vrh', ammoPerShot:1, tier:2, unlock:3, cost:120, cat:'ranged', color:'#c2b59b' },
  vrhaci_nuz:    { name:'Vrhací nůž',    arch:'PROJECTILE', dmg:4,  range:240, rate:14, projSpeed:12,  pierce:0, ammo:'vrh', ammoPerShot:1, tier:1, unlock:1, cost:55,  cat:'ranged', color:'#d6d6de' },
  vrhaci_sekera: { name:'Vrhací sekera', arch:'PROJECTILE', dmg:18, range:260, rate:34, projSpeed:10,  pierce:1, knockback:5, ammo:'vrh', ammoPerShot:1, tier:2, unlock:4, cost:140, cat:'ranged', color:'#b0a080' },
  musketa:       { name:'Ruční mušketa', arch:'HITSCAN',    dmg:42, range:380, rate:70, knockback:5, ammo:'prach', ammoPerShot:1, tier:3, unlock:7, cost:240, cat:'ranged', color:'#6a6a6a' },
  bomba:         { name:'Bomba',         arch:'THROWN_AOE', dmg:42, range:220, rate:80, projSpeed:6.5, aoeRadius:66, ammo:'bomba', ammoPerShot:1, tier:2, unlock:4, cost:160, cat:'ranged', color:'#d05050' },
  recky_ohen:    { name:'Řecký oheň',    arch:'THROWN_AOE', dmg:20, range:210, rate:64, projSpeed:6,   aoeRadius:74, dot:{dps:22,dur:180}, ammo:'bomba', ammoPerShot:1, tier:3, unlock:6, cost:190, cat:'ranged', color:'#ff6a2a' },
  blesk_hul:     { name:'Blesková hůl',  arch:'HITSCAN',    dmg:25, range:320, rate:40, chain:3, ammo:'mana', ammoPerShot:24, tier:3, unlock:5, cost:230, cat:'ranged', color:'#9ad0ff' },
  ohniva_hul:    { name:'Ohnivá hůl',    arch:'THROWN_AOE', dmg:26, range:240, rate:56, projSpeed:7, aoeRadius:70, dot:{dps:10,dur:120}, ammo:'mana', ammoPerShot:34, tier:3, unlock:6, cost:260, cat:'ranged', color:'#ff7b3a' },
  mraziva_hul:   { name:'Mrazivá hůl',   arch:'PROJECTILE', dmg:19, range:300, rate:30, projSpeed:10, pierce:1, slow:{mul:0.45,dur:120}, ammo:'mana', ammoPerShot:18, tier:3, unlock:5, cost:240, cat:'ranged', color:'#8fe0ff' },
  /* ===== FÁZE 3: nové zbraně ===== */
  cep:             { name:'Cep',             arch:'MELEE_SWING', dmg:14, range:56, rate:34, spread:1.9,  knockback:5, ammo:'melee', tier:2, unlock:4, cost:135, cat:'melee', color:'#8f9298' },   // široký záběr = dav
  trojzubec:       { name:'Trojzubec',       arch:'MELEE_SWING', dmg:21, range:88, rate:34, spread:0.4,  knockback:6, ammo:'melee', tier:3, unlock:6, cost:190, cat:'melee', color:'#c2b59b' },   // dlouhý dosah
  svaty_samostril: { name:'Svatý samostříl', arch:'PROJECTILE', dmg:30, range:400, rate:48, projSpeed:15, pierce:3, knockback:4, ammo:'sipka', ammoPerShot:1, tier:3, unlock:7, cost:245, cat:'ranged', color:'#ffe6a0' },   // probíjí řadu
  ledova_kuse:     { name:'Ledová kuše',     arch:'PROJECTILE', dmg:27, range:330, rate:42, projSpeed:13, pierce:1, slow:{mul:0.4,dur:150}, ammo:'sipka', ammoPerShot:1, tier:3, unlock:5, cost:180, cat:'ranged', color:'#a8e8ff' },   // mrazí
  hromova_hul:     { name:'Hromová hůl',     arch:'HITSCAN',    dmg:30, range:340, rate:48, chain:5, ammo:'mana', ammoPerShot:30, tier:3, unlock:7, cost:280, cat:'ranged', color:'#c0a8ff' },   // řetězí přes 5 cílů
  kartac:          { name:'Kartáč',          arch:'MULTISHOT',  dmg:6,  range:155, rate:44, projSpeed:12, spread:0.22, shots:6, pierce:0, knockback:3, ammo:'prach', ammoPerShot:2, tier:3, unlock:6, cost:230, cat:'ranged', color:'#e0b060' },   // brokovnice: dav zblízka
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
  cep: 'flail', trojzubec: 'spear', svaty_samostril: 'crossbow', ledova_kuse: 'crossbow', hromova_hul: 'staff', kartac: 'musket',
};

/* ---------- Nepřátelé (nemrtví) ---------- */
/* Archetypy: WALKER | RUNNER | TANK | RANGED | EXPLODER | BOSS
   Runtime staty = base × škálování(wave). */
const ENEMIES = {
  chodec:    { name:'Chodec',    arch:'WALKER',   hp:20,  speed:0.7, dmg:6,  atkRate:40, size:24, bounty:4,  score:10,  leak:1, color:'#86c15a' },
  behac:     { name:'Běhač',     arch:'RUNNER',   hp:13,  speed:1.7, dmg:5,  atkRate:28, size:20, bounty:5,  score:15,  leak:1, color:'#e6cb3e' },
  ohar:      { name:'Ohař',      arch:'RUNNER',   hp:10,  speed:2.3, dmg:7,  atkRate:24, size:18, bounty:6,  score:18,  leak:1, color:'#c24040' },
  obr:       { name:'Obr',       arch:'TANK',     hp:110, speed:0.42,dmg:16, atkRate:60, size:40, bounty:14, score:45,  leak:2, color:'#b0703e' },
  brnenec:   { name:'Brněnec',   arch:'TANK',     hp:70,  speed:0.6, dmg:12, atkRate:50, size:30, bounty:12, score:40,  leak:1, color:'#8aa0b8', armored:true },
  plivac:    { name:'Plivač',    arch:'RANGED',   hp:18,  speed:0.5, dmg:7,  atkRate:90, size:24, bounty:8,  score:25,  leak:1, color:'#5fc584', projSpeed:4.2, keepDist:170 },
  vybusny:   { name:'Výbušný',   arch:'EXPLODER', hp:16,  speed:1.15,dmg:34, atkRate:0,  size:26, bounty:10, score:30,  leak:1, color:'#54a83f', aoeRadius:72 },
  delic:     { name:'Dělič',     arch:'WALKER',   hp:42,  speed:0.6, dmg:8,  atkRate:46, size:30, bounty:12, score:34,  leak:1, color:'#b25cd0', splits:3, splitId:'delicek' },
  delicek:   { name:'Dělíček',   arch:'RUNNER',   hp:7,   speed:1.5, dmg:4,  atkRate:26, size:15, bounty:2,  score:6,   leak:1, color:'#c88ce0' },   // jen ze štěpení Děliče
  saman:     { name:'Šaman',     arch:'RANGED',   hp:36,  speed:0.55,dmg:4,  atkRate:150,size:26, bounty:16, score:42,  leak:1, color:'#c060e0', keepDist:210, projSpeed:3.5, heals:true, healAmt:7, healRate:78, healRadius:120 },  // léčí okolní nemrtvé!
  strasak:   { name:'Zuřivec',   arch:'RUNNER',   hp:44,  speed:0.9, dmg:11, atkRate:30, size:28, bounty:13, score:40,  leak:1, color:'#e04a3a', frenzy:true },   // čím míň HP, tím rychlejší
  // Bossové (cyklují se – viz bossForWave)
  nekromant: { name:'Nekromant', arch:'BOSS',     hp:650, speed:0.55,dmg:24, atkRate:70, size:52, bounty:140,score:600, leak:5, color:'#a44ad0', summon:'chodec', summonRate:200 },
  abominace: { name:'Abominace', arch:'BOSS',     hp:1100,speed:0.4, dmg:34, atkRate:60, size:66, bounty:200,score:800, leak:6, color:'#9a6a34', enrage:true },
  lich:      { name:'Lich',      arch:'BOSS',     hp:820, speed:0.5, dmg:20, atkRate:55, size:50, bounty:220,score:900, leak:5, color:'#4a92c0', summon:'behac', summonRate:170, volley:true },
  kostlivy_kral:{name:'Kostlivý král',arch:'BOSS', hp:1050,speed:0.5, dmg:30, atkRate:52, size:70, bounty:250,score:1000,leak:6, color:'#e6ddbe', summon:'delic', summonRate:130, volley:true, enrage:true },
  pekelny_pan:{name:'Pekelný pán',arch:'BOSS',    hp:3200,speed:0.5, dmg:44, atkRate:45, size:80, bounty:1000,score:5000,leak:20,color:'#ff4a1a', summon:'vybusny', summonRate:120, volley:true, enrage:true, final:true },
  // Sub-bossové (mini-bossové — objeví se každou 5. vlnu mimo 25.; po smrti dají týmu trvalý buff). arch BOSS + sub:true
  rytir_smrti:  { name:'Rytíř smrti',   arch:'BOSS', sub:true, hp:340, speed:0.7,  dmg:20, atkRate:46, size:40, bounty:70, score:260, leak:3, color:'#8a90a0', armored:true },
  krvavy_reznik:{ name:'Krvavý řezník', arch:'BOSS', sub:true, hp:300, speed:1.0,  dmg:26, atkRate:34, size:42, bounty:75, score:280, leak:3, color:'#b83030' },
  morova_matka: { name:'Morová matka',  arch:'BOSS', sub:true, hp:360, speed:0.5,  dmg:16, atkRate:60, size:44, bounty:80, score:300, leak:4, color:'#6ab04a', summon:'behac', summonRate:150 },
  kostej:       { name:'Kostěj',        arch:'BOSS', sub:true, hp:320, speed:0.55, dmg:18, atkRate:50, size:40, bounty:80, score:300, leak:3, color:'#c8c0a0', volley:true },
  masovy_golem: { name:'Masový golem',  arch:'BOSS', sub:true, hp:520, speed:0.34, dmg:30, atkRate:64, size:52, bounty:90, score:340, leak:5, color:'#9a5a4a' },
  kosteny_tyran:{ name:'Kostěný tyran', arch:'BOSS', sub:true, hp:400, speed:0.6,  dmg:22, atkRate:44, size:46, bounty:90, score:330, leak:4, color:'#b0a878', summon:'delic', summonRate:200, volley:true },   // přivolává Děliče + střílí vějíř
  pridatny_lecitel:{ name:'Kněz nemrtvých', arch:'BOSS', sub:true, hp:360, speed:0.5, dmg:14, atkRate:80, size:44, bounty:95, score:340, leak:4, color:'#a04ad0', heals:true, healAmt:14, healRate:60, healRadius:150, summon:'saman', summonRate:220 },   // léčí hordu + volá Šamany
};
const BOSS_CYCLE = ['nekromant', 'abominace', 'lich', 'kostlivy_kral'];
const SUB_BOSS_CYCLE = ['rytir_smrti', 'krvavy_reznik', 'morova_matka', 'kostej', 'masovy_golem', 'kosteny_tyran', 'pridatny_lecitel'];
// Mapový boss (konec mapy, každá 25. vlna): cyklí 3 velké bossy přes mapy, finále = Pekelný pán.
function mapBossForWave(wave) {
  if (isFinalWave(wave)) return 'pekelny_pan';
  return BOSS_CYCLE[mapForWave(wave) % BOSS_CYCLE.length];
}
// Sub-boss (každou 5. vlnu mimo mapového bosse): cyklí 5 druhů podle pořadí v kampani.
function subBossForWave(wave) {
  const idx = mapForWave(wave) * 4 + Math.floor((waveInMap(wave) - 1) / 5); // 0-based pořadí sub-bosse
  return SUB_BOSS_CYCLE[idx % SUB_BOSS_CYCLE.length];
}
function bossForWave(wave) { return isSubBossWave(wave) ? subBossForWave(wave) : mapBossForWave(wave); }

/* ---------- Elitní přídomky (náhodně na běžných nepřátelích od pozdějších vln) ---------- */
const ELITES = {
  rychly:      { name:'Rychlý',      hpMul:1.3, spdMul:1.6, dmgMul:1.1, glow:'#5cf0ff' },
  pancerovany: { name:'Pancéřovaný', hpMul:2.6, spdMul:0.9, dmgMul:1.4, glow:'#c0c8d0' },
  zhoubny:     { name:'Zhoubný',     hpMul:1.6, spdMul:1.1, dmgMul:1.3, glow:'#c060ff', explode:true },
};
const ELITE_KEYS = Object.keys(ELITES);
// Šance na elitu roste hlavně s pořadím mapy (a mírně uvnitř mapy). Strop 28 %.
function eliteChance(wave) { const m = mapForWave(wave); return m < 1 && waveInMap(wave) < 6 ? 0 : Math.min(0.28, 0.03 + m * 0.016 + (waveInMap(wave) - 1) * 0.002); }

/* ---------- Dočasné dropy (padají z nepřátel; elita dropne vždy) ---------- */
const DROPS = {
  rapid:  { name:'Rychlopalba', icon:'»', color:'#5cd8ff', dur:480, kind:'buff' },
  power:  { name:'Síla',        icon:'★', color:'#ff7be5', dur:480, kind:'buff' },
  freeze: { name:'Mráz',        icon:'❄', color:'#8fe0ff', kind:'freeze' },
  heal:   { name:'Léčení',      icon:'✚', color:'#5cff8a', kind:'heal' },
  truhla: { name:'Truhla',      icon:'💰', color:'#ffd35c', kind:'gems', gems:20 },
  wood:   { name:'Dřevo',       icon:'🪵', color:'#8a5c30', kind:'mat', mat:'wood',  amt:2 },
  steel:  { name:'Ocel',        icon:'⛓', color:'#b8bcc4', kind:'mat', mat:'steel', amt:1 },
  zluc:   { name:'Zombie žluč', icon:'🧪', color:'#8fd84a', kind:'bile' },   // sbírá jen alchymista (podržet 1 s)
};
// materiály na vylepšování zbraní padají často (aby se dalo craftit)
const DROP_WEIGHTS = { rapid: 3, power: 3, freeze: 2, heal: 3, truhla: 2, wood: 7, steel: 4 };
// Škálování dle POSTUPU (mapa + zlomek uvnitř mapy), aby křivka dávala smysl přes celou kampaň (FINAL_WAVE vln).
// prog = 0 (mapa 1, vlna 1) .. ~15 (mapa 15, konec). hp roste plynule, spd/dmg mají strop.
function enemyScale(wave) {
  const prog = waveProgress(wave);
  return {
    hp:  1 + 0.55 * prog,               // mapa 1 ~1×, mapa 15 konec ~9×
    spd: Math.min(1.8, 1 + 0.035 * prog),
    dmg: Math.min(4.0, 1 + 0.20 * prog),  // prog0→1×, prog7→2.4×, prog15→4× (strop reálně kousne)
  };
}
// Váhy výskytu typů podle POSTUPU mapami (boss/sub-boss řešen zvlášť).
function waveComposition(wave) {
  const p = waveProgress(wave);
  const w = { chodec: 1 };
  if (p >= 0.3) w.behac   = 0.25 + Math.min(0.5,  p * 0.05);
  if (p >= 1.0) w.ohar    = 0.12 + Math.min(0.45, (p - 1.0) * 0.05);
  if (p >= 1.5) w.obr     = 0.10 + Math.min(0.35, (p - 1.5) * 0.04);
  if (p >= 2.0) w.brnenec = 0.10 + Math.min(0.34, (p - 2.0) * 0.035);
  if (p >= 2.5) w.plivac  = 0.12 + Math.min(0.35, (p - 2.5) * 0.03);
  if (p >= 3.0) w.vybusny = 0.10 + Math.min(0.34, (p - 3.0) * 0.03);
  if (p >= 3.5) w.delic   = 0.08 + Math.min(0.22, (p - 3.5) * 0.025);   // Dělič — po smrti se rozdělí
  if (p >= 4.0) w.saman   = 0.06 + Math.min(0.14, (p - 4.0) * 0.02);    // Šaman — léčí hordu
  if (p >= 4.5) w.strasak = 0.08 + Math.min(0.22, (p - 4.5) * 0.025);   // Zuřivec — zrychluje s poškozením
  return w;
}
function isBossWave(wave) { return wave % 5 === 0; }   // jakákoli bossovská vlna (sub i mapový)
// Horda: vlna těsně před (sub)bossem = záplava obyčejných zombie (mimo úplně první bloky mapy 1).
function isHordeWave(wave) { return wave > 5 && wave % 5 === 4; }

/* ---------- Modifikátory vln (pacing, od vlny 26) ----------
   Každá 5. „obyčejná" vlna (mimo boss/horda) od vlny 27 dál dostane náhodně cyklující modifikátor
   z tohoto seznamu — banner + efekty (spd/hp/dmg/count/eliteChance) řeší game.js, zde jen data.  */
const WAVE_MODIFIERS = [
  { id:'bourna',  name:'Bouřná vlna',  icon:'⚡', desc:'Nepřátelé jsou o 35 % rychlejší.',             spdMul:1.35, hpMul:1,   dmgMul:1,   countMul:1,   eliteChanceAdd:0 },
  { id:'zelezna', name:'Železná vlna', icon:'🛡', desc:'Nepřátelé mají +60 % HP, ale −15 % rychlost.', spdMul:0.85, hpMul:1.6, dmgMul:1,   countMul:1,   eliteChanceAdd:0 },
  { id:'zuriva',  name:'Zuřivá vlna',  icon:'💢', desc:'Nepřátelé udělují o 30 % víc poškození.',      spdMul:1,    hpMul:1,   dmgMul:1.3, countMul:1,   eliteChanceAdd:0 },
  { id:'roj',     name:'Rojová vlna',  icon:'🐝', desc:'O 40 % víc nepřátel, ale mají −20 % HP.',       spdMul:1,    hpMul:0.8, dmgMul:1,   countMul:1.4, eliteChanceAdd:0 },
  { id:'elitni',  name:'Elitní vlna',  icon:'⭐', desc:'Mnohem vyšší šance na elitní nepřátele (+30 %).', spdMul:1,  hpMul:1,   dmgMul:1,   countMul:1,   eliteChanceAdd:0.30 },
];
function waveModifier(wave) {
  if (wave <= 25 || isBossWave(wave) || isHordeWave(wave)) return null;
  if (wave % 5 !== 2) return null;                 // vlny 27,32,37,... (mimo boss %5==0 a horde %5==4)
  return WAVE_MODIFIERS[Math.floor(wave / 5) % WAVE_MODIFIERS.length];
}

// Kolik nepřátel ve vlně: roste s postupem uvnitř mapy i s pořadím mapy (se stropem).
function waveCount(wave) {
  const m = mapForWave(wave), wIn = waveInMap(wave) - 1;
  const base = isHordeWave(wave) ? Math.min(85, 45 + m * 3 + wIn) : Math.min(44, 12 + Math.floor(m * 0.8 + wIn * 1.0));
  return Math.round(base * (waveModifier(wave)?.countMul || 1));
}
// Složení hordy: skoro jen chodci + trocha běhačů/ohařů (víc s postupem)
function hordeComposition(wave) { const p = waveProgress(wave); const w = { chodec: 1 }; if (p >= 0.8) w.behac = 0.4; if (p >= 1.5) w.ohar = 0.3; return w; }

/* ---------- Pasti (15) ---------- */
/* Archetypy: ONESHOT | SLOW | DOT_AOE | EMITTER */
const TRAPS = {
  // nášlapné — TRVALÉ (drží do konce mapy), poškozují opakovaně po malých dávkách
  bodce:      { name:'Bodce',        arch:'ONESHOT', dmg:7,  cost:70,  color:'#b8b8c0', cat:'trap' },
  ostnaty_val:{ name:'Ostnatý val',  arch:'ONESHOT', dmg:5,  cost:100, color:'#9aa0a8', cat:'trap' },
  medvedka:   { name:'Medvědí past', arch:'ONESHOT', dmg:12, cost:95,  color:'#6a6a72', cat:'trap' },
  jama:       { name:'Bodcová jáma', arch:'ONESHOT', dmg:16, cost:140, color:'#3a3a42', cat:'trap' },
  cakan:      { name:'Kolová past',  arch:'ONESHOT', dmg:10, cost:120, color:'#c8a060', cat:'trap' },
  // zpomalovací pole (trvalé)
  smola:      { name:'Smola',        arch:'SLOW',    slow:{mul:0.4},  hp:70,  cost:95,  color:'#3a3320', cat:'trap' },
  dehet:      { name:'Dehtová jáma', arch:'SLOW',    slow:{mul:0.55}, hp:90,  cost:130, color:'#20201a', cat:'trap' },
  mrazova:    { name:'Mrazivá past', arch:'SLOW',    slow:{mul:0.25}, hp:80,  cost:190, color:'#8fe0ff', cat:'trap' },
  // plošné poškození v čase (trvalé)
  ohniste:    { name:'Ohniště',      arch:'DOT_AOE', dps:6,  radius:52, cost:120, color:'#ff7b3a', cat:'trap' },
  jed:        { name:'Jedový plyn',  arch:'DOT_AOE', dps:5,  radius:64, cost:150, color:'#7ad06a', cat:'trap' },
  kyselina:   { name:'Kyselá louže', arch:'DOT_AOE', dps:10, radius:42, cost:170, color:'#c8e030', cat:'trap' },
  svaty_kruh: { name:'Svatý kruh',   arch:'DOT_AOE', dps:8,  radius:56, cost:220, color:'#f0e0a0', cat:'trap' },
  // věže (automatické, blokující, trvalé)
  samostril:  { name:'Samostříl',    arch:'EMITTER', dmg:11, range:210, rate:38, projSpeed:10, hp:90,  cost:200, color:'#8a7a5a', cat:'trap' },
  tesla:      { name:'Teslova věž',  arch:'EMITTER', dmg:7,  range:190, rate:14, projSpeed:13, hp:80,  cost:250, color:'#8fbaff', cat:'trap' },
  plamenomet: { name:'Plamenomet',   arch:'EMITTER', dmg:6,  range:130, rate:8,  projSpeed:8,  hp:100, cost:290, color:'#ff8a3a', cat:'trap' },
  balista_v:  { name:'Věž s balistou', arch:'EMITTER', dmg:28, range:300, rate:80, projSpeed:15, pierce:3, hp:130, cost:370, color:'#7a6a4a', cat:'trap' },
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
    name:'Rytíř', icon:'⚔', color:'#c8a45c', desc:'Nejtvrdší tank. Štítem vykryje všechny útoky. Levné meče.',
    start:['rezavy_mec'], startGems:130, hpMod:1.7, spdMod:0.92,
    costMul:{ melee:0.8, ranged:1, trap:1, wall:1, warrior:1, ammo:1 },
    passive:{ meleeDmg:1.15, block:0.18 },
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
    name:'Kněz', icon:'✝', color:'#f0e0a0', desc:'Léčí, posiluje, Svatá záře pálí nemrtvé kolem. Umí vzkřísit padlé.',
    start:['rezavy_mec'], startGems:140, hpMod:1.1, spdMod:1.0,
    costMul:{ melee:1, ranged:1, trap:1, wall:1, warrior:0.85, ammo:1 },
    passive:{ holyDmg:1.25, healAura:0.05, warriorBuff:1.2 },
  },
  nekromant: {
    name:'Nekromant', icon:'💀', color:'#8a4ad0', desc:'Odpadlý černokněžník. Křísí padlé jako kostlivce a vládne mrazem a jedem.',
    start:['rezavy_mec','mraziva_hul'], startGems:145, hpMod:0.9, spdMod:1.0,
    costMul:{ melee:1.05, ranged:0.9, trap:1, wall:1, warrior:0.65, ammo:1 },
    passive:{ magicDmg:1.15, dotDmg:1.3, lifesteal:0.06, warriorBuff:1.15 },
  },
};

/* ---------- Aktivní schopnosti tříd (tlačítko + cooldown ve framech, 60 = 1 s) ----------
   Každá schopnost má `desc` s přesnými čísly (hráč musí vědět co, kolik a jak dělá).            */
const ABILITIES = {
  rytir:      { name:'Zvednout štít', icon:'🛡', cd:120, desc:'Na 0,75 s vykryje VŠECHNY útoky (i střely) a odhodí okolní nemrtvé. Cooldown jen 2 s. Štít lze vylepšit (delší blok, odraz poškození).' },
  lovec:      { name:'Smršt',         icon:'🏹', cd:2100, desc:'Na 5 s +70 % rychlost palby a NEKONEČNO munice. Cooldown 35 s.' },
  berserk:    { name:'Volání klanu',  icon:'🪓', cd:2400, desc:'Přivolá 2 sekerníky (200 HP, 22 poškození). Zůstanou dokud nepadnou / nezvedneš HP nad 65 % / nekončí kolo. Použitelné jen při ≤50 % HP. Cooldown 40 s po jejich odchodu.' },
  zved:       { name:'Bodnutí do zad',icon:'🗡', cd:600, desc:'Na 5 s neviditelnost (nemrtví tě ignorují). První útok: běžný nepřítel je OKAMŽITĚ zabit, boss dostane 3× poškození zbraně. Zabití silnějšího nepřítele schopností resetuje cooldown (jinak 10 s).' },
  mag:        { name:'Armagedon',     icon:'☄', cd:900, desc:'Sešle meteor na nejbližší shluk nepřátel: 130 poškození v okruhu 78 + ohnivá zem (16/s po 3 s). Cooldown 15 s.' },
  alchymista: { name:'Abominace',     icon:'🧟', cd:0, desc:'Vypije lektvar (z 6 žlučí) a na 9 s se promění v abominaci: −35 % obdrženého poškození, −38 % rychlost, POŽÍRÁ pěšáky (okamžitě, +1 max HP navždy za každého, strop 140) a leptá silnější (20 dmg/2,5 s + 4 dmg/s žíravinou v okruhu 46). Bez cooldownu — potřebuje lektvar (max 2).' },
  inzenyr:    { name:'Polní věž',      icon:'🔧', cd:1020, desc:'Postaví dočasný samostříl (12 s) na tvé pozici a opraví všechny zdi na plné HP. Zabíjením nepřátel věžemi se plní „Kolečka se točí" — vylepšení této schopnosti. Cooldown 17 s.' },
  knez:       { name:'Vzkříšení',      icon:'✨', cd:0, desc:'Oživí všechny padlé hrdiny v okruhu 220 na 60 % HP, vyléčí živé o 60 HP a spálí nemrtvé za 40 v okruhu 130. Použitelné 1× za kolo.' },
  nekromant:  { name:'Povstaňte!',     icon:'💀', cd:1140, desc:'Vyvolá 3 kostlivé bojovníky (90 HP, 15 poškození), kteří 12 s bojují po tvém boku. Cooldown 19 s.' },
};
const SKELETON = { name:'Kostlivec', arch:'MELEE', hp:90, dmg:15, range:44, rate:26, speed:1.15, seek:270, color:'#d8d0b0' };
const SKELETON_COUNT = 3;
const SKELETON_LIFETIME = 720;   // 12 s

/* ---------- Balanc konstanty pro přepracované schopnosti (čísla = přesně to, co se stane) ---------- */
const CLAN_AXEMAN = { name:'Sekerník klanu', arch:'MELEE', hp:200, dmg:22, range:46, rate:26, speed:1.25, seek:280, color:'#d07038' };
const CLAN_LIFETIME = 480;          // 8 s život sekerníka (mimo dřívější odchod)
const CLAN_DISMISS_HP = 0.65;       // sekerníci odejdou, když berserk vystoupá nad 65 % HP
const CLAN_COOLDOWN = 2400;         // 40 s cooldown po odchodu sekerníků
const BERSERK_HP_GATE = 0.50;       // volání klanu jen při ≤ 50 % HP

const ABOM_DURATION = 540;          // 9 s proměny (dřív 10)
const ABOM_DR = 0.35;               // −35 % obdrženého poškození (dřív −50)
const ABOM_SPEEDMUL = 0.62;         // −38 % rychlost
const ABOM_HP_PER_EAT = 1;          // +1 max HP navždy za sežraného pěšáka (dřív +2)
const ABOM_HP_CAP = 140;            // strop trvalého navýšení HP ze žraní (proti nekonečnému snowballu)
const ABOM_ACID_RADIUS = 46;        // dosah žíraviny
const ABOM_ACID_BURST = 20;         // 20 poškození každých 2,5 s
const ABOM_ACID_BURST_CD = 150;     // 2,5 s
const ABOM_ACID_DPS = 4;            // + 4 dmg/s (2 za 0,5 s) žíravinou
const BILE_PER_POTION = 6;          // 6 žlučí = 1 lektvar (dřív 5)
const BILE_MAX_POTIONS = 2;         // max 2 lektvary
const BILE_DROP_CHANCE = 0.10;      // 10 % šance, že z běžné zombie vyteče žluč (dřív 14)
const BILE_HARVEST_TIME = 60;       // podržet 1 s pro sběr žluči

const MAG_METEOR_DMG = 130;         // poškození meteoru (vybalancováno – dřív 220)
const MAG_METEOR_RADIUS = 78;
const MAG_METEOR_DOT = { dps: 16, dur: 180 };  // ohnivá zem 16/s po 3 s

/* ---------- PAKTY (roguelite modifikátory běhu) ----------
   Před 1. mapou a při každém přechodu na novou mapu si hráč vybere 1 ze 3 náhodných paktů.
   Platí do konce běhu a sčítají se. Každý má jasnou výhodu i cenu (číselně v popisu).      */
const PACTS = {
  krvezizen:  { name:'Krvežíznivost',      icon:'🩸', desc:'Nepřátelé mají +20 % HP, ale dávají +45 % gemů.',            enemyHp:1.20, gem:1.45 },
  krehci:     { name:'Křehcí, ale zuřiví', icon:'⚡', desc:'Nepřátelé mají −30 % HP, ale jsou o 25 % rychlejší.',        enemyHp:0.70, enemySpd:1.25 },
  horda:      { name:'Neustálá horda',     icon:'🧟', desc:'+35 % počet nepřátel ve vlnách, ale +35 % zkušeností (XP).', count:1.35, xp:1.35 },
  hojnost:    { name:'Zlatá hojnost',      icon:'💰', desc:'+70 % šance na drop z nepřátel, ale bossové mají +18 % HP.', drop:1.70, bossHp:1.18 },
  disciplina: { name:'Železná disciplína', icon:'⚔', desc:'+15 % poškození všemi zbraněmi, ale únik nepřítele bere bráně +1 život navíc.', dmg:1.15, leak:1 },
  lov:        { name:'Lovecká odměna',     icon:'🎯', desc:'Elity se objevují 2× častěji a dávají +50 % gemů.',          eliteChance:2.0, eliteGem:1.5 },
  spech:      { name:'Krvavý spěch',       icon:'⏱', desc:'Nepřátelé se spawnují o 25 % rychleji, ale +20 % skóre.',    spawn:0.75, score:1.20 },
  masakr:     { name:'Řež',                icon:'💥', desc:'Kombo roste 2× rychleji (víc gemů i skóre), ale nepřátelé +8 % poškození.', comboRate:2.0, enemyDmg:1.08 },
  pevnost:    { name:'Poslední pevnost',   icon:'🏰', desc:'Brána má +8 životů, ale nepřátelé jsou o 10 % rychlejší.',   gateBonus:8, enemySpd:1.10 },
  arkany:     { name:'Prokletí many',      icon:'🔮', desc:'+35 % regenerace many a −15 % cooldown schopností, ale −10 % max HP.', manaRegen:1.35, cd:0.85, maxHp:0.90 },
  vlcihlad:   { name:'Vlčí hlad',          icon:'🐺', desc:'+28 % poškození, ale nepřátelé udělí o 12 % víc.',         dmg:1.28, enemyDmg:1.12 },
  zatraceni:  { name:'Zatracení',          icon:'☠', desc:'+60 % počet nepřátel, ale +25 % gemů i XP.',              count:1.60, gem:1.25, xp:1.25 },
  krveproliti:{ name:'Krveprolití',        icon:'🩸', desc:'Elity 3× častěji, ale bossové +25 % HP.',                  eliteChance:3.0, bossHp:1.25 },
  lakomec:    { name:'Lakomec',            icon:'🪙', desc:'+100 % dropů z nepřátel, ale −15 % max HP.',               drop:2.0, maxHp:0.85 },
  najezd:     { name:'Bleskový nájezd',    icon:'⚡', desc:'Nepřátelé se spawnují o 35 % rychleji, ale +30 % gemů.',   spawn:0.65, gem:1.30 },
  posedlost:  { name:'Posedlost',          icon:'👁', desc:'−15 % cooldown schopností a +25 % many, ale nepřátelé +15 % HP.', cd:0.85, manaRegen:1.25, enemyHp:1.15 },
};
const PACT_KEYS = Object.keys(PACTS);

/* ---------- ASCENSION / NEKONEČNO (FÁZE 4.1) ----------
   Po poražení Pekelného pána ve vlně FINAL_WAVE si hráč může zvolit „Vstoupit do Nekonečna": běh
   pokračuje TÝMŽ postupem (stejná postava/zbraně/vylepšení) na vlny FINAL_WAVE+1…, zůstává na poslední
   mapě a každých 25 vln za FINAL_WAVE (FINAL_WAVE+25, +50, …) se run.ascension zvýší o 1 → přibude
   další prokletí z tohoto cyklického seznamu. Efekt je SOUČIN násobičů prvních `run.ascension` prokletí
   (cyklicky, viz ascensionMul() v game.js) — s ascension=0 (běžná hra, vlny 1..FINAL_WAVE) vrací vždy
   1× (žádný efekt). Čísla v `desc` MUSÍ přesně odpovídat hodnotám níže — při změně čísla uprav i popis. */
const ASCENSION_CURSES = [
  { id:'tuhost',     name:'Nemrtvá tuhost', icon:'🩹', desc:'Nepřátelé mají +40 % HP.',                 hp:1.40 },
  { id:'zbesilost',  name:'Zběsilost',      icon:'⚡', desc:'Nepřátelé jsou o 25 % rychlejší.',          spd:1.25 },
  { id:'zurivasila', name:'Zuřivá síla',    icon:'💢', desc:'Nepřátelé udělují o 30 % víc poškození.',   dmg:1.30 },
  { id:'presila',    name:'Přesila',        icon:'🧟', desc:'+20 % počet nepřátel ve vlnách.',           count:1.20 },
  { id:'hladbrany',  name:'Hlad brány',     icon:'🩸', desc:'−25 % gemů z nepřátel.',                    gem:0.75 },
  { id:'elitnivpad', name:'Elitní vpád',    icon:'⭐', desc:'+20 % šance na elitního nepřítele.',        eliteChance:1.20 },
];

/* ---------- META-PROGRESE (Svatyně) — trvalá vylepšení účtu za „duše" napříč běhy ----------
   Duše se získávají po každém běhu (dle vlny+skóre) a utrácí v menu za permanentní bonusy.   */
const META_UPGRADES = {
  gems:   { name:'Dědictví',      icon:'💎', desc:'+15 startovních gemů za úroveň.',   per:15,   max:8 },
  hp:     { name:'Odolnost rodu', icon:'❤', desc:'+6 % maximálního HP za úroveň.',     per:0.06, max:8 },
  dmg:    { name:'Zděděná síla',  icon:'⚔', desc:'+4 % poškození za úroveň.',          per:0.04, max:8 },
  luck:   { name:'Štěstěna',      icon:'🍀', desc:'+8 % gemů z nepřátel za úroveň.',    per:0.08, max:6 },
  reaper: { name:'Žnec duší',     icon:'💀', desc:'+15 % duší získaných z běhu.',       per:0.15, max:6 },
};
const META_KEYS = Object.keys(META_UPGRADES);
function metaCost(lvl) { return 8 + lvl * 7; }   // cena další úrovně v duších

// Kněz – pasivní sekundární AOE: „Svatá záře" pravidelně pálí nemrtvé kolem něj.
const PRIEST_NOVA = { dmg: 55, radius: 120, cd: 140 };   // 55 poškození (× svěcené) v okruhu 120 každých ~2,3 s
const KNIGHT_BLOCK_TIME = 45;       // 0,75 s okno bloku (základ; +štít vylepšení)
const HUNTER_FLURRY_TIME = 300;     // 5 s smršť
const SCOUT_INVIS_TIME = 300;       // 5 s neviditelnost
const SCOUT_CD = 600;               // 10 s (reset při zabití silnějšího)

// Vylepšení štítu rytíře (kupuje se za gemy v záložce Postava; sdílené):
const SHIELD_UP_MAX = 5;
function shieldBlockTime(lvl) { return KNIGHT_BLOCK_TIME + lvl * 12; }   // +0,2 s za úroveň
function shieldReflect(lvl) { return lvl * 0.20; }                       // odraz 20 % poškození za úroveň
function shieldUpCost(lvl) { return 60 + lvl * 55; }

// „Kolečka se točí" — vylepšení Polní věže inženýra (malé opakovatelné kousky):
const WHEEL_UPGRADES = {
  dmg:   { name:'Ostřejší šrouby',  icon:'⚙', desc:'+20 % poškození polní věže.', max:6 },
  dur:   { name:'Delší baterie',    icon:'🔋', desc:'+3 s výdrž polní věže.',      max:6 },
  rate:  { name:'Promazané ozubí',  icon:'🛢', desc:'+15 % rychlost palby věže.',  max:6 },
  count: { name:'Dvojče',           icon:'🔩', desc:'+1 věž postavená naráz.',      max:3 },
  hp:    { name:'Pancéřování věže',  icon:'🛡', desc:'+40 % HP polní věže.',         max:5 },
};
const WHEEL_KEYS = Object.keys(WHEEL_UPGRADES);

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

/* ---------- Trvalé buffy (padají ze sub-bossů; každý hráč si vybírá vlastní, platí do konce hry) ----------
   Číselná pole = efekt (sečtou se přes všechny vlastněné buffy × počet). `cap` = kolikrát lze vzít.
   `desc` musí přesně odpovídat číslům (hráč musí vědět, co buff dělá).                                    */
const PERKS = {
  // — Poškození —
  ostri1:     { name:'Ostří I',        icon:'⚔', desc:'+7 % poškození všemi zbraněmi.',        dmgPct:0.07, cap:5 },
  ostri2:     { name:'Ostří II',       icon:'⚔', desc:'+12 % poškození všemi zbraněmi.',       dmgPct:0.12, cap:5 },
  titan:      { name:'Titánská síla',  icon:'💪', desc:'+18 % poškození všemi zbraněmi.',       dmgPct:0.18, cap:3 },
  brutalita:  { name:'Brutalita',      icon:'🔨', desc:'+25 % poškození (vzácné).',             dmgPct:0.25, cap:2 },
  // — Kritické zásahy —
  mireni1:    { name:'Míření I',       icon:'✦', desc:'+6 % šance na kritický zásah.',          critAdd:0.06, cap:5 },
  mireni2:    { name:'Míření II',      icon:'✦', desc:'+10 % šance na kritický zásah.',         critAdd:0.10, cap:3 },
  devastace:  { name:'Devastace',      icon:'💥', desc:'+0,6 ke kritickému násobiči (silnější krity).', critMulAdd:0.6, cap:3 },
  hlava:      { name:'Rána do hlavy',  icon:'🎯', desc:'+8 % kritika a +0,3 kritický násobič.', critAdd:0.08, critMulAdd:0.3, cap:2 },
  // — Rychlost palby —
  hbitost1:   { name:'Hbitost I',      icon:'⚡', desc:'−8 % prodleva mezi útoky (rychlejší palba).',  ratePct:0.08, cap:5 },
  hbitost2:   { name:'Hbitost II',     icon:'⚡', desc:'−14 % prodleva mezi útoky.',                    ratePct:0.14, cap:3 },
  salva:      { name:'Salva',          icon:'🔁', desc:'−20 % prodleva mezi útoky (vzácné).',           ratePct:0.20, cap:2 },
  // — Rychlost pohybu —
  mrstnost1:  { name:'Mrštnost I',     icon:'👟', desc:'+8 % rychlost pohybu.',                 speedPct:0.08, cap:5 },
  mrstnost2:  { name:'Mrštnost II',    icon:'👟', desc:'+14 % rychlost pohybu.',                speedPct:0.14, cap:3 },
  vitr:       { name:'Vítr v zádech',  icon:'🌀', desc:'+20 % rychlost pohybu (vzácné).',       speedPct:0.20, cap:2 },
  // — Max HP —
  vitalita1:  { name:'Vitalita I',     icon:'❤', desc:'+12 % maximální HP.',                    maxHpPct:0.12, cap:5 },
  vitalita2:  { name:'Vitalita II',    icon:'❤', desc:'+20 % maximální HP.',                    maxHpPct:0.20, cap:3 },
  kolos:      { name:'Kolos',          icon:'🗿', desc:'+30 % maximální HP (vzácné).',          maxHpPct:0.30, cap:2 },
  // — Pancíř —
  pancir1:    { name:'Pancíř I',       icon:'🛡', desc:'−8 % obdrženého poškození.',            armorPct:0.08, cap:5 },
  pancir2:    { name:'Pancíř II',      icon:'🛡', desc:'−14 % obdrženého poškození.',           armorPct:0.14, cap:3 },
  kamennakuze:{ name:'Kamenná kůže',   icon:'🪨', desc:'−20 % obdrženého poškození (vzácné).',  armorPct:0.20, cap:2 },
  // — Vysávání —
  upir1:      { name:'Upír I',         icon:'🩸', desc:'+6 % vysávání životů z poškození.',      lifestealAdd:0.06, cap:4 },
  upir2:      { name:'Upír II',        icon:'🩸', desc:'+12 % vysávání životů z poškození.',     lifestealAdd:0.12, cap:2 },
  // — Dosah —
  dosah1:     { name:'Delší ruka',     icon:'🏹', desc:'+12 % dosah zbraní.',                   rangePct:0.12, cap:4 },
  dosah2:     { name:'Sokolí oko',     icon:'🏹', desc:'+20 % dosah zbraní.',                   rangePct:0.20, cap:2 },
  // — Cooldown schopnosti —
  soustredeni1:{ name:'Soustředění I', icon:'⏱', desc:'−12 % cooldown aktivní schopnosti.',    cdPct:0.12, cap:4 },
  soustredeni2:{ name:'Soustředění II',icon:'⏱', desc:'−20 % cooldown aktivní schopnosti.',    cdPct:0.20, cap:2 },
  // — Sběr / ekonomika —
  magnet1:    { name:'Magnet I',       icon:'🧲', desc:'+40 % dosah sbírání dropů.',            pickupRadiusAdd:0.4, cap:3 },
  magnet2:    { name:'Magnet II',      icon:'🧲', desc:'+80 % dosah sbírání dropů.',            pickupRadiusAdd:0.8, cap:2 },
  hamon1:     { name:'Hamižnost I',    icon:'💎', desc:'+20 % gemů za zabití.',                 gemPct:0.20, cap:4 },
  hamon2:     { name:'Hamižnost II',   icon:'💎', desc:'+35 % gemů za zabití.',                 gemPct:0.35, cap:2 },
  ucenlivost: { name:'Učenlivost',     icon:'📚', desc:'+25 % zkušeností (XP).',                xpPct:0.25, cap:3 },
  // — Regenerace —
  regenerace1:{ name:'Regenerace I',   icon:'✚', desc:'+2 HP za sekundu regenerace.',          regenAdd:2, cap:4 },
  regenerace2:{ name:'Regenerace II',  icon:'✚', desc:'+4 HP za sekundu regenerace.',          regenAdd:4, cap:2 },
  // — Obrana —
  trny1:      { name:'Trny I',         icon:'🌵', desc:'Vrací 25 % obdrženého poškození útočníkovi.', thornsPct:0.25, cap:3 },
  trny2:      { name:'Trny II',        icon:'🌵', desc:'Vrací 45 % obdrženého poškození útočníkovi.',          thornsPct:0.45, cap:2 },
  uhyb1:      { name:'Úhyb I',         icon:'💨', desc:'+8 % šance zcela se vyhnout zásahu.',    dodgeAdd:0.08, cap:3 },
  uhyb2:      { name:'Úhyb II',        icon:'💨', desc:'+14 % šance na úhyb.',                   dodgeAdd:0.14, cap:2 },
  // — Projektily / při zásahu —
  dvojstrela: { name:'Dvojstřela',     icon:'➹', desc:'+1 projektil u dálkových zbraní (mírný rozptyl).', projAdd:1, cap:2 },
  trojstrela: { name:'Trojstřela',     icon:'🏹', desc:'+2 projektily u dálkových zbraní.',     projAdd:2, cap:1 },
  vybuch1:    { name:'Výbušné zabití I',icon:'💣', desc:'20 % šance na výbuch (20 dmg v okolí) při zabití.', explodeChance:0.20, cap:2 },
  vybuch2:    { name:'Výbušné zabití II',icon:'💣',desc:'35 % šance na výbuch (20 dmg v okolí) při zabití.', explodeChance:0.35, cap:1 },
  mraz1:      { name:'Mrazivé zásahy I',icon:'❄', desc:'20 % šance zpomalit zasaženého na 40 % rychlosti (2 s).', freezeChance:0.20, cap:2 },
  mraz2:      { name:'Mrazivé zásahy II',icon:'❄',desc:'35 % šance zpomalit zasaženého na 40 % rychlosti (2 s).', freezeChance:0.35, cap:1 },
  odraz:      { name:'Odhoz',          icon:'🪃', desc:'+4 odhození nepřátel při zásahu zblízka.',knockbackAdd:4, cap:3 },
  setrnost1:  { name:'Šetrnost I',     icon:'🎯', desc:'25 % šance nespotřebovat munici při výstřelu.', ammoSaveChance:0.25, cap:3 },
  setrnost2:  { name:'Šetrnost II',    icon:'🎯', desc:'40 % šance nespotřebovat munici.',       ammoSaveChance:0.40, cap:2 },
  manapoutnik:{ name:'Mana poutník',   icon:'🔮', desc:'+50 % regenerace many (pro kouzelné hole).', manaRegenPct:0.5, cap:3 },
  // — Kombinované (vzácné) —
  berserksrdce:{name:'Srdce berserka', icon:'🔥', desc:'+15 % poškození a +10 % rychlost.',     dmgPct:0.15, speedPct:0.10, cap:2 },
  svatyamulet:{ name:'Svatý amulet',   icon:'✨', desc:'+15 % max HP a −10 % obdrženého poškození.', maxHpPct:0.15, armorPct:0.10, cap:2 },
  lovecstinu: { name:'Lovec stínů',    icon:'🗡', desc:'+10 % kritika a +12 % dosah.',           critAdd:0.10, rangePct:0.12, cap:2 },
  valecnik:   { name:'Veterán',        icon:'⚔', desc:'+12 % poškození a +12 % max HP.',        dmgPct:0.12, maxHpPct:0.12, cap:2 },
  rychlopal:  { name:'Rychlopalník',   icon:'🔥', desc:'−12 % prodleva palby a +8 % rychlost.', ratePct:0.12, speedPct:0.08, cap:2 },
  pretlak:    { name:'Přetlak',        icon:'💥', desc:'+8 % poškození a +0,5 kritický násobič.',dmgPct:0.08, critMulAdd:0.5, cap:2 },
};
const PERK_KEYS = Object.keys(PERKS);   // 53 trvalých buffů (≥ 50 dle zadání)

// Vylepšení zbraní se platí MATERIÁLY (dřevo + ocel, drop z nepřátel), ne gemy.
const WEAPON_UP_MAX = 6;
function weaponUpMat(lvl) { return { wood: 2 + lvl * 2, steel: 1 + lvl }; }   // cena na další úroveň
const MATERIALS = { wood: { name: 'Dřevo', icon: '🪵', color: '#8a5c30' }, steel: { name: 'Ocel', icon: '⛓', color: '#b8bcc4' } };
const MAX_WARRIORS = 8;   // limit spojenců na mapě

/* ---------- Odměny a progrese ---------- */
const GEMS_PER_KILL_MUL = 0.4;        // × bounty nepřítele (razantně sníženo)
function waveReward(wave) { return Math.round(Math.min(240, 18 + 26 * Math.log2(wave + 1))); }   // bonus gemů za dokončení vlny (zploštěno, strop 240)
function xpForKill(e) { return Math.round((e.score || 10) / 5); }
function xpToLevel(level) { return 100 + (level - 1) * 60; } // XP na další úroveň profilu

/* ---------- LocalStorage klíče ---------- */
const PROFILE_KEY = 'rytiri_profile_v1';
const SCORES_KEY  = 'rytiri_scores_v1';
