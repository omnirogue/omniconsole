/**
 * Where a Codex launch really goes, and where Codex's own updater writes.
 *
 * Why: the TUI's "Update now" runs `npm install -g @openai/codex`, which lands
 * in npm's global prefix. When the binary on PATH lives elsewhere (a second
 * Node install, a stale symlink) the update succeeds, Codex restarts on the old
 * copy, and the offer comes back on every launch — the audited laptop case.
 */
export type CodexInstallationDiagnostics = {
  /** What a launch resolves to: an absolute path when found, else the bare name. */
  command: string
  /** Symlinks followed; null when the command is not a file on disk. */
  realPath: string | null
  version: string | null
  npmGlobalPrefix: string | null
  /** The codex the updater would write, when one exists under the npm prefix. */
  npmGlobalCodexPath: string | null
  npmGlobalCodexVersion: string | null
  /** True when the launched binary is not the one `npm install -g` replaces. */
  updateTargetDiverges: boolean
  checkedAt: number
}
