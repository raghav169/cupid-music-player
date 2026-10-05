import { useEffect, useMemo, useRef, useState } from 'react';
import Visualizer from './Visualizer.jsx';

function fmt(seconds) {
  if (!seconds || !isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Deterministic sparkle positions so hearts don't jump on re-render
const HEARTS = Array.from({ length: 14 }, (_, i) => ({
  left: `${(i * 67 + 13) % 100}%`,
  top: `${(i * 37 + 21) % 100}%`,
  size: 10 + ((i * 7) % 16),
  delay: `${-(i * 1.7)}s`,
  dur: `${5 + (i % 5)}s`,
}));

/**
 * Stage — the pretty fullscreen mode. A big art card on a spinning vinyl
 * over a floating-hearts backdrop, chunky pixel transport, click-to-seek
 * bar, live lyric line, and the visualizer strip. All styling lives in
 * App.css under .stage-* so themes recolor it via the same CSS vars.
 */
export default function StageView({
  track,
  isPlaying,
  progress,
  duration,
  currentTime,
  onTogglePlay,
  onNext,
  onPrev,
  onSeek,
  volume,
  onVolume,
  muted,
  onMute,
  playMode,
  onCyclePlayMode,
  engine,
  theme,
  lyrics,
  onExitStage,
}) {
  const barRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [hoverPct, setHoverPct] = useState(null);
  const volRef = useRef(null);
  const [volDragging, setVolDragging] = useState(false);
  // Window drag listeners capture the render at drag-start — a crossfade
  // promote mid-drag swaps the audio element, so route through refs that
  // always hold the live handlers
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const onVolumeRef = useRef(onVolume);
  onVolumeRef.current = onVolume;

  // The synced-lyric line under the needle (if the track has them)
  const lyricLine = useMemo(() => {
    if (!lyrics?.lines?.length) return null;
    let cur = null;
    for (const l of lyrics.lines) {
      if (l.time <= currentTime) cur = l.text;
      else break;
    }
    return cur;
  }, [lyrics, currentTime]);

  const pct = hoverPct ?? progress;
  const shownPct = Math.max(0, Math.min(1, pct));

  const seekTo = (e) => {
    const rect = barRef.current.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeekRef.current(p);
    setHoverPct(p);
  };

  // Keep scrubbing while the button is held — outside the bar too
  useEffect(() => {
    if (!dragging) return;
    const move = (e) => seekTo(e);
    const up = () => { setDragging(false); setHoverPct(null); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const setVol = (e) => {
    const rect = volRef.current.getBoundingClientRect();
    const v = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onVolumeRef.current(v);
  };

  useEffect(() => {
    if (!volDragging) return;
    const move = (e) => setVol(e);
    const up = () => setVolDragging(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volDragging]);

  return (
    <div className="stage">
      {/* floating hearts backdrop */}
      <div className="stage-hearts" aria-hidden="true">
        {HEARTS.map((h, i) => (
          <span
            key={i}
            className="stage-heart"
            style={{ left: h.left, top: h.top, fontSize: h.size, animationDelay: h.delay, animationDuration: h.dur }}
          >♥</span>
        ))}
      </div>

      {/* window controls */}
      <div className="stage-winbar">
        <button className="stage-btn stage-win" onClick={() => window.cupid?.minimize()} aria-label="minimize">–</button>
        <button className="stage-btn stage-win" onClick={onExitStage} aria-label="exit stage">⛶</button>
        <button className="stage-btn stage-win" onClick={() => window.cupid?.close()} aria-label="close">✕</button>
      </div>

      <div className="stage-center">
        {/* vinyl + art card */}
        <div className={`stage-disc-wrap ${isPlaying ? 'spinning' : ''}`}>
          <div className="stage-disc" />
          <div className="stage-art-card">
            {track?.art
              ? <img src={track.art} alt="" draggable={false} />
              : <div className="stage-art-empty">♥</div>}
          </div>
        </div>

        <div className="stage-info">
          <div className="stage-title">{track?.title || 'No track'}</div>
          <div className="stage-artist">by {track?.artist || '…'}</div>
          <div className="stage-lyric">{lyricLine || ' '}</div>
        </div>

        {/* transport */}
        <div className="stage-transport">
          <button className="stage-btn" onClick={onPrev} aria-label="previous">⏮</button>
          <button className="stage-btn stage-play" onClick={onTogglePlay} aria-label={isPlaying ? 'pause' : 'play'}>
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button className="stage-btn" onClick={onNext} aria-label="next">⏭</button>
        </div>

        <div className="stage-subrow">
          <button
            className={`stage-btn stage-mini ${playMode !== 'normal' ? 'on' : ''}`}
            onClick={onCyclePlayMode}
            title={playMode}
            aria-label={`play mode: ${playMode}`}
          >{playMode === 'repeat' ? '🔂' : '🔀'}</button>
          <button className="stage-btn stage-mini" onClick={onMute} aria-label={muted ? 'unmute' : 'mute'}>
            {muted ? '🔇' : '🔊'}
          </button>
          <div
            className="stage-volbar"
            ref={volRef}
            onMouseDown={(e) => { e.preventDefault(); setVolDragging(true); setVol(e); }}
          >
            <div className="stage-volfill" style={{ width: `${(muted ? 0 : volume) * 100}%` }} />
          </div>
        </div>

        {/* progress */}
        <div className="stage-progress-row">
          <span className="stage-time">{fmt(currentTime)}</span>
          <div
            className="stage-progress"
            ref={barRef}
            onMouseDown={(e) => { e.preventDefault(); setDragging(true); seekTo(e); }}
            onMouseMove={(e) => {
              if (dragging) return; // window listener handles the drag
              const rect = barRef.current.getBoundingClientRect();
              setHoverPct(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
            }}
            onMouseLeave={() => { if (!dragging) setHoverPct(null); }}
          >
            <div className="stage-progress-fill" style={{ width: `${shownPct * 100}%` }} />
            <div className="stage-progress-star" style={{ left: `${shownPct * 100}%` }}>♥</div>
          </div>
          <span className="stage-time">{fmt(duration - currentTime)}</span>
        </div>

        <Visualizer engine={engine} playing={isPlaying} theme={theme} />
      </div>

      <div className="stage-hint">f / esc to leave · space plays · ← → seeks</div>
    </div>
  );
}
