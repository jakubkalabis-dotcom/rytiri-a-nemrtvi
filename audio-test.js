// Ověří, že audio kód (engine.js) NEHÁZÍ proti realistickému AudioContextu
// (harness má jen minimální mock a initAudio nevolá). Zachytí špatné použití Web Audio API.
const fs = require('fs'), path = require('path'), vm = require('vm');
const DIR = __dirname;
const noop = () => undefined;
const param = () => ({ value: 0, setValueAtTime: noop, exponentialRampToValueAtTime: noop, linearRampToValueAtTime: noop, cancelScheduledValues: noop });
function node(extra) { return Object.assign({ connect: (d) => d || node(), disconnect: noop, start: noop, stop: noop }, extra); }
function AC() {
  return {
    sampleRate: 44100, currentTime: 0, state: 'running', destination: node(), resume: noop,
    createGain: () => node({ gain: param() }),
    createOscillator: () => node({ type: 'sine', frequency: param(), detune: param() }),
    createBufferSource: () => node({ buffer: null }),
    createBiquadFilter: () => node({ type: 'lowpass', frequency: param(), Q: param() }),
    createDynamicsCompressor: () => node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createConvolver: () => node({ buffer: null }),
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
  };
}
const ctxProxy = new Proxy({}, { get: () => noop, set: () => true });
const fakeEl = () => { const el = { style: {}, dataset: {}, classList: { add: noop, remove: noop, contains: () => false }, addEventListener: noop, appendChild: noop, getContext: () => ctxProxy, querySelectorAll: () => [], width: 480, height: 800, getBoundingClientRect: () => ({}) }; let h = ''; Object.defineProperty(el, 'innerHTML', { get: () => h, set: v => { h = v; } }); return el; };
const store = {};
const sandbox = {
  console, document: { getElementById: () => fakeEl(), createElement: () => fakeEl(), addEventListener: noop, body: fakeEl(), documentElement: fakeEl(), querySelector: () => null },
  navigator: { vibrate: noop }, performance: { now: () => 0 },
  localStorage: { getItem: () => null, setItem: noop }, requestAnimationFrame: noop, setTimeout: (f) => { try { f(); } catch (e) {} }, clearTimeout: noop, setInterval: noop,
  AudioContext: AC, webkitAudioContext: AC, Audio: function () { return { play: noop }; }, Peer: function () { return { on: noop }; }, Image: function () { return {}; },
  Math, Date, JSON, Object, Array, Number, String, Boolean, Float32Array, isNaN, parseInt, parseFloat, Infinity, NaN, undefined,
};
sandbox.window = sandbox; sandbox.addEventListener = noop; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
let code = '';
for (const f of ['data.js', 'engine.js', 'game.js', 'net.js']) code += fs.readFileSync(path.join(DIR, f), 'utf8') + '\n';
code += `
;(function AUDIO(){
  muted = false;
  initAudio();
  if (!actx) throw new Error('initAudio nevytvořil actx');
  for (const k of Object.keys(sfx)) { try { sfx[k](); } catch(e){ throw new Error('sfx.'+k+' HÁŽE: '+e.message); } }
  startDrone(); stopDrone(); startDrone(); startDrone(); stopDrone();
  console.log('AUDIO OK — initAudio + všech '+Object.keys(sfx).length+' sfx + dron bez chyby');
})();
`;
try { vm.runInContext(code, sandbox, { filename: 'bundle.js' }); }
catch (e) { console.error('AUDIO FAIL:', e && e.message); process.exit(1); }
