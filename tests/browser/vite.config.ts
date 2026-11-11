// Browser test (run.mjs): the normal dev config, but on its own ports, so it can run next to `npm run dev`
import { defineConfig, mergeConfig } from 'vite';
import base from '../../vite.config';

export default defineConfig((env) =>
  mergeConfig(base(env), {
    server: {
      host: '127.0.0.1',
      port: 5199,
      strictPort: true,
      proxy: { '/ws': { target: 'ws://127.0.0.1:3101', ws: true } },
    },
  }),
);
