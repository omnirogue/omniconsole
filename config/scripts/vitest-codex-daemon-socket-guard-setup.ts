import { vi } from 'vitest'
import type * as CodexDaemonSocketGuard from '../../src/main/codex/codex-daemon-socket-guard'

/**
 * Why: the guard fires on the real temp-dir length, which differs across dev Macs
 * and CI runners, so suites asserting exact managed config.toml bytes would pass or
 * fail by host. Keep it inert by default; its own suite calls `vi.unmock`.
 */
vi.mock('../../src/main/codex/codex-daemon-socket-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexDaemonSocketGuard>()),
  disableCodexDaemonAutoStartForSocketPath: (config: string) => config,
  ensureCodexDaemonAutoStartFitsSocketPath: () => {}
}))
