import { useState, useEffect, useRef } from 'react';
import { SettingsDropdown } from './SettingsPanel.jsx';

const GROUPS = [
  ['local', 'library'],
  ['spotify', 'spotify'],
  ['apple', 'apple'],
  ['youtube', 'youtube'],
];

/**
 * Right-side panel shown in full mode: one search box fanning out to the
 * local library, Spotify, Apple Music, and YouTube, grouped results with
 * play + add-to-playlist actions.
 */
export default function SearchPanel({ onSearch, onPlayTrack, playlists, onAddToPlaylist }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [addTarget, setAddTarget] = useState({}); // `${group}:${idx}` → playlist name
  const names = Object.keys(playlists);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!q.trim()) { setResults(null); return; }
    setSearching(true);
    const seq = ++seqRef.current;
    const t = setTimeout(async () => {
      const r = await onSearch(q.trim());
      if (seq === seqRef.current) { setResults(r); setSearching(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [q, onSearch]);

  return (
    <div className="side-panel search-panel">
      <div className="side-panel-title">search</div>
      <input
        className="settings-input"
        type="text"
        placeholder="search everywhere..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {searching && <div className="side-hint">searching...</div>}
      {results && GROUPS.map(([key, label]) => {
        const items = results[key] || [];
        if (!items.length) return null;
        return (
          <div key={key}>
            <div className="side-label">{label}</div>
            <div className="side-list">
              {items.map((t, i) => (
                <div key={`${key}-${i}`} className="side-row result-row">
                  {t.art && <img src={t.art} className="result-art" alt="" />}
                  <button
                    className="side-item grow"
                    onClick={() => onPlayTrack(t)}
                  >
                    {t.title} <span className="side-dim">— {t.artist}</span>
                  </button>
                  {names.length > 0 && (
                    <SettingsDropdown
                      value={addTarget[`${key}:${i}`] || ''}
                      options={[
                        { value: '', label: '+ playlist' },
                        ...names.map((n) => ({ value: n, label: n })),
                      ]}
                      onChange={(v) => {
                        setAddTarget((m) => ({ ...m, [`${key}:${i}`]: v }));
                        if (v) onAddToPlaylist(v, t);
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {results && !searching && GROUPS.every(([k]) => !(results[k] || []).length) && (
        <div className="side-hint">no results</div>
      )}
    </div>
  );
}
