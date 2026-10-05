/**
 * AudioEngine — owns the single <audio> element and (lazily) the Web Audio
 * graph: MediaElementSource → AnalyserNode → destination. Phase 1 inserts a
 * BiquadFilter EQ chain between source and analyser.
 *
 * The graph requires CORS-clean media, so the element uses
 * crossOrigin='anonymous' — the loopback media server (127.0.0.1) sends
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
    // Automix: a second <audio> element preloads the next track and fades
    // in through `_nextGain` while `_fade` (the primary's gain) ramps out.
    this._fade = null;
    this._next = null;
    this._nextSource = null;
    this._nextGain = null;
    this._nextErrorHandler = null;
    this._crossfading = false;
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
      this._fade = this._ctx.createGain(); // primary fade — automix dips this

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

      // Chain: source → fade → filters → analyser → destination.
      // The crossfade deck connects a second source+gain into filters[0]
      // (multiple inputs sum), so both decks share EQ + analyser.
      this._source.connect(this._fade);
      let node = this._fade;
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

  get crossfading() { return this._crossfading; }
  // An incoming deck exists (prepared or mid-fade) — usePlayer reads this
  // instead of touching the private field
  get nextArmed() { return this._next != null; }

  // Preload the next track on a second deck, silent until startCrossfade.
  // Returns false without Web Audio (automix needs gain nodes).
  prepareNext(url) {
    if (!this._ctx || !this._filters.length || this._next || this._crossfading) return false;
    try {
      const el = new Audio();
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      el.src = url;
      const src = this._ctx.createMediaElementSource(el);
      const g = this._ctx.createGain();
      g.gain.value = 0;
      src.connect(g);
      g.connect(this._filters[0]);
      this._next = el;
      this._nextSource = src;
      this._nextGain = g;
      // A dead incoming deck must not sit silent then get promoted — drop
      // it and restore the primary's gain so normal advance still works
      this._nextErrorHandler = () => this.cancelCrossfade();
      el.addEventListener('error', this._nextErrorHandler, { once: true });
      return true;
    } catch {
      this._next = this._nextSource = this._nextGain = null;
      return false;
    }
  }

  // Overlap the decks: primary gain ramps to 0, next ramps to 1 over `secs`.
  // The primary's natural 'ended' event still fires — usePlayer promotes
  // then, so no JS timer decides the handoff.
  startCrossfade(secs) {
    if (!this._ctx || !this._next || this._crossfading) return false;
    const t = this._ctx.currentTime;
    this._next.volume = this.audio.volume; // match the user's level
    this._next.play().catch(() => {
      // can't play the incoming deck — abandon the fade, keep primary
      this.cancelCrossfade();
    });
    const g = Math.max(0.2, secs);
    this._nextGain.gain.setValueAtTime(0, t);
    this._nextGain.gain.linearRampToValueAtTime(1, t + g);
    this._fade.gain.setValueAtTime(this._fade.gain.value, t);
    this._fade.gain.linearRampToValueAtTime(0, t + g);
    this._crossfading = true;
    return true;
  }

  // Hand the primary slot to the next deck (called when the old primary
  // fires 'ended'). this.audio swaps — callers rebind listeners.
  promoteNext() {
    if (!this._next) return false;
    const old = this.audio;
    try { old.pause(); old.removeAttribute('src'); old.load(); } catch { /* teardown best-effort */ }
    try { this._source.disconnect(); this._fade.disconnect(); } catch { /* already torn */ }
    if (this._nextErrorHandler) {
      this._next.removeEventListener('error', this._nextErrorHandler);
      this._nextErrorHandler = null;
    }
    // Carry the user's volume across — mid-fade volume changes only
    // reached the outgoing element
    this._next.volume = old.volume;
    this.audio = this._next;
    this._source = this._nextSource;
    this._fade = this._nextGain;
    this._next = this._nextSource = this._nextGain = null;
    this._crossfading = false;
    return true;
  }

  // Unwind back to primary-only playback (pause/seek/manual next mid-fade).
  cancelCrossfade() {
    if (this._next) {
      if (this._nextErrorHandler) {
        this._next.removeEventListener('error', this._nextErrorHandler);
        this._nextErrorHandler = null;
      }
      try { this._next.pause(); this._next.removeAttribute('src'); this._next.load(); } catch { /* noop */ }
      try { this._nextSource.disconnect(); this._nextGain.disconnect(); } catch { /* noop */ }
      this._next = this._nextSource = this._nextGain = null;
    }
    if (this._ctx && this._fade) {
      try {
        this._fade.gain.cancelScheduledValues(this._ctx.currentTime);
        this._fade.gain.setValueAtTime(1, this._ctx.currentTime);
      } catch { /* noop */ }
    }
    this._crossfading = false;
  }
}
