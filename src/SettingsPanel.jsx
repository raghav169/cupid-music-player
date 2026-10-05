import { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import EqPanel from './EqPanel.jsx';
import { THEMES } from './useTheme.js';

export function SettingsDropdown({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const updateRect = () => {
      const el = triggerRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        setMenuRect({ top: r.bottom, left: r.left, width: r.width });
      }
    };
    updateRect();
    const onMouseDown = (e) => {
      if (rootRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', updateRect);
    // Close on scroll anywhere — positions become stale fast
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div className={`settings-dropdown ${open ? 'open' : ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="settings-dropdown-trigger"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current?.label ?? value}</span>
        <span className="settings-dropdown-chevron" aria-hidden="true">▾</span>
      </button>
      {open && menuRect && createPortal(
        <div
          ref={menuRef}
          className="settings-dropdown-menu"
          role="listbox"
          style={{
            position: 'fixed',
            top: `${menuRect.top + 2}px`,
            left: `${menuRect.left}px`,
            width: `${menuRect.width}px`,
          }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`settings-dropdown-item ${o.value === value ? 'active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </button>
          ))}
        </div>,
        // Portal to .app-shell — it carries the theme CSS custom properties
        // (--color-*, --w) AND isn't clip-path'd like .player, so menus
        // opened from the side panels (library/search) stay visible.
        document.querySelector('.app-shell') ?? document.body,
      )}
    </div>
  );
}

export function PlaylistList({ loading, playlists, loadingPlaylist, onSelect, emptyMessage = 'no playlists found' }) {
  return (
    <div className="settings-playlist-list">
      {loading ? (
        <div className="settings-label">loading...</div>
      ) : playlists.length === 0 ? (
        <div className="settings-label">{emptyMessage}</div>
      ) : (
        playlists.map((p) => (
          <button
            key={p.id}
            className={`settings-playlist-item ${loadingPlaylist ? 'disabled' : ''}`}
            onClick={() => onSelect(p.id)}
            disabled={loadingPlaylist}
          >
            {p.name}
          </button>
        ))
      )}
    </div>
  );
}

/**
 * The settings panel extracted from App.jsx. `spotify`/`apple`/`youtube`
 * each take { connected, playlists, onLogin, onLogout, onSelect, onRefresh };
 * youtube additionally takes { configured, loggingIn, onCancel, urlInput, onUrlInput, onLoadUrl }.
 */
export default function SettingsPanel({
  theme, onTheme,
  customHue, onCustomHue,
  queue,
  discord,
  automix,
  stage,
  eqGains, onEqChange,
  sleepMins, onSleepChange,
  musicService, onMusicService,
  onReloadLocal,
  spotify, apple, youtube,
  room,
  error,
  loadingPlaylists, loadingPlaylist,
}) {
  return (
    <div className="settings-panel">
      <div className="settings-panel-inner">
        {queue && queue.tracks.length > 0 && (
          <>
            <div className="settings-label">queue</div>
            <div className="queue-list">
              {queue.tracks.map((t, i) => (
                <div key={`${t.title}-${i}`} className="side-row">
                  <button
                    className={`side-item grow ${i === queue.index ? 'active' : ''}`}
                    onClick={() => queue.onJump(i)}
                  >
                    {i === queue.index ? '♥ ' : ''}{t.title}
                    <span className="side-dim"> — {t.artist}</span>
                  </button>
                  {!queue.guest && queue.tracks.length > 1 && (
                    <button
                      className="settings-theme-btn danger"
                      title="remove from queue"
                      onClick={() => queue.onRemove(i)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <div className="settings-label">theme</div>
        <div className="settings-theme-row">
          {THEMES.map((t) => (
            <button
              key={t}
              className={`settings-theme-btn ${theme === t ? 'active' : ''}`}
              onClick={() => onTheme(t)}
            >
              {t}
            </button>
          ))}
        </div>
        {theme === 'custom' && (
          <div className="hue-picker">
            <input
              type="range"
              className="hue-slider"
              min="0"
              max="359"
              value={customHue}
              onChange={(e) => onCustomHue(Number(e.target.value))}
              aria-label="custom theme hue"
            />
            <span className="settings-label">hue {customHue}°</span>
          </div>
        )}

        {discord?.available && (
          <>
            <div className="settings-label">discord</div>
            <button
              className={`settings-theme-btn ${discord.enabled ? 'active' : ''}`}
              onClick={() => discord.onToggle(!discord.enabled)}
            >
              rich presence: {discord.enabled ? 'on' : 'off'}
            </button>
          </>
        )}

        {stage && (
          <>
            <div className="settings-label">view</div>
            <button className="settings-theme-btn" onClick={stage.onEnter}>
              stage mode ⛶
            </button>
          </>
        )}

        {automix && (
          <>
            <div className="settings-label">automix</div>
            <button
              className={`settings-theme-btn ${automix.secs > 0 ? 'active' : ''}`}
              onClick={() => automix.onChange(automix.secs > 0 ? 0 : 6)}
            >
              crossfade: {automix.secs > 0 ? 'on' : 'off'}
            </button>
            {automix.secs > 0 && (
              <div className="hue-picker">
                <input
                  type="range"
                  className="hue-slider"
                  min="1"
                  max="12"
                  value={automix.secs}
                  onChange={(e) => automix.onChange(Number(e.target.value))}
                  aria-label="automix crossfade seconds"
                />
                <span className="settings-label">fade {automix.secs}s</span>
              </div>
            )}
          </>
        )}

        <div className="settings-label">eq</div>
        <EqPanel gains={eqGains} onChange={onEqChange} />
        <div className="settings-label">sleep timer</div>
        <SettingsDropdown
          value={String(sleepMins)}
          options={[
            { value: '0', label: 'off' },
            { value: '15', label: '15 min' },
            { value: '30', label: '30 min' },
            { value: '45', label: '45 min' },
            { value: '60', label: '60 min' },
          ]}
          onChange={(v) => onSleepChange(Number(v))}
        />
        <div className="settings-label">music</div>
        <SettingsDropdown
          value={musicService}
          options={[
            { value: 'local', label: 'local' },
            { value: 'spotify', label: 'spotify' },
            { value: 'apple', label: 'apple' },
            { value: 'youtube', label: 'youtube' },
          ]}
          onChange={onMusicService}
        />

        {musicService === 'local' && (
          <div className="settings-theme-row">
            <button className="settings-theme-btn" onClick={onReloadLocal}>
              reload
            </button>
            <button
              className="settings-theme-btn"
              onClick={() => window.cupid?.openMusicFolder?.()}
            >
              open folder
            </button>
          </div>
        )}

        {musicService === 'spotify' && (
          !spotify.connected ? (
            <button className="settings-theme-btn" onClick={spotify.onLogin}>
              log in
            </button>
          ) : (
            <>
              <PlaylistList
                loading={loadingPlaylists}
                playlists={spotify.playlists}
                loadingPlaylist={loadingPlaylist}
                onSelect={spotify.onSelect}
              />
              <div className="settings-theme-row">
                <button
                  className={`settings-theme-btn ${loadingPlaylists ? 'disabled' : ''}`}
                  disabled={loadingPlaylists}
                  onClick={spotify.onRefresh}
                >
                  refresh
                </button>
                <button className="settings-theme-btn" onClick={spotify.onLogout}>
                  logout
                </button>
              </div>
            </>
          )
        )}

        {musicService === 'apple' && (
          !apple.connected ? (
            <button className="settings-theme-btn" onClick={apple.onLogin}>
              log in
            </button>
          ) : (
            <>
              <PlaylistList
                loading={loadingPlaylists}
                playlists={apple.playlists}
                loadingPlaylist={loadingPlaylist}
                onSelect={apple.onSelect}
              />
              <div className="settings-theme-row">
                <button
                  className={`settings-theme-btn ${loadingPlaylists ? 'disabled' : ''}`}
                  disabled={loadingPlaylists}
                  onClick={apple.onRefresh}
                >
                  refresh
                </button>
                <button className="settings-theme-btn" onClick={apple.onLogout}>
                  logout
                </button>
              </div>
            </>
          )
        )}

        {musicService === 'youtube' && (
          youtube.configured ? (
            !youtube.connected ? (
              <div className="settings-theme-row">
                <button
                  className={`settings-theme-btn ${youtube.loggingIn ? 'disabled' : ''}`}
                  disabled={youtube.loggingIn}
                  onClick={youtube.onLogin}
                >
                  {youtube.loggingIn ? 'waiting for browser...' : 'log in with google'}
                </button>
                {youtube.loggingIn && (
                  <button className="settings-theme-btn" onClick={youtube.onCancel}>
                    cancel
                  </button>
                )}
              </div>
            ) : (
              <>
                <PlaylistList
                  loading={loadingPlaylists}
                  playlists={youtube.playlists}
                  loadingPlaylist={loadingPlaylist}
                  onSelect={youtube.onSelect}
                />
                <div className="settings-theme-row">
                  <button
                    className={`settings-theme-btn ${loadingPlaylists ? 'disabled' : ''}`}
                    disabled={loadingPlaylists}
                    onClick={youtube.onRefresh}
                  >
                    refresh
                  </button>
                  <button className="settings-theme-btn" onClick={youtube.onLogout}>
                    logout
                  </button>
                </div>
              </>
            )
          ) : (
            <>
              <input
                className="settings-input"
                type="text"
                placeholder="paste a youtube playlist link"
                value={youtube.urlInput}
                onChange={(e) => youtube.onUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && youtube.urlInput.trim()) {
                    youtube.onLoadUrl(youtube.urlInput.trim());
                  }
                }}
                disabled={loadingPlaylist}
              />
              <button
                className={`settings-theme-btn ${loadingPlaylist || !youtube.urlInput.trim() ? 'disabled' : ''}`}
                onClick={() => youtube.onLoadUrl(youtube.urlInput.trim())}
                disabled={loadingPlaylist || !youtube.urlInput.trim()}
              >
                {loadingPlaylist ? 'loading...' : 'load playlist'}
              </button>
            </>
          )
        )}

        {room && (
          <>
            <div className="settings-label">listen together</div>
            {room.role ? (
              <>
                <div className="settings-theme-row">
                  <span className="settings-label">
                    {room.role === 'connecting' ? 'connecting…'
                      : room.role === 'host' ? `hosting — ${room.address}` : `in room — ${room.address}`}
                    {room.role === 'host' && room.peerCount > 0 ? ` (${room.peerCount} listening)` : ''}
                  </span>
                  <button className="settings-theme-btn" onClick={room.onLeave}>
                    {room.role === 'connecting' ? 'cancel' : 'leave'}
                  </button>
                </div>
                {room.role === 'host' && (
                  <div className="settings-label" style={{ opacity: 0.7 }}>
                    share that address — works over the internet
                  </div>
                )}
              </>
            ) : (
              <>
                <button className="settings-theme-btn" onClick={room.onHost}>
                  host a room
                </button>
                <div className="settings-theme-row">
                  <input
                    className="settings-input"
                    type="text"
                    placeholder="host ip:port"
                    value={room.joinInput}
                    onChange={(e) => room.onJoinInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && room.joinInput.trim()) room.onJoin(room.joinInput);
                    }}
                  />
                  <button
                    className="settings-theme-btn"
                    disabled={!room.joinInput.trim()}
                    onClick={() => room.onJoin(room.joinInput)}
                  >
                    join
                  </button>
                </div>
                {room.error && <div className="settings-error">{room.error}</div>}
              </>
            )}
          </>
        )}

        <div className="settings-label">keys</div>
        <div className="side-hint">
          space play · ←/→ seek · ↑/↓ volume · n/p next/prev · m mute · t theme · f stage · esc back
        </div>

        {error && <div className="settings-error">{error}</div>}
      </div>
    </div>
  );
}
