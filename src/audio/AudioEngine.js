/**
 * AudioEngine — owns the single <audio> element and (lazily) the Web Audio
 * graph: MediaElementSource → AnalyserNode → destination. Phase 1 inserts a
 * BiquadFilter EQ chain between source and analyser.
 *
 * The graph requires CORS-clean media, so the element uses
 * crossOrigin='anonymous' — both cupid-local:// and cupid-audio:// send
 * Access-Control-Allow-Origin: * from the main process.
 */
// 10-band EQ: lowshelf → 8 peaking → highshelf
export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const EQ_PRESETS = {
  flat:   [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass:   [7, 6, 4, 2, 0, 0, 0, -1, -1, -1],
  vocal:  [-2, -1, 0, 2, 4, 4, 3, 1, 0, 0],
  bright: [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6],
  warm:   [3, 3, 2, 1, 0, 0, -1, -1, -1, 0],
  dance:  [5, 4, 2, 0, 0, -1, -1, 0, 3, 4],
};

export class AudioEngine {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
    this._ctx = null;
    this.analyser = null;
    this._source = null;
    this._filters = [];
    this._eqGains = new Array(EQ_BANDS.length).fill(0);
  }

  // Lazily build the Web Audio graph: source → EQ chain → analyser → out.
  // Electron's default autoplay policy allows the context to start running;
  // in a plain browser it resumes on the first user-gesture play().
  ensureGraph() {
    if (this._ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      this._ctx = new Ctx();
      this._source = this._ctx.createMediaElementSource(this.audio);

      this._filters = EQ_BANDS.map((freq, i) => {
        const f = this._ctx.createBiquadFilter();
        f.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
        f.frequency.value = freq;
        if (f.type === 'peaking') f.Q.value = 1;
        f.gain.value = this._eqGains[i];
        return f;
      });

      this.analyser = this._ctx.createAnalyser();
      this.analyser.fftSize = 64;
      this.analyser.smoothingTimeConstant = 0.8;

      // Chain: source → filters → analyser → destination
      let node = this._source;
      for (const f of this._filters) { node.connect(f); node = f; }
      node.connect(this.analyser);
      this.analyser.connect(this._ctx.destination);
    } catch {
      // No Web Audio — element still plays direct to destination
      this._ctx = null;
      this.analyser = null;
      this._filters = [];
    }
  }

  // gains: array of dB values, one per EQ_BANDS entry. Safe to call before
  // the graph exists — stored and applied when it's built.
  setEq(gains) {
    this._eqGains = gains.slice(0, EQ_BANDS.length);
    this._filters.forEach((f, i) => {
      if (this._eqGains[i] !== undefined) f.gain.value = this._eqGains[i];
    });
  }

  async play() {
    this.ensureGraph();
    if (this._ctx?.state === 'suspended') {
      try { await this._ctx.resume(); } catch { /* stays suspended until a gesture */ }
    }
    return this.audio.play();
  }

  pause() {
    this.audio.pause();
  }
}
