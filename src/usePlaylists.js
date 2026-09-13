import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * User playlists — { [name]: [track, ...] } persisted to
 * userData/playlists.json via IPC. Tracks use the unified model:
 * { source, title, artist, album, art, durationMs, file?, videoId?, uri? }
 */
export default function usePlaylists() {
  const [playlists, setPlaylists] = useState(null); // null = still loading
  const loadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(window.cupid?.loadPlaylists?.())
      .then((p) => {
        if (cancelled) return;
        const loaded = p && typeof p === 'object' ? p : {};
        // Edits made before the load resolves win over the disk state
        setPlaylists((cur) => (cur ? { ...loaded, ...cur } : loaded));
      })
      .catch(() => { if (!cancelled) setPlaylists((cur) => cur ?? {}); });
    return () => { cancelled = true; };
  }, []);

  // Persist on change (debounced), skipping the initial load
  useEffect(() => {
    if (playlists === null) return;
    if (!loadedRef.current) { loadedRef.current = true; return; }
    const t = setTimeout(() => {
      window.cupid?.savePlaylists?.(playlists)?.catch?.(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [playlists]);

  const create = useCallback((name) => {
    const n = name?.trim();
    if (!n) return;
    setPlaylists((p) => (p && n in p ? p : { ...p, [n]: [] }));
  }, []);

  const remove = useCallback((name) => {
    setPlaylists((p) => {
      const next = { ...p };
      delete next[name];
      return next;
    });
  }, []);

  const rename = useCallback((from, to) => {
    const n = to?.trim();
    if (!n || n === from) return;
    setPlaylists((p) => {
      if (!p || !(from in p) || n in p) return p;
      const next = { ...p, [n]: p[from] };
      delete next[from];
      return next;
    });
  }, []);

  const addTrack = useCallback((name, track) => {
    setPlaylists((p) => ({ ...p, [name]: [...(p?.[name] || []), track] }));
  }, []);

  const removeTrack = useCallback((name, idx) => {
    setPlaylists((p) => ({
      ...p,
      [name]: (p?.[name] || []).filter((_, i) => i !== idx),
    }));
  }, []);

  return { playlists: playlists ?? {}, create, remove, rename, addTrack, removeTrack };
}
