import { useState, useRef, useCallback, useEffect } from 'react';
import { computeGuestActions, sameTrack } from './sync.js';

const BROADCAST_MS = 2000;

// A track is only meaningful to broadcast if a guest could actually load
// it — the 'No track' placeholder (empty file/uri, empty artist) would make
// a guest search YouTube for "No track" and play a random song.
const isPlayable = (t) =>
  !!(t && (t.videoId || t.uri || t.file || (t.title && t.artist)));

// Normalize a room address: bare trycloudflare host / https URL → wss;
// ip:port → ws (LAN).
function roomWsUrl(addr) {
  const a = addr.trim().replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '').replace(/\/+$/, '');
  if (a.endsWith('.trycloudflare.com')) return `wss://${a}`;
  return `ws://${a}`;
}

/**
 * Listen Together room — host-authoritative, works over LAN or internet.
 *
 * Host: ws server in main + a cloudflared quick tunnel when available
 *       (shareable *.trycloudflare.com address; LAN ip:port otherwise).
 *       Broadcasts { type:'state', track, position, isPlaying, sentAt }
 *       every 2s and applies guest commands (play/pause/seek/next/prev/
 *       playTrack) — Jam-style, anyone can control.
 * Guest: WebSocket client; applies host state via computeGuestActions
 *        and forwards its transport presses as commands.
 */
export default function useRoom({ getPlayerState, playerRef, playTrackList }) {
  const [role, setRole] = useState(null); // null | 'host' | 'guest'
  const [address, setAddress] = useState('');
  const [peerCount, setPeerCount] = useState(0);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);
  const broadcastTimer = useRef(null);
  const cmdUnsubRef = useRef(null);
  const joinCancelRef = useRef(null);
  // Min observed (guestNow - hostSentAt) ≈ clock skew + min transit — a
  // stable elapsed-time estimate immune to per-message jitter
  const minDeltaRef = useRef(null);

  const leave = useCallback(() => {
    joinCancelRef.current?.();
    joinCancelRef.current = null;
    if (broadcastTimer.current) { clearInterval(broadcastTimer.current); broadcastTimer.current = null; }
    if (cmdUnsubRef.current) { cmdUnsubRef.current(); cmdUnsubRef.current = null; }
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
    window.cupid?.roomStop?.();
    setRole(null); setAddress(''); setPeerCount(0);
  }, []);

  useEffect(() => leave, [leave]);

  const host = useCallback(async () => {
    setError(null);
    try {
      const { port, publicUrl } = await window.cupid.roomHost();
      const ip = await window.cupid.roomLocalIp();
      setRole('host');
      // Prefer the public tunnel URL — reachable from anywhere
      setAddress(publicUrl ? publicUrl.replace(/^https:\/\//, '') : `${ip}:${port}`);

      const push = () => {
        const s = getPlayerState();
        if (!isPlayable(s?.track)) return;
        window.cupid.roomBroadcast({
          type: 'state',
          // art can be a multi-MB data URL (embedded art) or a
          // cupid-local:// URL that only resolves on this machine —
          // only forward real remote art
          track: { ...s.track, art: s.track.art?.startsWith('http') ? s.track.art : null },
          position: s.currentTime,
          isPlaying: s.isPlaying,
          sentAt: Date.now(),
        });
      };

      // Guests' transport commands get applied here, then rebroadcast
      cmdUnsubRef.current = window.cupid.onRoomCommand((msg) => {
        if (msg?.type !== 'command') return;
        const p = playerRef.current;
        const s = getPlayerState();
        if (!p || !s) return;
        switch (msg.op) {
          case 'toggle': p.togglePlay(); break;
          case 'play': if (!s.isPlaying) p.togglePlay(); break;
          case 'pause': if (s.isPlaying) p.togglePlay(); break;
          case 'seek':
            // Guests tag seeks with the track they think is playing —
            // drop it if the host already moved on
            if (msg.track && !sameTrack(msg.track, s.track)) return;
            if (typeof msg.fraction === 'number') p.seek(Math.max(0, Math.min(1, msg.fraction)));
            break;
          case 'next': p.next(); break;
          case 'prev': p.prev(); break;
          case 'playTrack': if (isPlayable(msg.track)) playTrackList([msg.track], 0); break;
          default: return;
        }
        // React state hasn't re-rendered yet — a synchronous push would
        // rebroadcast the pre-command position/isPlaying. Wait a beat.
        setTimeout(push, 300);
      });

      push();
      broadcastTimer.current = setInterval(async () => {
        push();
        setPeerCount(await window.cupid.roomPeerCount());
      }, BROADCAST_MS);
    } catch (err) {
      setError(err.message);
    }
  }, [getPlayerState, playerRef, playTrackList]);

  const join = useCallback((addr) => {
    setError(null);
    if (!addr.trim()) return;
    // Double-join would orphan the first attempt's socket + retry timers —
    // cancel it before starting over
    joinCancelRef.current?.();
    if (wsRef.current) { wsRef.current.onclose = null; try { wsRef.current.close(); } catch {} wsRef.current = null; }
    minDeltaRef.current = null;
    const url = roomWsUrl(addr);
    let attempts = 0;
    let wasConnected = false;
    let cancelled = false;
    joinCancelRef.current = () => { cancelled = true; };
    setRole('connecting');

    const handleMessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type !== 'state' || !isPlayable(msg.track)) return;
      const s = getPlayerState();
      const p = playerRef.current;
      if (!s || !p) return;
      const delta = Date.now() - msg.sentAt;
      minDeltaRef.current = minDeltaRef.current == null ? delta : Math.min(minDeltaRef.current, delta);
      // sentAt + minDelta ≈ host-time "now" with skew+min transit — more
      // stable than per-message elapsed, which jitters over tunnels
      const a = computeGuestActions(msg, s, msg.sentAt + minDeltaRef.current);
      if (a.loadTrack) {
        // Carry the host's position/playing into the load — otherwise the
        // guest autoplays from 0:00 until the next broadcast corrects it
        playTrackList([a.loadTrack], 0, { seekTo: a.seek, playing: a.playing });
        return;
      }
      if (a.seek != null && s.duration > 0) {
        p.seek(Math.max(0, Math.min(1, a.seek / s.duration)));
      }
      if (a.playing === true && !s.isPlaying) p.togglePlay();
      if (a.playing === false && s.isPlaying) p.togglePlay();
    };

    const tryConnect = () => {
      if (cancelled) return;
      attempts++;
      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;
        ws.onopen = () => { wasConnected = true; setRole('guest'); setAddress(addr.trim()); setError(null); };
        ws.onmessage = handleMessage;
        ws.onclose = () => {
          if (cancelled || wasConnected) {
            // Established-then-dropped — leave the room
            setRole(null); setAddress('');
            return;
          }
          // Quick-tunnel DNS can take a few seconds to propagate — retry
          if (attempts < 12) {
            setTimeout(tryConnect, 2500);
            return;
          }
          setRole(null); setAddress('');
          setError('could not reach the room');
        };
        ws.onerror = () => { try { ws.close(); } catch {} };
      } catch (err) {
        setError(err.message);
        setRole(null);
      }
    };
    tryConnect();
  }, [getPlayerState, playerRef, playTrackList]);

  // Guest → host control. Hosts use their normal transport directly.
  const command = useCallback((op, extra = {}) => {
    if (role !== 'guest' || wsRef.current?.readyState !== 1) return;
    wsRef.current.send(JSON.stringify({ type: 'command', op, ...extra }));
  }, [role]);

  return { role, address, peerCount, error, host, join, leave, command };
}
