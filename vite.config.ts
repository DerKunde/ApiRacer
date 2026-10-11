import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig(({ mode }) => ({
  // `npm run dev:https` → self-signed certificate (required for the orientation sensor on iOS)
  plugins: mode === 'https' ? [basicSsl()] : [],
  server: {
    // Listen on the LAN so the phone can open the page
    host: true,
    // Signaling over the same host/port as the page → the phone only needs one address
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:3001', ws: true },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: page('./index.html'),
        host: page('./host.html'),
        controller: page('./controller.html'),
        sensors: page('./sensors.html'),
      },
    },
  },
}));
