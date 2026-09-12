import { useState, useCallback } from 'react';

const STATS_KEY = 'cupid-stats';
const RECENTS_KEY = 'cupid-recents';
const MAX_RECENTS = 25;

function loadJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full/blocked */ }
}

function keyOf(track) {
  return `${track?.source ?? 'local'}|${track?.title ?? ''}|${track?.artist ?? ''}`;
}

/**
 * Playback stats + recently played, kept in localStorage.
 * stats: { [trackKey]: { track, plays, lastPlayed } }
 * recents: [{ track, at }] newest-first, deduped by track.
 */
export default function useStats() {
  const [stats, setStats] = useState(() => loadJson(STATS_KEY, {}));
  const [recents, setRecents] = useState(() => loadJson(RECENTS_KEY, []));

  const recordPlay = useCallback((track) => {
    if (!track?.title) return;
    const key = keyOf(track);
    setStats((s) => {
      const prev = s[key] || { plays: 0 };
      const next = { ...s, [key]: { track, plays: prev.plays + 1, lastPlayed: Date.now() } };
      saveJson(STATS_KEY, next);
      return next;
    });
    setRecents((r) => {
      const next = [{ track, at: Date.now() }, ...r.filter((x) => keyOf(x.track) !== key)]
        .slice(0, MAX_RECENTS);
      saveJson(RECENTS_KEY, next);
      return next;
    });
  }, []);

  return { stats, recents, recordPlay };
}
