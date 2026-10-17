import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const windowsTestWorkerOptions = process.platform === 'win32' ? { maxWorkers: 4 } : {}

export default defineConfig({
  define: {
    ORCA_FEATURE_WALL_ENABLED: 'true'
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    // Why: Node 26's undefined Web Storage globals prevent Vitest from installing happy-dom's.
    // Why --expose-gc: retention tests need a deterministic collection point to measure what a queue really holds.
    execArgv: ['--no-experimental-webstorage', '--expose-gc'],
    // Why: the workflow catalog marks Grok unavailable when this machine's runtime socket is a
    // symlink; tests must not depend on the machine they run on.
    env: { OMNI_GROK_RUNTIME_SOCKET: '/nonexistent/omni-grok-runtime-socket' },
    // Why: happy-dom drops MutationObserver callbacks on GC; keep them alive like a browser does.
    setupFiles: [
      resolve('config/scripts/happy-dom-offscreen-canvas.ts'),
      resolve('config/scripts/happy-dom-mutation-observer-retention.ts'),
      resolve('config/scripts/vitest-host-ports-setup.ts'),
      // Why: the Codex daemon socket guard depends on temp-dir length; keep suites host-independent.
      resolve('config/scripts/vitest-codex-daemon-socket-guard-setup.ts'),
      // Why: a useShallow selector returning a fresh reference re-renders forever (React #185);
      // React only reports it via console.error, so turn that report into a test failure.
      resolve('config/scripts/vitest-fail-on-react-getsnapshot-loop.ts')
    ],
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'config/scripts/**/*.test.ts',
      'config/scripts/**/*.test.mjs',
      'tests/tools/**/*.test.mjs',
      'tests/e2e/**/*.unit.test.ts'
    ],
    // Why: the full suite runs heavy TS transforms plus real git/http fixtures;
    // the Vitest 5s defaults are too tight for the slowest integration cases.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Why one retry in CI only: the Linux lanes moved to self-hosted runners that
    // share one 32-core host, so eight shards plus other lanes compete for CPU and
    // a timing-sensitive test can lose a race it wins alone. A test that fails
    // TWICE is a real failure and still reports red; a single loss under contention
    // is not evidence about the code. Locally retry stays off, so a flake a
    // developer sees is a flake they get told about.
    retry: process.env.CI ? 1 : 0,
    // Why: Windows process and shell startup are slower under full-suite load;
    // macOS/Linux keep Vitest's default worker parallelism.
    ...windowsTestWorkerOptions
  }
})
