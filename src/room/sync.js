/**
 * Listen Together — host-authoritative sync math (pure, testable).
 *
 * Host broadcasts: { type:'state', track, position, isPlaying, sentAt }
 *   position = audio.currentTime at send, sentAt = host Date.now()
 * Guest computes what to do: load a different track, seek, or toggle play.
 */

export const DRIFT_TOLERANCE_S = 0.4;

export function sameTrack(a, b) {
  if (!a || !b) return false;
  // Strong IDs first
  if (a.videoId && b.videoId) return a.videoId === b.videoId;
  if (a.uri && b.uri) return a.uri === b.uri;
  if (a.file && b.file) return a.file === b.file;
  return !!a.title && a.title === b.title && a.artist === b.artist;
}

/**
 * @param host   { track, position, isPlaying, sentAt }
 * @param guest  { track, currentTime, isPlaying, duration }
 * @param now    guest's Date.now() when the message arrived
 * @returns      { loadTrack?, seek?, playing? } — nulls mean "do nothing"
 */
export function computeGuestActions(host, guest, now = Date.now()) {
  const actions = { loadTrack: null, seek: null, playing: null };
  if (!host?.track) return actions;

  if (!sameTrack(guest.track, host.track)) {
    actions.loadTrack = host.track;
    actions.playing = host.isPlaying;
    actions.seek = host.isPlaying
      ? host.position + (now - host.sentAt) / 1000
      : host.position;
    return actions;
  }

  // Where the host is right now ≈ position + time elapsed since send
  const expected = host.isPlaying
    ? host.position + (now - host.sentAt) / 1000
    : host.position;
  if (Math.abs(guest.currentTime - expected) > DRIFT_TOLERANCE_S) {
    actions.seek = expected;
  }
  if (guest.isPlaying !== host.isPlaying) actions.playing = host.isPlaying;
  return actions;
}
