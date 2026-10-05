const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cupid', {
  version: process.versions.electron,
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  resize: (data) => ipcRenderer.send('window-resize', data),
  toggleMode: () => ipcRenderer.send('window-toggle-mode'),
  onModeChange: (cb) => {
    const listener = (_e, mode) => cb(mode);
    ipcRenderer.on('window-mode-changed', listener);
    return () => ipcRenderer.removeListener('window-mode-changed', listener);
  },
  openExternal: (url) => ipcRenderer.send('open-external', url),
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),
  // Windows integration: push playback state to main (taskbar/tray),
  // receive transport commands back (taskbar buttons, tray menu, media keys).
  setPlaybackState: (state) => ipcRenderer.send('playback-state', state),
  onMediaCommand: (cb) => {
    const listener = (_e, op) => cb(op);
    ipcRenderer.on('media-command', listener);
    return () => ipcRenderer.removeListener('media-command', listener);
  },
  getStreamUrl: (title, artist) => ipcRenderer.invoke('get-stream-url', title, artist),
  getStreamUrlById: (videoId) => ipcRenderer.invoke('get-stream-url-by-id', videoId),
  getAppleMusicToken: () => ipcRenderer.invoke('get-apple-music-token'),
  getLocalPlaylist: () => ipcRenderer.invoke('get-local-playlist'),
  onAudioSeeded: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('audio-seeded', listener);
    return () => ipcRenderer.removeListener('audio-seeded', listener);
  },
  loadPlaylists: () => ipcRenderer.invoke('playlists-load'),
  savePlaylists: (playlists) => ipcRenderer.invoke('playlists-save', playlists),
  getEmbeddedArt: (filename) => ipcRenderer.invoke('get-embedded-art', filename),
  youtubeSearch: (query) => ipcRenderer.invoke('youtube-search', query),
  getLyrics: (track) => ipcRenderer.invoke('get-lyrics', track),
  roomHost: () => ipcRenderer.invoke('room-host'),
  roomStop: () => ipcRenderer.invoke('room-stop'),
  roomBroadcast: (msg) => ipcRenderer.send('room-broadcast', msg),
  roomPeerCount: () => ipcRenderer.invoke('room-peer-count'),
  roomLocalIp: () => ipcRenderer.invoke('room-local-ip'),
  onRoomCommand: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('room-command', listener);
    return () => ipcRenderer.removeListener('room-command', listener);
  },
  getLocalAudioPath: (filename) => ipcRenderer.invoke('get-local-audio-path', filename),
  openMusicFolder: () => ipcRenderer.invoke('open-music-folder'),
  // Drag-drop import — File.path is gone in modern Electron; the path is
  // only obtainable in the preload context via webUtils.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  importAudioFiles: (paths) => ipcRenderer.invoke('import-audio-files', paths),
  // Discord Rich Presence — needs CUPID_DISCORD_CLIENT_ID in the env
  discordAvailable: () => ipcRenderer.invoke('discord-available'),
  setDiscordEnabled: (enabled) => ipcRenderer.send('set-discord-rpc', enabled),
  youtubeFetchPlaylist: (url) => ipcRenderer.invoke('youtube-fetch-playlist', url),
  youtubeOauthStart: (opts) => ipcRenderer.invoke('youtube-oauth-start', opts),
  youtubeOauthCancel: () => ipcRenderer.invoke('youtube-oauth-cancel'),
});
