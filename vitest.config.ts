import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts: the tests need none of the dev server's plugins and proxy
export default defineConfig({
  test: {
    // Spelled out, so test files in other checkouts (.claude/worktrees/) are never picked up
    include: ['server/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
