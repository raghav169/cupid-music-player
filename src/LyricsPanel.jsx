import { useRef, useEffect } from 'react';
import { activeLyricIndex } from './lrc.js';

/**
 * Synced lyrics panel — highlights the active line (last line at or
 * before currentTime) and keeps it scrolled to the middle.
 */
export default function LyricsPanel({ lines, plain, currentTime, title }) {
  const listRef = useRef(null);
  const activeIdx = activeLyricIndex(lines || [], currentTime ?? 0);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.children[activeIdx];
    if (el) el.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    else list.scrollTop = 0;
  }, [activeIdx, lines]);

  return (
    <div className="side-panel lyrics-panel">
      <div className="side-panel-title">lyrics</div>
      {!lines?.length && !plain && (
        <div className="side-hint">{title ? 'no lyrics found' : 'play a song'}</div>
      )}
      {lines?.length > 0 && (
        <div className="lyrics-list" ref={listRef}>
          {lines.map((l, i) => (
            <div
              key={i}
              className={`lyrics-line ${i === activeIdx ? 'active' : ''} ${i < activeIdx ? 'past' : ''}`}
            >
              {l.text || '·'}
            </div>
          ))}
        </div>
      )}
      {plain && !lines?.length && (
        <div className="lyrics-plain">{plain}</div>
      )}
    </div>
  );
}
