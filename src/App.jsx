import { useCallback, useRef, useEffect, useMemo, useState } from 'react';
import './App.css';
import usePlayer from './usePlayer';
import { createLocalAdapter, createMixedAdapter, streamAdapter } from './audio/adapters.js';
import { EQ_PRESETS } from './audio/AudioEngine.js';
import Visualizer from './Visualizer.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import LibraryPanel from './LibraryPanel.jsx';
import SearchPanel from './SearchPanel.jsx';
import LyricsPanel from './LyricsPanel.jsx';
import StageView from './StageView.jsx';
import { parseLrc } from './lrc.js';
import usePlaylists from './usePlaylists.js';
import useStats from './useStats.js';
import useRoom from './room/useRoom.js';
import useTheme from './useTheme';
import { login as spotifyLogin, handleCallback, isLoggedIn as isSpotifyLoggedIn, logout as spotifyLogout } from './spotify/auth.js';
import { fetchPlaylistTracks as fetchSpotifyTracks, fetchMyPlaylists as fetchSpotifyPlaylists, searchTracks as searchSpotifyTracks } from './spotify/api.js';
import { searchCatalog as searchAppleCatalog } from './apple/api.js';
import { login as appleLogin, logout as appleLogout, isLoggedIn as isAppleLoggedIn, initMusicKit } from './apple/auth.js';
import { fetchMyPlaylists as fetchApplePlaylists, fetchPlaylistTracks as fetchAppleTracks } from './apple/api.js';
import {
  login as youtubeLogin,
  logout as youtubeLogout,
  isLoggedIn as isYouTubeLoggedIn,
  isConfigured as isYouTubeConfigured,
  cancelLogin as cancelYouTubeLogin,
} from './youtube/auth.js';
import {
  parsePlaylistUrl as parseYouTubePlaylistUrl,
  fetchPlaylistByUrl as fetchYouTubePlaylistByUrl,
  fetchMyPlaylists as fetchYouTubePlaylists,
  fetchPlaylistTracks as fetchYouTubeTracks,
} from './youtube/api.js';

import progressBarStars from '../assets/progress_bar_stars.png';
import star from '../assets/star.png';
import starSelected from '../assets/star_selected.png';

function useResize(corner) {
  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    let lastX = e.screenX;
    let lastY = e.screenY;

    const onMouseMove = (e) => {
      const dx = e.screenX - lastX;
      const dy = e.screenY - lastY;
      lastX = e.screenX;
      lastY = e.screenY;
      window.cupid?.resize({ dx, dy, corner });
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [corner]);

  return onMouseDown;
}

function formatTime(seconds) {
  if (!seconds || !isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function MarqueeText({ className, text }) {
  const outerRef = useRef(null);
  const textRef = useRef(null);
  const [shouldScroll, setShouldScroll] = useState(false);

  useEffect(() => {
    const outer = outerRef.current;
    const textEl = textRef.current;
    if (!outer || !textEl) return;
    setShouldScroll(textEl.offsetWidth > outer.clientWidth);
  }, [text]);

  return (
    <div className={`${className} marquee-container`} ref={outerRef}>
      {/* Hidden span to measure true text width */}
      <span ref={textRef} className="marquee-measure">{text}</span>
      <span className={shouldScroll ? 'marquee-scroll' : ''}>
        {text}
        {shouldScroll && <span className="marquee-gap">{text}</span>}
      </span>
    </div>
  );
}

export default function App() {
  // ── Source state ─────────────────────────────────────────
  const [source, setSource] = useState('local'); // 'local' | 'streaming'
  const [spotifyConnected, setSpotifyConnected] = useState(isSpotifyLoggedIn());
  const [appleConnected, setAppleConnected] = useState(isAppleLoggedIn());
  const [youtubeConnected, setYoutubeConnected] = useState(isYouTubeLoggedIn());
  const [youtubeLoggingIn, setYoutubeLoggingIn] = useState(false);
  const [youtubeUrlInput, setYoutubeUrlInput] = useState('');
  const [streamTracks, setStreamTracks] = useState([]);
  const [spotifyPlaylists, setSpotifyPlaylists] = useState([]);
  const [applePlaylists, setApplePlaylists] = useState([]);
  const [youtubePlaylists, setYoutubePlaylists] = useState([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [loadingPlaylist, setLoadingPlaylist] = useState(false);
  const [settingsError, setSettingsError] = useState(null);
  const [musicService, setMusicService] = useState(() => {
    try {
      const stored = localStorage.getItem('cupid-player-music-service');
      if (stored === 'spotify' || stored === 'apple' || stored === 'youtube' || stored === 'local') return stored;
    } catch {
      // ignore
    }
    return 'local';
  }); // 'spotify' | 'apple' | 'youtube' | 'local'
  const [playMode, setPlayMode] = useState('normal'); // 'normal' | 'shuffle' | 'repeat'
  const [volumeHovered, setVolumeHovered] = useState(false);
  const [volumeDragging, setVolumeDragging] = useState(false);
  const volumeBarRef = useRef(null);
  const [showDebug] = useState(false);
  const [localTracks, setLocalTracks] = useState([]);

  const loadLocalPlaylist = useCallback(async () => {
    if (!window.cupid?.getLocalPlaylist) return;
    try {
      const tracks = await window.cupid.getLocalPlaylist();
      setLocalTracks(Array.isArray(tracks) ? tracks : []);
    } catch (err) {
      console.error('Failed to load local playlist:', err);
    }
  }, []);

  useEffect(() => { loadLocalPlaylist(); }, [loadLocalPlaylist]);
  // Reload once the first-launch seed finishes (fires only when the
  // seed actually ran — no-op reloads are cheap anyway)
  useEffect(() => window.cupid?.onAudioSeeded?.(loadLocalPlaylist), [loadLocalPlaylist]);

  const localAdapter = useMemo(
    () => createLocalAdapter(window.cupid?.getLocalAudioPath),
    [],
  );
  const mixedAdapter = useMemo(() => createMixedAdapter(localAdapter), [localAdapter]);
  // A user playlist / search result overrides the source track list entirely
  const [queue, setQueue] = useState(null);
  const startAtRef = useRef(null); // { index, autoPlay, seekTo, playing } consumed by usePlayer
  const isStreaming = source === 'streaming';
  const activeTracks = queue ?? (isStreaming ? streamTracks : localTracks);
  const activeAdapter = queue ? mixedAdapter : (isStreaming ? streamAdapter : localAdapter);
  // Automix — overlap-fade into the next track; 0 = off. Persisted so a
  // DJ session survives restarts like the theme does.
  const [automixSecs, setAutomixSecsState] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem('cupid-automix-secs'), 10);
      return Number.isFinite(v) ? Math.max(0, Math.min(12, v)) : 0;
    } catch {
      return 0;
    }
  });
  const setAutomixSecs = useCallback((v) => {
    const c = Math.max(0, Math.min(12, Math.round(v)));
    setAutomixSecsState(c);
    try { localStorage.setItem('cupid-automix-secs', String(c)); } catch { /* ignore */ }
  }, []);

  const player = usePlayer(activeTracks, playMode, activeAdapter, startAtRef, automixSecs);
  const { theme, setTheme, toggleTheme, assets, customHue, setCustomHue } = useTheme();

  // Play a track list (playlist/search result), starting at `index`.
  // opts: { seekTo (s), playing (bool) } — room guests join mid-song
  const playTrackList = useCallback((tracks, index = 0, opts = {}) => {
    startAtRef.current = { index, autoPlay: true, ...opts };
    // React bails when re-queuing the identical array, which would leave
    // startAtRef unconsumed — copy so usePlayer still sees a change
    setQueue((q) => (q === tracks ? tracks.slice() : tracks));
  }, []);
  const playTrack = useCallback((t) => playTrackList([t], 0), [playTrackList]);

  const {
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
    loading: trackLoading,
    playError,
  } = player;

  // Ref so timers (sleep fade) always see the latest player controls
  const playerRef = useRef(player);
  playerRef.current = player;

  // ── Playlists, stats, unified search ─────────────────────
  const { playlists, create: createPlaylist, remove: deletePlaylist, addTrack: addToPlaylist, removeTrack } = usePlaylists();
  const { recents, recordPlay } = useStats();

  // Only count a play once the media actually loaded — a track that errors
  // out (bad src, failed stream) shouldn't land in recents or play counts.
  useEffect(() => {
    if (isPlaying && duration > 0 && track?.title && track.title !== 'No track') recordPlay(track);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, duration > 0, track?.source, track?.title, track?.artist]);

  const searchAll = useCallback(async (q) => {
    const ql = q.toLowerCase();
    const match = (t) => `${t.title ?? ''} ${t.artist ?? ''}`.toLowerCase().includes(ql);
    const local = [
      ...localTracks.map((t) => ({ ...t, source: 'local' })),
      ...Object.values(playlists).flat(),
    ].filter(match);

    const [sp, ap, yt] = await Promise.allSettled([
      spotifyConnected ? searchSpotifyTracks(q) : [],
      appleConnected ? searchAppleCatalog(q) : [],
      window.cupid?.youtubeSearch?.(q) ?? [],
    ]);
    return {
      local,
      spotify: (sp.value || []).map((t) => ({ ...t, source: 'spotify' })),
      apple: (ap.value || []).map((t) => ({ ...t, source: 'apple' })),
      youtube: (yt.value || []).map((t) => ({ ...t, source: 'youtube' })),
    };
  }, [localTracks, playlists, spotifyConnected, appleConnected]);

  // ── Lyrics — fetched per track: .lrc sidecar → embedded → lrclib ──
  const [lyrics, setLyrics] = useState(null); // { lines: [{time,text}], plain }
  useEffect(() => {
    setLyrics(null);
    if (!track?.title || track.title === 'No track' || !window.cupid?.getLyrics) return;
    let cancelled = false;
    window.cupid.getLyrics(track).then((res) => {
      if (cancelled || !res) return;
      const lines = res.synced ? parseLrc(res.synced) : (res.syncText || []);
      setLyrics({ lines, plain: res.plain });
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.source, track?.title, track?.artist, track?.file]);

  // ── Listen Together (LAN room) ────────────────────────────
  const [roomJoinInput, setRoomJoinInput] = useState('');

  // ?mode=full forces full layout — handy for browser preview/QA.
  // 'stage' (the pretty fullscreen) joins via window-mode-changed events.
  // Declared here — transportRef below captures it every render.
  const [winMode, setWinMode] = useState(() =>
    new URLSearchParams(window.location.search).get('mode') === 'full' ? 'full' : 'compact'
  ); // 'compact' | 'full' | 'stage'
  // Read the audio element directly for position — the React currentTime
  // state only updates on timeupdate (~4Hz), which would systematically
  // under-report the host position to room guests by up to ~250ms
  const getPlayerState = useCallback(() => ({
    track: playerRef.current.track,
    currentTime: playerRef.current.engine?.audio?.currentTime ?? playerRef.current.currentTime,
    isPlaying: playerRef.current.isPlaying,
    duration: playerRef.current.duration,
  }), []);
  const room = useRoom({ getPlayerState, playerRef, playTrackList });

  // In a room as guest, transport controls forward to the host instead
  // Guests mirror the host's state, so their local isPlaying ≈ host's —
  // send idempotent play/pause instead of a blind toggle that can invert
  const doTogglePlay = () => room.role === 'guest' ? room.command(isPlaying ? 'pause' : 'play') : togglePlay();
  const doNext = () => room.role === 'guest' ? room.command('next') : next();
  const doPrev = () => room.role === 'guest' ? room.command('prev') : prev();
  // Tag seeks with the track so the host can drop a stale one
  const doSeek = (pct) => room.role === 'guest'
    ? room.command('seek', { fraction: pct, track })
    : seek(pct);
  // Guests can't change their own queue — a clicked song goes to the host
  const playTrackListUi = useCallback((tracks, index = 0) => {
    if (room.role === 'guest') { room.command('playTrack', { track: tracks[index] }); return; }
    playTrackList(tracks, index);
  }, [room.role, room.command, playTrackList]);
  const playTrackUi = useCallback((t) => playTrackListUi([t], 0), [playTrackListUi]);

  // Remove a track from the active queue (materializes library/streaming
  // lists into a session queue). Keeps the current song playing unless it
  // was the one removed — then the next track slides in.
  const removeFromQueue = useCallback((i) => {
    if (room.role === 'guest') return;
    if (i < 0 || i >= activeTracks.length) return;
    const remaining = activeTracks.filter((_, idx) => idx !== i);
    startAtRef.current = i === trackIndex
      ? { index: Math.max(0, Math.min(i, remaining.length - 1)), autoPlay: isPlaying }
      : { index: i < trackIndex ? trackIndex - 1 : trackIndex, seekTo: currentTime, playing: isPlaying };
    setQueue(remaining);
  }, [room.role, activeTracks, trackIndex, isPlaying, currentTime]);

  // ── OS integration: taskbar/tray state + transport commands back ──
  // Pushes {isPlaying, title, progress} to main → taskbar thumbnail buttons,
  // taskbar progress bar, tray tooltip.
  useEffect(() => {
    window.cupid?.setPlaybackState?.({ isPlaying, title: track?.title, artist: track?.artist, progress });
  }, [isPlaying, track?.title, track?.artist, progress]);

  // Taskbar buttons / tray menu / OS media keys arrive as 'media-command';
  // OS media keys (SMTC/MediaSession) go through the same routing. The ref
  // keeps both subscriptions stable while room-mode transport (guest →
  // forward to host) stays live.
  const transportRef = useRef({ doTogglePlay, doNext, doPrev, doSeek, duration, isPlaying, currentTime, volume, setVolume, toggleMute, toggleTheme });
  transportRef.current = {
    doTogglePlay, doNext, doPrev, doSeek, duration, isPlaying, currentTime, volume, setVolume, toggleMute, toggleTheme,
    // Seek math reads the live audio element — the ~4Hz currentTime state
    // under-reports position by up to ~250ms on fast key repeats.
    getNow: () => playerRef.current.engine?.audio?.currentTime ?? playerRef.current.currentTime ?? 0,
    winMode,
    toggleStage: () => window.cupid?.setStageMode?.(winMode !== 'stage'),
  };
  useEffect(() => {
    return window.cupid?.onMediaCommand?.((op) => {
      const t = transportRef.current;
      if (op === 'toggle') t.doTogglePlay();
      else if (op === 'next') t.doNext();
      else if (op === 'prev') t.doPrev();
    });
  }, []);

  // OS media keys / lock-screen transport — same room-aware routing as the
  // taskbar buttons (a guest's media keys forward to the host).
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const t = () => transportRef.current;
    // 'play'/'pause' are states, not toggles — ignore ones already satisfied
    try { ms.setActionHandler('play', () => { if (!t().isPlaying) t().doTogglePlay(); }); } catch {}
    try { ms.setActionHandler('pause', () => { if (t().isPlaying) t().doTogglePlay(); }); } catch {}
    try { ms.setActionHandler('nexttrack', () => t().doNext()); } catch {}
    try { ms.setActionHandler('previoustrack', () => t().doPrev()); } catch {}
    try {
      ms.setActionHandler('seekto', (d) => {
        if (typeof d.seekTime === 'number' && t().duration > 0) t().doSeek(d.seekTime / t().duration);
      });
    } catch {}
    return () => {
      for (const a of ['play', 'pause', 'nexttrack', 'previoustrack', 'seekto']) {
        try { ms.setActionHandler(a, null); } catch {}
      }
    };
  }, []);

  // Keyboard shortcuts — the pixel buttons have no focus ring, so keys are
  // the accessible path. Skips when typing in a field. Same room-aware
  // transport routing as the OS media keys.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
      const t = transportRef.current;
      const SEEK_STEP = 5;
      const VOL_STEP = 0.05;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape' && t.winMode === 'stage') {
        e.preventDefault();
        t.toggleStage();
      } else if ((mod) && e.key === 'ArrowRight') {
        e.preventDefault();
        t.doNext(); // Ctrl/Cmd+→ = next track (checked before the plain seek)
      } else if ((mod) && e.key === 'ArrowLeft') {
        e.preventDefault();
        t.doPrev();
      } else if (e.key === ' ' && !mod && !e.altKey) {
        e.preventDefault();
        t.doTogglePlay();
      } else if (e.key === 'ArrowRight' && !mod && !e.altKey && t.duration > 0) {
        e.preventDefault();
        t.doSeek(Math.min(1, (t.getNow() + SEEK_STEP) / t.duration));
      } else if (e.key === 'ArrowLeft' && !mod && !e.altKey && t.duration > 0) {
        e.preventDefault();
        t.doSeek(Math.max(0, (t.getNow() - SEEK_STEP) / t.duration));
      } else if (e.key === 'ArrowUp' && !mod) {
        e.preventDefault();
        t.setVolume(t.volume + VOL_STEP);
      } else if (e.key === 'ArrowDown' && !mod) {
        e.preventDefault();
        t.setVolume(t.volume - VOL_STEP);
      } else if (e.key.toLowerCase() === 'n' && !mod && !e.altKey) {
        t.doNext();
      } else if (e.key.toLowerCase() === 'p' && !mod && !e.altKey) {
        t.doPrev();
      } else if (e.key.toLowerCase() === 'm' && !mod && !e.altKey) {
        t.toggleMute();
      } else if (e.key.toLowerCase() === 't' && !mod && !e.altKey) {
        t.toggleTheme();
      } else if (e.key.toLowerCase() === 'f' && !mod && !e.altKey) {
        t.toggleStage();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Track-change toast when the window isn't focused (Windows action center)
  const prevTrackKeyRef = useRef(null);
  useEffect(() => {
    if (!track?.title || track.title === 'No track') return;
    const key = `${track.title}::${track.artist}`;
    if (prevTrackKeyRef.current === key) return;
    prevTrackKeyRef.current = key;
    if (document.hasFocus() || typeof Notification === 'undefined') return;
    try {
      const icon = track.art && (/^https?:\/\//.test(track.art) || track.art.startsWith('data:')) ? track.art : undefined;
      new Notification(track.title, { body: track.artist || 'cupid player', icon, silent: true });
    } catch { /* notifications are cosmetic */ }
  }, [track?.title, track?.artist, track?.art]);

  // ── EQ ───────────────────────────────────────────────────
  const [eqGains, setEqGains] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('cupid-eq-gains'));
      if (Array.isArray(saved) && saved.length === 10) return saved;
    } catch { /* ignore */ }
    return [...EQ_PRESETS.flat];
  });
  useEffect(() => {
    player.engine.setEq(eqGains);
    try { localStorage.setItem('cupid-eq-gains', JSON.stringify(eqGains)); } catch { /* ignore */ }
  }, [eqGains, player.engine]);

  // ── Sleep timer — 30s volume fade then pause ─────────────
  const [sleepMins, setSleepMins] = useState(0); // 0 = off
  const fadeRef = useRef(null);
  useEffect(() => {
    if (!sleepMins) return;
    const timer = setTimeout(() => {
      const p = playerRef.current;
      if (!p.isPlaying) { setSleepMins(0); return; }
      const savedVol = p.volume;
      let steps = 30;
      fadeRef.current = {
        savedVol,
        interval: setInterval(() => {
          steps--;
          playerRef.current.setVolume(Math.max(0, savedVol * (steps / 30)));
          if (steps <= 0) {
            clearInterval(fadeRef.current.interval);
            fadeRef.current = null;
            const cur = playerRef.current;
            if (cur.isPlaying) cur.togglePlay();
            cur.setVolume(savedVol); // restore level for next play
            setSleepMins(0);
          }
        }, 1000),
      };
    }, sleepMins * 60 * 1000);
    return () => {
      clearTimeout(timer);
      if (fadeRef.current) {
        // Fade interrupted — restore the pre-fade volume
        clearInterval(fadeRef.current.interval);
        playerRef.current.setVolume(fadeRef.current.savedVol);
        fadeRef.current = null;
      }
    };
  }, [sleepMins]);

  const cyclePlayMode = useCallback(() => {
    setPlayMode((m) => m === 'normal' ? 'shuffle' : m === 'shuffle' ? 'repeat' : 'normal');
  }, []);

  // ── Fetch Spotify playlists ────────────────────────────
  const loadSpotifyPlaylists = useCallback((silent = false) => {
    setLoadingPlaylists(true);
    if (!silent) setSettingsError(null);
    fetchSpotifyPlaylists()
      .then((p) => { setSpotifyPlaylists(p); setSettingsError(null); })
      .catch((err) => { if (!silent) setSettingsError(err.message); })
      .finally(() => setLoadingPlaylists(false));
  }, []);

  // ── Fetch Apple Music playlists ────────────────────────
  const loadApplePlaylists = useCallback((silent = false) => {
    setLoadingPlaylists(true);
    if (!silent) setSettingsError(null);
    fetchApplePlaylists()
      .then((p) => { setApplePlaylists(p); setSettingsError(null); })
      .catch((err) => { if (!silent) setSettingsError(err.message); })
      .finally(() => setLoadingPlaylists(false));
  }, []);

  // ── Fetch YouTube playlists (Data API, requires sign-in) ─
  const loadYoutubePlaylists = useCallback((silent = false) => {
    setLoadingPlaylists(true);
    if (!silent) setSettingsError(null);
    fetchYouTubePlaylists()
      .then((p) => { setYoutubePlaylists(p); setSettingsError(null); })
      .catch((err) => { if (!silent) setSettingsError(err.message); })
      .finally(() => setLoadingPlaylists(false));
  }, []);

  // ── Load a playlist from a YouTube URL (no sign-in) ─────
  const loadYoutubePlaylistFromUrl = useCallback(async (rawInput) => {
    setSettingsError(null);
    const parsed = parseYouTubePlaylistUrl(rawInput);
    if (!parsed) {
      setSettingsError('Not a recognised YouTube playlist URL');
      return;
    }
    setLoadingPlaylist(true);
    try {
      const tracks = await fetchYouTubePlaylistByUrl(rawInput);
      if (tracks.length === 0) {
        setSettingsError('Playlist is empty or private');
        return;
      }
      setQueue(null);
      setStreamTracks(tracks);
      setSource('streaming');
      setYoutubeUrlInput('');
    } catch (err) {
      setSettingsError(err.message);
    } finally {
      setLoadingPlaylist(false);
    }
  }, []);

  // ── Handle Spotify OAuth callback on mount ─────────────
  useEffect(() => {
    async function checkCallback() {
      const params = new URLSearchParams(window.location.search);
      if (params.has('code')) {
        try {
          await handleCallback();
          setSpotifyConnected(true);
          // Small delay to let token settle before fetching
          setTimeout(() => loadSpotifyPlaylists(true), 500);
        } catch (err) {
          setSettingsError(err.message);
        }
      } else {
        if (isSpotifyLoggedIn()) loadSpotifyPlaylists(true);
        if (isAppleLoggedIn()) loadApplePlaylists(true);
        if (isYouTubeLoggedIn()) loadYoutubePlaylists(true);
      }
    }
    checkCallback();
  }, []);

  // ── Load a playlist by ID (works for all services) ────
  const loadPlaylist = useCallback(async (id, service) => {
    setLoadingPlaylist(true);
    setSettingsError(null);
    try {
      const fetcher = service === 'apple'
        ? fetchAppleTracks
        : service === 'youtube'
          ? fetchYouTubeTracks
          : fetchSpotifyTracks;
      const tracks = await fetcher(id);
      if (tracks.length === 0) {
        setSettingsError('Playlist is empty');
        return;
      }
      setQueue(null);
      setStreamTracks(tracks);
      setSource('streaming');
    } catch (err) {
      setSettingsError(err.message);
    } finally {
      setLoadingPlaylist(false);
    }
  }, []);

  // ── Discord Rich Presence (opt-in; needs CUPID_DISCORD_CLIENT_ID) ──
  const [discordOn, setDiscordOn] = useState(() => {
    try { return localStorage.getItem('cupid-discord-rpc') === '1'; } catch { return false; }
  });
  const [discordAvail, setDiscordAvail] = useState(false);
  useEffect(() => {
    window.cupid?.discordAvailable?.().then(setDiscordAvail).catch(() => {});
  }, []);
  useEffect(() => {
    window.cupid?.setDiscordEnabled?.(discordOn);
    try { localStorage.setItem('cupid-discord-rpc', discordOn ? '1' : '0'); } catch { /* ignore */ }
  }, [discordOn]);

  // ── Drag-drop audio import ─────────────────────────────
  const [dropActive, setDropActive] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    // Only flatter the user when the payload actually contains files —
    // drags of links/text shouldn't light the drop overlay
    if (e.dataTransfer?.types?.includes('Files')) setDropActive(true);
  }, []);
  const onDragLeave = useCallback((e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDropActive(false);
  }, []);
  const onDrop = useCallback(async (e) => {
    e.preventDefault();
    setDropActive(false);
    // Guests can't touch their own library — the import + autoplay would
    // fork them off the host's queue
    if (room.role === 'guest') { showToast('the host controls the tunes here'); return; }
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files.map((f) => {
      try { return window.cupid?.getPathForFile?.(f) || null; } catch { return null; }
    }).filter(Boolean);
    if (!paths.length || !window.cupid?.importAudioFiles) return;
    try {
      const res = await window.cupid.importAudioFiles(paths);
      const n = res?.added?.length ?? 0;
      const skipped = (res?.skipped?.length ?? 0) + (files.length - paths.length);
      if (!n) {
        showToast(skipped ? 'no audio files in that drop :(' : 'nothing to add');
        return;
      }
      await loadLocalPlaylist();
      setQueue(null);
      setSource('local');
      setMusicService('local');
      try { localStorage.setItem('cupid-player-music-service', 'local'); } catch { /* ignore */ }
      // Tracks play straight away — the fun of dropping something in
      playTrackList(res.added, 0);
      showToast(`added ${n} song${n === 1 ? '' : 's'} ♥${skipped ? ` (${skipped} skipped)` : ''}`);
    } catch (err) {
      showToast(`import failed: ${err.message}`);
    }
  }, [room.role, loadLocalPlaylist, playTrackList, showToast]);

  useEffect(() => window.cupid?.onModeChange?.(setWinMode), []);

  const [recordFrame, setRecordFrame] = useState(0);
  const [needleFrame, setNeedleFrame] = useState(0);
  const [isPink, setIsPink] = useState(theme !== 'blue');
  const [swapping, setSwapping] = useState(false);
  const [needleLifted, setNeedleLifted] = useState(false);
  const [starHovered, setStarHovered] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hoverProgress, setHoverProgress] = useState(null);
  const seekRef = useRef(null);

  // mint/lavender use the pink asset family — keep the record color on the
  // theme's family when the theme changes mid-session
  useEffect(() => setIsPink(theme !== 'blue'), [theme]);

  const lastSeekPctRef = useRef(null);
  useEffect(() => {
    if (!dragging) return;
    const onMouseMove = (e) => {
      const rect = seekRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setHoverProgress(pct);
      lastSeekPctRef.current = pct;
      // Room guests don't scrub locally — send the final position on release
      if (room.role !== 'guest') seek(pct);
    };
    const onMouseUp = () => {
      if (room.role === 'guest' && lastSeekPctRef.current != null) {
        room.command('seek', { fraction: lastSeekPctRef.current, track });
      }
      lastSeekPctRef.current = null;
      setDragging(false);
      setStarHovered(false);
      setHoverProgress(null);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [dragging, seek, room.role, room.command, track]);

  useEffect(() => {
    if (!volumeDragging) return;
    const onMouseMove = (e) => {
      if (!volumeBarRef.current) return;
      const rect = volumeBarRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
      setVolume(pct);
    };
    const onMouseUp = () => {
      setVolumeDragging(false);
      setVolumeHovered(false);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [volumeDragging, setVolume]);
  const [needleChangeFrame, setNeedleChangeFrame] = useState(0);
  // null sentinel = haven't seen any track yet; 'No track' = placeholder while
  // tracks load async. Both should silently set the ref without animating.
  const prevTrackRef = useRef(null);

  const currentFrames = isPink ? assets.recordFramesA : assets.recordFramesB;
  const incomingFrames = isPink ? assets.recordFramesB : assets.recordFramesA;

  // Spin animation while playing
  useEffect(() => {
    if (!isPlaying || swapping) return;
    const interval = setInterval(() => {
      setRecordFrame((f) => (f + 1) % currentFrames.length);
      setNeedleFrame((f) => (f + 1) % assets.needlePlayFrames.length);
    }, 400);
    return () => clearInterval(interval);
  }, [isPlaying, swapping, currentFrames.length]);

  // Detect song change and trigger swap
  // Sequence: needle lifts (0→1→2) → records swap → needle lowers (2→1→0)
  useEffect(() => {
    if (prevTrackRef.current === track.title) return;
    const wasInitialOrPlaceholder = prevTrackRef.current === null || prevTrackRef.current === 'No track';
    prevTrackRef.current = track.title;
    if (track.title === 'No track') return;
    if (wasInitialOrPlaceholder) return;
    if (needleLifted) return;

    setNeedleLifted(true);
    setNeedleChangeFrame(0);

    // Show needle lifted (frame 1 = index 1)
    setTimeout(() => setNeedleChangeFrame(1), 200);

    // Start record swap
    setTimeout(() => setSwapping(true), 400);

    // Finish swap, switch color
    setTimeout(() => {
      setIsPink((p) => !p);
      setRecordFrame(0);
      setSwapping(false);
    }, 1000);

    // Needle lower after swap is done, reset to frame 1
    setTimeout(() => {
      setNeedleChangeFrame(0);
      setNeedleLifted(false);
      setNeedleFrame(0);
    }, 1100);

  }, [track.title, needleLifted]);

  const resizeTL = useResize('top-left');
  const resizeTR = useResize('top-right');
  const resizeBL = useResize('bottom-left');
  const resizeBR = useResize('bottom-right');

  // Make clickable divs keyboard-activatable — Enter/Space fire onClick
  const press = (onClick) => ({
    role: 'button',
    tabIndex: 0,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); }
    },
  });

  // 'custom' theme — pink pixel art rotated to a user hue; text colors
  // derived from the same hue so panels stay readable
  const customVars = theme === 'custom' ? {
    '--custom-hue': `${customHue}deg`,
    '--color-title': `hsl(${customHue}, 40%, 28%)`,
    '--color-primary': `hsl(${customHue}, 45%, 30%)`,
    '--color-secondary': `hsl(${customHue}, 38%, 52%)`,
    '--color-panel-text': `hsl(${customHue}, 65%, 88%)`,
  } : undefined;

  return (
    <div
      className={`app-shell theme-${theme} ${winMode === 'full' ? 'mode-full' : ''} ${winMode === 'stage' ? 'mode-stage' : ''}`}
      style={customVars}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
    {dropActive && (
      <div className="drop-overlay">
        <div className="drop-overlay-inner">drop to add ♥</div>
      </div>
    )}
    {toast && <div className="cupid-toast">{toast}</div>}
    {winMode === 'stage' && (
      <StageView
        track={track}
        isPlaying={isPlaying}
        progress={progress}
        duration={duration}
        currentTime={currentTime}
        onTogglePlay={doTogglePlay}
        onNext={doNext}
        onPrev={doPrev}
        onSeek={doSeek}
        volume={volume}
        onVolume={setVolume}
        muted={muted}
        onMute={toggleMute}
        playMode={playMode}
        onCyclePlayMode={cyclePlayMode}
        engine={player.engine}
        theme={theme}
        lyrics={lyrics}
        onExitStage={() => window.cupid?.setStageMode?.(false)}
      />
    )}
    {winMode !== 'stage' && (
    <>
    {winMode === 'full' && (
      <LibraryPanel
        playlists={playlists}
        recents={recents}
        currentTrack={track}
        onPlayTracks={playTrackListUi}
        onAddCurrentTo={addToPlaylist}
        onCreatePlaylist={createPlaylist}
        onDeletePlaylist={deletePlaylist}
        onRemoveTrack={removeTrack}
      />
    )}
    <div className={`player ${winMode === 'full' ? 'mode-full' : ''}`}>
      {/* Base frame */}
      <img src={assets.frame} className="layer" alt="" draggable={false} />

      {/* Window title */}
      <div className="window-title">cupid player</div>

      {/* Record player centered in frame */}
      <img src={assets.recordPlayer} className="record-player" alt="" draggable={false} />
      <img
        src={currentFrames[recordFrame]}
        className={`record-player ${swapping ? 'record-slide-out' : ''}`}
        alt=""
        draggable={false}
      />
      {swapping && (
        <img
          src={incomingFrames[0]}
          className="record-player record-slide-in"
          alt=""
          draggable={false}
        />
      )}
      <img
        src={needleLifted ? assets.needleChangeFrames[needleChangeFrame] : assets.needlePlayFrames[needleFrame]}
        className="record-player"
        alt=""
        draggable={false}
      />

      {/* Frame overlay (no background) to clip sliding records */}
      <img src={assets.frameNoBg} className="layer frame-overlay" alt="" draggable={false} />

      {/* Decorative */}
      <img src={assets.plant} className="layer layer-ui" alt="" draggable={false} />

      {/* Progress bar layers */}
      <img src={assets.progressBar} className="layer layer-ui" alt="" draggable={false} />
      <img
        src={progressBarStars}
        className="layer layer-ui"
        alt=""
        draggable={false}
        style={{
          clipPath: `inset(0 ${(1 - (131 + (hoverProgress ?? progress) * 226 + 10) / 512) * 100}% 0 0)`,
        }}
      />
      <img
        src={starHovered ? starSelected : star}
        className={`layer layer-ui star-indicator ${starHovered ? 'star-hovered' : ''}`}
        alt=""
        draggable={false}
        style={{
          transform: `translateX(calc(-3 / 306 * var(--w) + ${(hoverProgress ?? progress) * (226 / 512) * 1.719} * var(--w)))`,
        }}
      />

      {/* Playback control layers (visual only) */}
      <img src={assets.backwardsButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={isPlaying ? assets.pauseButton : assets.playButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={assets.forwardsButton} className="layer layer-ui" alt="" draggable={false} />

      {/* Volume/mute button layer */}
      <img
        src={muted ? assets.muteButton : assets.volumeButton}
        className="layer layer-ui"
        alt=""
        draggable={false}
        style={{ opacity: 0.8 }}
      />

      {/* Shuffle/repeat button layer */}
      <img
        src={playMode === 'repeat' ? assets.repeatButton : assets.shuffleButton}
        className="layer layer-ui"
        alt=""
        draggable={false}
        style={{ opacity: playMode === 'normal' ? 0.4 : 0.8 }}
      />

      {/* Window control layers (visual only) */}
      <img src={assets.minimizerButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={assets.windowButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={assets.exitButton} className="layer layer-ui" alt="" draggable={false} />

      {/* Settings button layer */}
      <img src={assets.settings} className="layer layer-ui settings-layer" alt="" draggable={false} />

      {/* SVG clip-path for pixel-art album mask */}
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <clipPath id="album-mask" clipPathUnits="objectBoundingBox">
            {/* 35x41 centered vertically */}
            <rect x="0.07317" y="0" width="0.85366" height="1" />
            {/* 37x39 */}
            <rect x="0.04878" y="0.02439" width="0.90244" height="0.95122" />
            {/* 39x37 */}
            <rect x="0.02439" y="0.04878" width="0.95122" height="0.90244" />
            {/* 41x35 */}
            <rect x="0" y="0.07317" width="1" height="0.85366" />
          </clipPath>
        </defs>
      </svg>

      {/* Album art clipped to pixel mask */}
      {track.art && (
        <div className="album-mask">
          <img src={track.art} className="album-art" alt="" draggable={false} />
        </div>
      )}

      {/* Album frame overlay */}
      <img src={assets.albumFrame} className="layer album-frame-layer" alt="" draggable={false} />

      {/* Now playing section */}
      <div className="now-playing">
        <div className="track-info">
          <div className="now-playing-label">
            {playError ? 'couldn\'t play this one :(' : trackLoading ? 'loading...' : 'now playing...'}
          </div>
          <MarqueeText className="track-title" text={track.title} />
          <div className="track-artist">by {track.artist}</div>
        </div>
      </div>

      {/* Visualizer strip — between transport buttons and progress bar */}
      <Visualizer engine={player.engine} playing={isPlaying} theme={theme} />

      {/* Time display */}
      <div className="time-display">
        <span className="time-current">{formatTime(currentTime)}</span>
        <span className="time-remaining">{formatTime(duration - currentTime)}</span>
      </div>

      {/* Drag region for moving the window */}
      <div className="drag-region" />

      {/* Custom resize handles at frame corners */}
      <div className="resize-handle top-left" onMouseDown={resizeTL} />
      <div className="resize-handle top-right" onMouseDown={resizeTR} />
      <div className="resize-handle bottom-left" onMouseDown={resizeBL} />
      <div className="resize-handle bottom-right" onMouseDown={resizeBR} />

      {/* Progress bar seek target */}
      <div
        className="progress-seek"
        ref={seekRef}
        onMouseEnter={() => setStarHovered(true)}
        onMouseLeave={() => { if (!dragging) { setStarHovered(false); } }}
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          setHoverProgress(pct);
          doSeek(pct);
        }}
      />

      {/* Playback control click targets */}
      <div className="btn btn-prev" onClick={doPrev} aria-label="previous" {...press(doPrev)} />
      <div className="btn btn-play" onClick={doTogglePlay} aria-label={isPlaying ? 'pause' : 'play'} {...press(doTogglePlay)} />
      <div className="btn btn-next" onClick={doNext} aria-label="next" {...press(doNext)} />

      {/* Volume bar layers — shown on hover or drag */}
      {(volumeHovered || volumeDragging) && (
        <>
          <img src={assets.volumeBarLow} className="layer layer-ui volume-bar-layer" alt="" draggable={false} />
          <img
            src={assets.volumeBarHigh}
            className="layer layer-ui volume-bar-layer"
            alt=""
            draggable={false}
            style={{
              clipPath: `inset(${((1 - (muted ? 0 : volume)) * (420 - 338) / 512 + 338 / 512) * 100}% 0 0 0)`,
            }}
          />
        </>
      )}

      {/* Volume icon — hover to reveal bar */}
      <div
        className={`volume-hover-zone ${(volumeHovered || volumeDragging) ? 'expanded' : ''}`}
        onMouseLeave={() => { if (!volumeDragging) setVolumeHovered(false); }}
      >
        <div
          className="btn-volume-icon"
          onClick={toggleMute}
          aria-label={muted ? 'unmute' : 'mute'}
          {...press(toggleMute)}
          onMouseEnter={() => setVolumeHovered(true)}
        />
        {(volumeHovered || volumeDragging) && (
          <div
            className="volume-bar-area"
            ref={volumeBarRef}
            onMouseDown={(e) => {
              e.preventDefault();
              setVolumeDragging(true);
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
              setVolume(pct);
            }}
          />
        )}
      </div>

      {/* Shuffle/repeat click target */}
      <div className="btn btn-playmode" onClick={cyclePlayMode} title={playMode} aria-label={`play mode: ${playMode}`} {...press(cyclePlayMode)} />

      {/* Window control click targets */}
      <div className="btn btn-minimize" onClick={() => window.cupid?.minimize()} aria-label="minimize" {...press(() => window.cupid?.minimize())} />
      <div className="btn btn-window" onClick={() => window.cupid?.toggleMode?.()} aria-label="toggle compact/full mode" {...press(() => window.cupid?.toggleMode?.())} />
      <div className="btn btn-exit" onClick={() => window.cupid?.close()} aria-label="close" {...press(() => window.cupid?.close())} />

      {/* Settings button */}
      <div className="btn btn-settings" onClick={() => setShowSettings((v) => !v)} aria-label="settings" aria-expanded={showSettings} {...press(() => setShowSettings((v) => !v))} />

      {/* Debug overlays — toggle with showDebug state */}
      {showDebug && (
        <>
          <div className="debug-overlay btn btn-prev" />
          <div className="debug-overlay btn btn-play" />
          <div className="debug-overlay btn btn-next" />
          <div className="debug-overlay volume-hover-zone" />
          <div className="debug-overlay volume-bar-area-debug" />
          <div className="debug-overlay btn btn-playmode" />
        </>
      )}

      {/* Settings panel */}
      {showSettings && (
        <SettingsPanel
          theme={theme}
          onTheme={setTheme}
          customHue={customHue}
          onCustomHue={setCustomHue}
          queue={{
            tracks: activeTracks,
            index: trackIndex,
            onJump: (i) => playTrackListUi(activeTracks, i),
            onRemove: removeFromQueue,
            guest: room.role === 'guest',
          }}
          discord={{ available: discordAvail, enabled: discordOn, onToggle: setDiscordOn }}
          automix={{ secs: automixSecs, onChange: setAutomixSecs }}
          stage={{ onEnter: () => window.cupid?.setStageMode?.(true) }}
          eqGains={eqGains}
          onEqChange={setEqGains}
          sleepMins={sleepMins}
          onSleepChange={setSleepMins}
          musicService={musicService}
          onMusicService={(next) => {
            setMusicService(next);
            try { localStorage.setItem('cupid-player-music-service', next); } catch { /* ignore */ }
            if (next === 'local') { setSource('local'); setQueue(null); }
          }}
          onReloadLocal={loadLocalPlaylist}
          spotify={{
            connected: spotifyConnected,
            playlists: spotifyPlaylists,
            onLogin: () => spotifyLogin(),
            onLogout: () => {
              spotifyLogout();
              setSpotifyConnected(false);
              setSpotifyPlaylists([]);
              if (source === 'streaming') { setSource('local'); setQueue(null); }
            },
            onSelect: (id) => loadPlaylist(id, 'spotify'),
            onRefresh: () => loadSpotifyPlaylists(),
          }}
          apple={{
            connected: appleConnected,
            playlists: applePlaylists,
            onLogin: async () => {
              try {
                await appleLogin();
                setAppleConnected(true);
                loadApplePlaylists();
              } catch (err) {
                setSettingsError(err.message);
              }
            },
            onLogout: () => {
              appleLogout();
              setAppleConnected(false);
              setApplePlaylists([]);
              if (source === 'streaming') { setSource('local'); setQueue(null); }
            },
            onSelect: (id) => loadPlaylist(id, 'apple'),
            onRefresh: () => loadApplePlaylists(),
          }}
          youtube={{
            configured: isYouTubeConfigured(),
            connected: youtubeConnected,
            loggingIn: youtubeLoggingIn,
            playlists: youtubePlaylists,
            urlInput: youtubeUrlInput,
            onUrlInput: setYoutubeUrlInput,
            onLoadUrl: loadYoutubePlaylistFromUrl,
            onLogin: async () => {
              setYoutubeLoggingIn(true);
              setSettingsError(null);
              try {
                await youtubeLogin();
                setYoutubeConnected(true);
                loadYoutubePlaylists();
              } catch (err) {
                if (err.message !== 'cancelled') setSettingsError(err.message);
              } finally {
                setYoutubeLoggingIn(false);
              }
            },
            onCancel: () => {
              cancelYouTubeLogin();
              setYoutubeLoggingIn(false);
            },
            onLogout: () => {
              youtubeLogout();
              setYoutubeConnected(false);
              setYoutubePlaylists([]);
              if (source === 'streaming') { setSource('local'); setQueue(null); }
            },
            onSelect: (id) => loadPlaylist(id, 'youtube'),
            onRefresh: () => loadYoutubePlaylists(),
          }}
          room={{
            role: room.role,
            address: room.address,
            peerCount: room.peerCount,
            error: room.error,
            joinInput: roomJoinInput,
            onJoinInput: setRoomJoinInput,
            onHost: room.host,
            onJoin: room.join,
            onLeave: room.leave,
          }}
          error={settingsError}
          loadingPlaylists={loadingPlaylists}
          loadingPlaylist={loadingPlaylist}
        />
      )}
    </div>
    {winMode === 'full' && (
      <div className="side-stack">
        <SearchPanel
          onSearch={searchAll}
          onPlayTrack={playTrackUi}
          playlists={playlists}
          onAddToPlaylist={addToPlaylist}
        />
        <LyricsPanel
          lines={lyrics?.lines}
          plain={lyrics?.plain}
          currentTime={currentTime}
          title={track?.title}
        />
      </div>
    )}
    </>
    )}
    </div>
  );
}
