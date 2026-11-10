import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts: the tests need none of the dev server's plugins and proxy
export default defineConfig({
  test: {
    // Spelled out, so test files in other checkouts (.claude/worktrees/) are never picked up
    include: ['server/**/*.test.ts', 'src/**/*.test.ts'],
    // Above START_TIMEOUT_MS in server/testServer.ts: a server that starts too slowly has to fail with startServer's
    // own error, which kills it and shows its output. Vitest's default (10 s) would come first and leave it running.
    hookTimeout: 20000,
  },
});
