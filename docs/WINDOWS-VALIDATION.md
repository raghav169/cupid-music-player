# Windows validation checklist

Run this on a real Windows machine or VM using the `windows-build` CI
artifact (NSIS installer + unpacked build). **Do not skip steps — CI only
proves the artifact builds, not that it runs.**

## Install & launch

- [ ] `Cupid Player-Setup-*.exe` installs without errors
- [ ] App launches from Start Menu / desktop shortcut
- [ ] First launch seeds `%APPDATA%\cupid-player\audio\` recursively,
      including `song photos/` (check the folder exists with files inside)
- [ ] Second launch is clean (no missing-file errors in DevTools console)

## Window modes

- [ ] Compact mode: portrait pixel-art player, correct size (~306:497)
- [ ] Corner resize handles grow/shrink the window keeping aspect
- [ ] Window button (top bar, between minimize and exit) enters full mode
- [ ] Full mode: centered full-height player column, dimmed backdrop,
      library panel left, search + lyrics right
- [ ] Toggling back restores the previous compact size/position
- [ ] Windows fullscreen doesn't leave a stray taskbar/white border
      (transparent frameless windows are quirky on Windows — check corners)
- [ ] Minimize → restore works in both modes

## Local playback

- [ ] Local files play from `%APPDATA%\cupid-player\audio\`
- [ ] Album art loads from `song photos/` subdirectory (regression:
      `\` path separators were rejected before — verify a song with
      subdirectory art shows its cover)
- [ ] A real `.flac` file decodes and plays
- [ ] Track without `art` in playlist.json falls back to embedded tags

## Services

- [ ] Spotify login completes (loopback redirect), playlists load, tracks play
- [ ] Apple Music login completes (MusicKit + .p8 key in userData), plays
- [ ] YouTube: playlist-by-URL works without sign-in; Google sign-in
      completes via loopback redirect; "cancel" button cancels the wait
- [ ] Streams resolve through yt-dlp (`bin/yt-dlp.exe` bundled)

## Features

- [ ] EQ sliders audibly change sound; presets work; gains persist on relaunch
- [ ] Visualizer bars animate while playing, flat-line when paused
- [ ] Sleep timer: fades volume over the last ~30s, pauses, restores volume
- [ ] Library panel: create/rename/delete playlist, add current song,
      play a playlist, mixed local+streaming tracks
- [ ] Search panel: query returns local + Spotify + Apple + YouTube results,
      play a result, add result to a playlist
- [ ] Lyrics: `.lrc` sidecar syncs with highlight; lrclib.net fallback for
      streaming tracks; graceful "no lyrics" state
- [ ] Themes: pink/blue/mint/lavender all render correctly (hue-rotated art)
- [ ] Recents list in library panel populates
- [ ] Keyboard: Tab reaches controls, Enter/Space activate them

## Listen Together

- [ ] "Host a room" shows a `*.trycloudflare.com` address (needs
      `bin/cloudflared.exe`); falls back to `ip:port` if tunnel fails
- [ ] A second machine on a **different network** joins via that address
- [ ] Guest hears the host's track; drift stays under ~0.4s
- [ ] Guest pressing play/pause/next/seek affects the host (and vice versa)
- [ ] Leaving the room stops the tunnel and server cleanly

## Known non-goals

- `.trycloudflare.com` addresses are ephemeral — a new host session = new URL
- Guest needs its own service logins (Spotify/Apple/YouTube credentials
      aren't shared through the room — only playback state is)
- Local-file tracks in a room only work if the guest has the same file
