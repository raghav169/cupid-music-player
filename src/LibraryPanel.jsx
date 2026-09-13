import { useState } from 'react';
import { SettingsDropdown } from './SettingsPanel.jsx';

/**
 * Left-side panel shown in full mode: user playlists (CRUD + play),
 * recently played, and "add current song to playlist".
 */
export default function LibraryPanel({
  playlists, recents, currentTrack,
  onPlayTracks, onAddCurrentTo, onCreatePlaylist, onDeletePlaylist, onRemoveTrack,
}) {
  const [expanded, setExpanded] = useState(null);
  const [newName, setNewName] = useState('');
  const [addTarget, setAddTarget] = useState('');
  const names = Object.keys(playlists);

  return (
    <div className="side-panel library-panel">
      <div className="side-panel-title">library</div>

      <div className="side-label">playlists</div>
      <div className="side-row">
        <input
          className="settings-input"
          type="text"
          placeholder="new playlist name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newName.trim()) {
              onCreatePlaylist(newName.trim());
              setNewName('');
            }
          }}
        />
        <button
          className="settings-theme-btn"
          disabled={!newName.trim()}
          onClick={() => { onCreatePlaylist(newName.trim()); setNewName(''); }}
        >
          +
        </button>
      </div>
      {names.length === 0 && <div className="side-hint">no playlists yet</div>}
      {names.map((name) => (
        <div key={name} className="playlist-block">
          <div className="side-row">
            <button
              className="side-item grow"
              onClick={() => setExpanded(expanded === name ? null : name)}
            >
              {name} <span className="side-dim">({playlists[name].length})</span>
            </button>
            <button
              className="settings-theme-btn"
              title="play"
              onClick={() => playlists[name].length && onPlayTracks(playlists[name], 0)}
            >
              ▶
            </button>
            <button
              className="settings-theme-btn danger"
              title="delete playlist"
              onClick={() => onDeletePlaylist(name)}
            >
              ×
            </button>
          </div>
          {expanded === name && (
            <div className="playlist-tracks">
              {playlists[name].length === 0 && <div className="side-hint">empty</div>}
              {playlists[name].map((t, i) => (
                <div key={`${t.title}-${i}`} className="side-row">
                  <button
                    className="side-item grow"
                    onClick={() => onPlayTracks(playlists[name], i)}
                  >
                    {t.title} <span className="side-dim">— {t.artist}</span>
                  </button>
                  <button
                    className="settings-theme-btn danger"
                    onClick={() => onRemoveTrack(name, i)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <div className="side-label">add current song</div>
      {currentTrack?.title && currentTrack.title !== 'No track' && names.length > 0 ? (
        <div className="side-row">
          <SettingsDropdown
            value={addTarget}
            options={names.map((n) => ({ value: n, label: n }))}
            onChange={setAddTarget}
          />
          <button
            className="settings-theme-btn"
            disabled={!addTarget}
            onClick={() => onAddCurrentTo(addTarget, currentTrack)}
          >
            add
          </button>
        </div>
      ) : (
        <div className="side-hint">{names.length ? 'nothing playing' : 'make a playlist first'}</div>
      )}

      <div className="side-label">recently played</div>
      {recents.length === 0 && <div className="side-hint">nothing yet</div>}
      <div className="side-list">
        {recents.slice(0, 10).map((r, i) => (
          <button
            key={`${r.at}-${i}`}
            className="side-item"
            onClick={() => onPlayTracks([r.track], 0)}
          >
            {r.track.title} <span className="side-dim">— {r.track.artist}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
