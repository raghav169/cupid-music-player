/**
 * Track-source adapters — each resolves a track to a playable { src, art }
 * for the unified player. `prefetch` is optional; the streaming adapter uses
 * it to warm the main-process stream cache for adjacent tracks.
 */

// Local files via the cupid-local:// protocol (or ./<file> in browser preview).
export function createLocalAdapter(getAudioPath) {
  return {
    async load(t) {
      if (!t?.file) return null;
      let src;
      let art = null;
      if (getAudioPath) {
        src = await getAudioPath(t.file);
        if (t.art) art = await getAudioPath(t.art);
      } else {
        src = `./${t.file}`;
        if (t.art) art = `./${t.art}`;
      }
      return src ? { src, art } : null;
    },
  };
}

// Streaming tracks (spotify/apple/youtube) — resolved to cupid-audio:// URLs
// in the main process via youtubei.js search + yt-dlp extraction.
export const streamAdapter = {
  async load(t) {
    const src = t.videoId
      ? await window.cupid.getStreamUrlById(t.videoId)
      : await window.cupid.getStreamUrl(t.title, t.artist);
    return { src, art: t.art ?? null };
  },
  prefetch(t) {
    if (!t) return;
    const p = t.videoId
      ? window.cupid.getStreamUrlById(t.videoId)
      : window.cupid.getStreamUrl(t.title, t.artist);
    p.catch(() => {});
  },
};
