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

export default function usePlayer(tracks, playMode = 'normal', adapter, startAtRef, automixSecs = 0) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = new AudioEngine();
  const engine = engineRef.current;
  // engine.audio swaps during a crossfade promote — track it in state so
  // renders/listeners always bind the live element, not a stale capture
  const [audioEl, setAudioEl] = useState(engine.audio);
  const audio = audioEl;

  const playModeRef = useRef(playMode);
  playModeRef.current = playMode;
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const automixSecsRef = useRef(automixSecs);
  automixSecsRef.current = automixSecs;
  // Set by the crossfade promote path: the next index change must NOT
  // reload the element (the new deck is already playing it)
  const promotedRef = useRef(false);
  // Listeners (onTimeUpdate automix arming) need the live track list even
  // when tracks changes without a length change
  const liveTracksRef = useRef(tracks);
  liveTracksRef.current = tracks;
  // Shared between prefetch, next(), and onEnded so we play what we warmed
  const nextIdxRef = useRef(null);
  // Index the crossfade deck actually loaded — set when a fade starts,
  // read at promote so a mid-fade shuffle toggle can't mislabel the track
  const armedNextIdxRef = useRef(null);
  const [trackIndex, setTrackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // Reset on playlist/source change — a stale index can be out of bounds.
  // startAtRef can hold { index, autoPlay, seekTo, playing } to land on a
  // specific track (e.g. clicking a song, or a room guest joining mid-song)
  // instead of resetting to 0.
  // IMPORTANT: consumption happens in an effect, not during render — a
  // discarded render (StrictMode/concurrent) would otherwise consume the
  // refs without committing the index reset, permanently desyncing.
  const prevTracksRef = useRef(tracks);
  const pendingStartRef = useRef(null);
  const trackIndexRef = useRef(trackIndex);
  trackIndexRef.current = trackIndex;
  useEffect(() => {
    if (prevTracksRef.current === tracks) return;
    prevTracksRef.current = tracks;
    nextIdxRef.current = null;
    const start = startAtRef?.current;
    if (startAtRef) startAtRef.current = null;
    pendingStartRef.current = start
      ? { seekTo: start.seekTo, playing: start.playing ?? (start.autoPlay ? true : undefined) }
      : null;
    const idx = start && start.index > 0 && start.index < tracks.length ? start.index : 0;
    if (trackIndexRef.current !== idx) setTrackIndex(idx);
    if (start?.playing === false) setIsPlaying(false);
    else if (start?.autoPlay) setIsPlaying(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks]);
  // Ref so the async load effect sees the latest value when it resolves,
  // not the one captured when it started
  const isPlayingRef = useRef(false);
  isPlayingRef.current = isPlaying;
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [loading, setLoading] = useState(false);
  const [playError, setPlayError] = useState(null);
  const [resolvedArt, setResolvedArt] = useState(null);
  const [volume, setVolumeState] = useState(() => {
    try {
      const saved = parseFloat(localStorage.getItem('cupid-volume'));
      return Number.isFinite(saved) ? saved : 1;
    } catch {
      return 1;
    }
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
      setLoading(false);
      setIsPlaying(false);
      setPlayError(null);
      setProgress(0);
      setCurrentTime(0);
      setDuration(0);
      audio.removeAttribute('src');
      audio.load();
      return;
    }

    let cancelled = false;
    setLoading(true);
    setResolvedArt(null);
    setPlayError(null);
    // Reset synchronously — "loaded" gates elsewhere (e.g. recordPlay's
    // duration > 0 check) must not see the previous track's duration
    // while the new track is still loading.
    setProgress(0);
    setCurrentTime(0);
    setDuration(0);

    if (promotedRef.current) {
      // Crossfade promote: the new element is already mid-song — only
      // resolve art/metadata, never touch src or playback.
      promotedRef.current = false;
      setLoading(false);
      setPlayError(null);
      // Reflect where the new deck actually is — it started at fade-start
      const el = engine.audio;
      setDuration(Number.isFinite(el.duration) ? el.duration : 0);
      setCurrentTime(el.currentTime || 0);
      setProgress(el.duration ? el.currentTime / el.duration : 0);
      // Metadata can still be in flight on the promoted deck — without
      // this duration stays 0 and gates like recordPlay's duration > 0
      // never open (rebound listeners only fire on NEW loadedmetadata)
      if (!Number.isFinite(el.duration)) {
        el.addEventListener('loadedmetadata', () => setDuration(el.duration), { once: true });
      }
      adapter.load(t)
        .then((res) => { if (!cancelled) setResolvedArt(res?.art ?? null); })
        .catch(() => { /* art is cosmetic */ });
      return () => { cancelled = true; };
    }
    engine.cancelCrossfade(); // manual index/queue change kills a pending fade
    armedNextIdxRef.current = null;

    (async () => {
      try {
        const res = await adapter.load(t);
        if (cancelled) return;
        setResolvedArt(res?.art ?? null);
        if (!res?.src) throw new Error('no playable source');
        // setting src triggers loading; an explicit audio.load() would reset it
        audio.src = res.src;
        const pending = pendingStartRef.current;
        pendingStartRef.current = null;
        // Room guests join mid-song — seek once metadata lands (setting
        // currentTime before then gets clamped to 0)
        if (pending?.seekTo > 0) {
          const onMeta = () => {
            try { audio.currentTime = pending.seekTo; } catch { /* not seekable yet */ }
            setCurrentTime(pending.seekTo);
            setProgress(audio.duration ? pending.seekTo / audio.duration : 0);
          };
          if (audio.readyState >= 1) onMeta();
          else audio.addEventListener('loadedmetadata', onMeta, { once: true });
        }
        const wantPlay = pending?.playing ?? isPlayingRef.current;
        if (wantPlay) {
          engine.play().catch(() => {});
        } else {
          audio.pause();
        }
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to load track:', err.message);
        setPlayError(err.message || 'load failed');
        // Unload fully — the previous track must not keep sounding
        // under the new title
        audio.removeAttribute('src');
        audio.load();
        setIsPlaying(false);
        setProgress(0);
        setCurrentTime(0);
        setDuration(0);
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
      pushPositionState();

      // Automix: when inside the fade window, load the next track onto the
      // second deck and overlap-fade into it. The old element's 'ended'
      // (below) performs the actual handoff.
      const secs = automixSecsRef.current;
      const live = liveTracksRef.current;
      if (
        secs > 0 && !engine.crossfading && !engine.nextArmed
        && !audio.paused // scrubbing into the window while paused must not start a fade
        && Number.isFinite(audio.duration) && audio.duration > 0
        && audio.currentTime > 0.5
        && audio.duration - audio.currentTime <= secs
        && live.length > 0
        // 'repeat' replays the current track — a fade to a different one
        // would violate that; single-track repeat fades into itself fine
        && !(playModeRef.current === 'repeat' && live.length > 1)
      ) {
        const nxt = nextIdxRef.current;
        const nextTrack = nxt != null ? live[nxt] : null;
        if (nextTrack) {
          // Stream resolves can take seconds (yt-dlp) — re-validate that
          // the arm still holds when the URL lands, or a stale fade fires
          // on the wrong track / while paused
          const armedIndex = trackIndexRef.current;
          adapterRef.current?.load?.(nextTrack)
            .then((res) => {
              if (!res?.src || engine.crossfading || engine.nextArmed) return;
              if (trackIndexRef.current !== armedIndex || audio !== engine.audio || audio.paused) return;
              const remain = audio.duration - audio.currentTime;
              if (remain <= 0 || remain > secs) return;
              const fade = Math.min(secs, remain);
              if (engine.prepareNext(res.src) && engine.startCrossfade(fade)) {
                armedNextIdxRef.current = nxt;
              }
            })
            .catch(() => { /* no automix this time — normal advance still works */ });
        }
      }
    };

    const onLoadedMetadata = () => {
      setDuration(audio.duration);
    };

    // Position for the OS media overlay (SMTC) — scrubbing works there
    const pushPositionState = () => {
      try {
        navigator.mediaSession?.setPositionState({
          duration: Number.isFinite(audio.duration) ? audio.duration : 0,
          playbackRate: 1,
          position: Math.min(audio.currentTime, audio.duration || 0),
        });
      } catch { /* position must not exceed duration — just skip */ }
    };

    const onEnded = () => {
      // Automix handoff: the outgoing element ended mid-fade — promote
      // the incoming deck and advance the index without a reload.
      if (engine.crossfading) {
        // Commit the index the deck actually loaded, not a recomputed next
        const nxt = armedNextIdxRef.current ?? nextIdxRef.current;
        armedNextIdxRef.current = null;
        engine.promoteNext();
        setAudioEl(engine.audio);
        if (nxt != null && nxt !== trackIndexRef.current) {
          promotedRef.current = true;
          setTrackIndex(nxt);
        } else {
          setIsPlaying(true); // same index — the new element just keeps going
        }
        return;
      }
      // Single-track queues wrap to themselves — restarting is the
      // only way to keep playing (setTrackIndex to the same index
      // wouldn't reload the element)
      if (playModeRef.current === 'repeat' || tracks.length === 1) {
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

    const onError = () => {
      // Media errors (bad src, decode failure, CORS reject) fire async after
      // src is set — without this the UI sat on "playing" at 0:00 forever.
      if (!audio.getAttribute('src')) return;
      // a mid-fade primary error must not leave the incoming deck playing
      // unsupervised (its 'ended' never reaches these listeners pre-promote)
      engine.cancelCrossfade();
      setPlayError(audio.error?.message || 'track failed to load');
      setIsPlaying(false);
      audio.pause();
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, [tracks.length, audioEl]);

  // ── Playback controls ────────────────────────────────────

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      engine.cancelCrossfade(); // pausing mid-fade snaps back to the primary
      engine.pause();
      setIsPlaying(false);
    } else if (tracks[trackIndex]) {
      engine.play().catch(() => {});
      setIsPlaying(true);
    }
  }, [isPlaying, engine, tracks, trackIndex]);

  const next = useCallback(() => {
    if (tracks.length === 0) return;
    engine.cancelCrossfade();
    if (tracks.length === 1) {
      // The queue wraps to itself — restart the track
      audio.currentTime = 0;
      engine.play().catch(() => {});
      setIsPlaying(true);
      return;
    }
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
  }, [tracks.length, audio, engine]);

  const prev = useCallback(() => {
    if (tracks.length === 0) return;
    engine.cancelCrossfade();
    if (audio.currentTime > 3 || tracks.length === 1) {
      audio.currentTime = 0;
      // Play explicitly — the track-index effect can't fire when the
      // index didn't change, so a paused track would sit silently
      // rewound while the UI reports "playing"
      engine.play().catch(() => {});
    } else {
      setTrackIndex((p) => (p - 1 + tracks.length) % tracks.length);
    }
    setIsPlaying(true);
  }, [tracks.length, audio, engine]);

  const seek = useCallback((fraction) => {
    if (audio.duration) {
      engine.cancelCrossfade(); // user scrubbed — stop any in-flight fade
      audio.currentTime = Math.min(fraction, 1) * audio.duration;
    }
  }, [audio, engine]);

  const setVolume = useCallback((v) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    audio.volume = clamped;
    try { localStorage.setItem('cupid-volume', clamped); } catch { /* ignore */ }
    if (clamped > 0) setMuted(false);
  }, [audio]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      audio.volume = m ? volume : 0;
      return !m;
    });
  }, [volume, audio]);

  // MediaSession action handlers live in App.jsx — they must route through
  // room-aware transport (a guest's media keys forward to the host).

  // Track metadata + playing state for the OS overlay
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      const art = track.art;
      ms.metadata = new MediaMetadata({
        title: track.title ?? '',
        artist: track.artist ?? '',
        album: track.album ?? '',
        // Loopback (127.0.0.1) art only resolves inside this app — the shell
        // fetches artwork itself, so only send genuinely remote/data URLs.
        artwork: art && (/^https:\/\//.test(art) || art.startsWith('data:')) ? [{ src: art }] : [],
      });
      ms.playbackState = isPlaying ? 'playing' : 'paused';
    } catch { /* mediaSession is cosmetic */ }
  }, [track.title, track.artist, track.album, track.art, isPlaying]);

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
    playError,
    engine,
  };
}
