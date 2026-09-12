/**
 * Unified player hook — one AudioEngine (one <audio> element) driven by a
 * track-source adapter. Replaces the old useAudioPlayer/useSpotifyPlayer pair,
 * which duplicated transport logic and leaked audio on source switch.
 *
 * adapter: { load(track) -> Promise<{ src, art? }|null>, prefetch?(track) }
 *
 * Behavior: next/prev always resume playback (streaming behavior, kept for
 * consistency); prev restarts the track if >3s in.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { AudioEngine } from './audio/AudioEngine.js';

export default function usePlayer(tracks, playMode = 'normal', adapter) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = new AudioEngine();
  const engine = engineRef.current;
  const audio = engine.audio;

  const playModeRef = useRef(playMode);
  playModeRef.current = playMode;
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  // Shared between prefetch, next(), and onEnded so we play what we warmed
  const nextIdxRef = useRef(null);
  const [trackIndex, setTrackIndex] = useState(0);

  // Reset on playlist/source change — a stale index can be out of bounds
  const prevTracksRef = useRef(tracks);
  if (prevTracksRef.current !== tracks) {
    prevTracksRef.current = tracks;
    nextIdxRef.current = null;
    if (trackIndex !== 0) setTrackIndex(0);
  }
  const [isPlaying, setIsPlaying] = useState(false);
  // Ref so the async load effect sees the latest value when it resolves,
  // not the one captured when it started
  const isPlayingRef = useRef(false);
  isPlayingRef.current = isPlaying;
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [loading, setLoading] = useState(false);
  const [resolvedArt, setResolvedArt] = useState(null);
  const [volume, setVolumeState] = useState(() => {
    const saved = localStorage.getItem('cupid-volume');
    return saved !== null ? parseFloat(saved) : 1;
  });
  const [muted, setMuted] = useState(false);

  audio.volume = muted ? 0 : volume;

  const baseTrack = tracks[trackIndex] ?? {
    title: 'No track',
    artist: '',
    art: null,
    file: '',
    uri: null,
  };
  const track = { ...baseTrack, art: resolvedArt || baseTrack.art };

  // ── Load track when index, tracks, or adapter change ──────
  useEffect(() => {
    const t = tracks[trackIndex];
    if (!t) {
      setResolvedArt(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const res = await adapter.load(t);
        if (cancelled) return;
        setResolvedArt(res?.art ?? null);
        if (!res?.src) return;
        // setting src triggers loading; an explicit audio.load() would reset it
        audio.src = res.src;
        setProgress(0);
        setCurrentTime(0);
        setDuration(0);
        if (isPlayingRef.current) {
          engine.play().catch(() => {});
        }
      } catch (err) {
        console.error('Failed to load track:', err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [trackIndex, tracks, adapter]);

  // ── Precompute next index + prefetch surrounding tracks ───
  useEffect(() => {
    if (tracks.length === 0) {
      nextIdxRef.current = null;
      return;
    }

    let nextIdx;
    if (playMode === 'shuffle' && tracks.length > 1) {
      do {
        nextIdx = Math.floor(Math.random() * tracks.length);
      } while (nextIdx === trackIndex);
    } else {
      nextIdx = (trackIndex + 1) % tracks.length;
    }
    nextIdxRef.current = nextIdx;

    const prefetch = adapter.prefetch;
    if (!prefetch) return;

    const prefetched = new Set([trackIndex]);
    const warm = (idx) => {
      if (idx < 0 || idx >= tracks.length || prefetched.has(idx)) return;
      prefetched.add(idx);
      prefetch(tracks[idx]);
    };

    warm(nextIdx);
    // Shuffle's second hop is unpredictable, so only look ahead in linear mode
    if (playMode !== 'shuffle') {
      warm((trackIndex + 2) % tracks.length);
      warm((trackIndex - 1 + tracks.length) % tracks.length);
    }
  }, [trackIndex, tracks, playMode, adapter]);

  // ── Audio event listeners ─────────────────────────────────
  useEffect(() => {
    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      if (audio.duration) {
        setProgress(audio.currentTime / audio.duration);
      }
    };

    const onLoadedMetadata = () => {
      setDuration(audio.duration);
    };

    const onEnded = () => {
      if (playModeRef.current === 'repeat') {
        audio.currentTime = 0;
        engine.play().catch(() => {});
        return;
      }
      setTrackIndex((prev) => {
        if (tracks.length === 0) return 0;
        if (nextIdxRef.current !== null && nextIdxRef.current !== prev) {
          return nextIdxRef.current;
        }
        if (playModeRef.current === 'shuffle' && tracks.length > 1) {
          let next;
          do { next = Math.floor(Math.random() * tracks.length); } while (next === prev);
          return next;
        }
        return (prev + 1) % tracks.length;
      });
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
    };
  }, [tracks.length]);

  // ── Playback controls ────────────────────────────────────

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      engine.pause();
      setIsPlaying(false);
    } else {
      engine.play().catch(() => {});
      setIsPlaying(true);
    }
  }, [isPlaying, engine]);

  const next = useCallback(() => {
    setTrackIndex((prev) => {
      if (tracks.length === 0) return 0;
      // Prefer the precomputed next (matches what prefetch warmed)
      if (nextIdxRef.current !== null && nextIdxRef.current !== prev) {
        return nextIdxRef.current;
      }
      if (playModeRef.current === 'shuffle' && tracks.length > 1) {
        let n;
        do { n = Math.floor(Math.random() * tracks.length); } while (n === prev);
        return n;
      }
      return (prev + 1) % tracks.length;
    });
    setIsPlaying(true);
  }, [tracks.length]);

  const prev = useCallback(() => {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
    } else {
      setTrackIndex((p) => {
        if (tracks.length === 0) return 0;
        return (p - 1 + tracks.length) % tracks.length;
      });
    }
    setIsPlaying(true);
  }, [tracks.length, audio]);

  const seek = useCallback((fraction) => {
    if (audio.duration) {
      audio.currentTime = Math.min(fraction, 1) * audio.duration;
    }
  }, [audio]);

  const setVolume = useCallback((v) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    audio.volume = clamped;
    localStorage.setItem('cupid-volume', clamped);
    if (clamped > 0) setMuted(false);
  }, [audio]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      audio.volume = m ? volume : 0;
      return !m;
    });
  }, [volume, audio]);

  return {
    track,
    trackIndex,
    isPlaying,
    progress,
    duration,
    currentTime,
    togglePlay,
    next,
    prev,
    seek,
    volume,
    setVolume,
    muted,
    toggleMute,
    loading,
    engine,
  };
}
