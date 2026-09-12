import { useState, useRef, useCallback, useEffect } from 'react';
import { computeGuestActions } from './sync.js';

const BROADCAST_MS = 2000;

/**
 * Listen Together room — LAN only.
 *
 * Host: starts a ws server in the main process, broadcasts
 *       { type:'state', track, position, isPlaying, sentAt } every 2s.
 * Guest: plain WebSocket client to ws://ip:port, applies host state via
 *        computeGuestActions (track change → play it; drift > 0.4s → seek;
 *        play/pause mismatch → toggle).
 *
 * getPlayerState() must return { track, currentTime, isPlaying, duration };
 * playerRef.current must expose { seek(fraction), togglePlay(), isPlaying }.
 */
export default function useRoom({ getPlayerState, playerRef, playTrackList }) {
  const [role, setRole] = useState(null); // null | 'host' | 'guest'
  const [address, setAddress] = useState('');
  const [peerCount, setPeerCount] = useState(0);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);
  const broadcastTimer = useRef(null);

  const leave = useCallback(() => {
    if (broadcastTimer.current) { clearInterval(broadcastTimer.current); broadcastTimer.current = null; }
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
    window.cupid?.roomStop?.();
    setRole(null); setAddress(''); setPeerCount(0);
  }, []);

  // Stop everything on unmount
  useEffect(() => leave, [leave]);

  const host = useCallback(async () => {
    setError(null);
    try {
      const port = await window.cupid.roomHost();
      const ip = await window.cupid.roomLocalIp();
      setRole('host');
      setAddress(`${ip}:${port}`);

      const push = () => {
        const s = getPlayerState();
        if (!s?.track) return;
        window.cupid.roomBroadcast({
          type: 'state',
          track: s.track,
          position: s.currentTime,
          isPlaying: s.isPlaying,
          sentAt: Date.now(),
        });
      };
      push();
      broadcastTimer.current = setInterval(async () => {
        push();
        setPeerCount(await window.cupid.roomPeerCount());
      }, BROADCAST_MS);
    } catch (err) {
      setError(err.message);
    }
  }, [getPlayerState]);

  const join = useCallback((addr) => {
    setError(null);
    const trimmed = addr.trim();
    if (!trimmed) return;
    try {
      const ws = new WebSocket(`ws://${trimmed}`);
      wsRef.current = ws;
      ws.onopen = () => { setRole('guest'); setAddress(trimmed); };
      ws.onerror = () => setError('could not reach the room');
      ws.onclose = () => { setRole(null); setAddress(''); };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type !== 'state') return;
        const s = getPlayerState();
        const p = playerRef.current;
        if (!s || !p) return;
        const a = computeGuestActions(msg, s);
        if (a.loadTrack) {
          playTrackList([a.loadTrack], 0);
          // seek/play applied on the next state tick once loaded
          return;
        }
        if (a.seek != null && s.duration > 0) {
          p.seek(Math.max(0, Math.min(1, a.seek / s.duration)));
        }
        if (a.playing === true && !s.isPlaying) p.togglePlay();
        if (a.playing === false && s.isPlaying) p.togglePlay();
      };
    } catch (err) {
      setError(err.message);
    }
  }, [getPlayerState, playerRef, playTrackList]);

  return { role, address, peerCount, error, host, join, leave };
}
