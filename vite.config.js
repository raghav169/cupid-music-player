import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// CSP for packaged builds only — dev needs inline scripts + ws for HMR.
// The cupid-local/cupid-audio schemes are registered with bypassCSP so media
// still flows; remote art and service APIs go through https.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://js-cdn.music.apple.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: cupid-local:", // album art via custom scheme
  "media-src 'self' cupid-local: cupid-audio:",
  "connect-src 'self' https: wss: ws:", // ws: for Listen Together LAN rooms
  "font-src 'self' data:",
  "frame-src https://*.apple.com https://*.music.apple.com",
].join('; ');

const injectCsp = {
  name: 'inject-csp',
  transformIndexHtml: {
    order: 'post',
    handler(html, ctx) {
      if (ctx.server) return html; // dev server — skip
      return html.replace(
        '<meta name="viewport"',
        `<meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <meta name="viewport"`,
      );
    },
  },
};

export default defineConfig({
  plugins: [react(), injectCsp],
  base: './',
  publicDir: 'audio',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
