/**
 * AudioEngine — owns the single <audio> element and (lazily) the Web Audio
 * graph: MediaElementSource → AnalyserNode → destination. Phase 1 inserts a
 * BiquadFilter EQ chain between source and analyser.
 *
 * The graph requires CORS-clean media, so the element uses
 * crossOrigin='anonymous' — both cupid-local:// and cupid-audio:// send
 * Access-Control-Allow-Origin: * from the main process.
 */
export class AudioEngine {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
    this._ctx = null;
    this.analyser = null;
    this._source = null;
  }

  // Lazily build the Web Audio graph. Electron's default autoplay policy
  // allows the context to start running; in a plain browser it resumes on
  // the first user-gesture play().
  ensureGraph() {
    if (this._ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      this._ctx = new Ctx();
      this._source = this._ctx.createMediaElementSource(this.audio);
      this.analyser = this._ctx.createAnalyser();
      this.analyser.fftSize = 64;
      this.analyser.smoothingTimeConstant = 0.8;
      this._source.connect(this.analyser);
      this.analyser.connect(this._ctx.destination);
    } catch {
      // No Web Audio — element still plays direct to destination
      this._ctx = null;
      this.analyser = null;
    }
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
