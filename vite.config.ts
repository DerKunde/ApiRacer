import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';
import { trackFilesPlugin } from './trackFilesPlugin';

const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig(({ mode }) => ({
  // `npm run dev:https` → self-signed certificate (required for the orientation sensor on iOS)
  plugins: [trackFilesPlugin(), ...(mode === 'https' ? [basicSsl()] : [])],
  server: {
    // Listen on the LAN so the phone can open the page
    host: true,
    // Saving a layout must not reload the page: the room and the test players would be lost
    watch: { ignored: ['**/src/client/race/tracks/**'] },
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
        host3dPhoneOrientation: page('./host3dPhoneOrientation.html'),
        phone3dClient: page('./phone3dClient.html'),
      },
    },
  },
}));
