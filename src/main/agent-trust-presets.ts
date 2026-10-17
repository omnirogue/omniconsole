import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { writeFileAtomically } from './codex-accounts/fs-utils'
import { getOrcaManagedCodexHomePath } from './codex/codex-home-paths'
import { upsertProjectTrustLevel } from './codex/config-toml-trust'
import { runExclusivelyForCodexTrustConfig } from './codex/codex-trust-config-mutation-queue'

export type AgentTrustPreset = 'cursor' | 'copilot' | 'codex' | 'claude'

/**
 * Pre-mark a workspace as trusted for cursor-agent, GitHub Copilot CLI, or
 * Codex so the agent's "Do you trust this folder?" menu does not fire on
 * first launch.
 *
 * Why: OmniConsole's "drop URL into agent input as a draft" flow injects the URL
 * via bracketed-paste once the TUI is up. If the trust menu intercepts the
 * keystrokes (each menu reads a single character or numbered option), the
 * paste either selects an arbitrary option or quits the session. Pre-writing
 * the same trust artifacts that the agent writes after the user accepts is
 * the only documented bypass — both CLIs read these files at startup before
 * showing the menu.
 *
 * Side note: a `--trust`-style CLI flag exists in cursor-agent but only
 * applies in `--print/headless` mode (per its --help). Copilot has no
 * documented flag at all (verified against @github/copilot 1.0.32 bundle).
 * Codex's `--dangerously-bypass-approvals-and-sandbox` would also change
 * approval/sandbox policy, so it is not equivalent to "trust this project".
 */

/**
 * Cursor's CLI keeps a per-workspace trust marker at:
 *   ~/.cursor/projects/<slug>/.workspace-trusted
 * where <slug> is the absolute path with the leading `/` stripped and
 * remaining `/` replaced with `-`. The file payload is `{ trustedAt,
 * workspacePath }`. Verified against the cursor-agent CLI bundle
 * (versions/2026.04.17-787b533/index.ts: `_=".workspace-trusted"`, slug
 * derived via the same util that resolves `~/.cursor/projects/<slug>`).
 */
export function markCursorWorkspaceTrusted(workspacePath: string): void {
  const absPath = canonicalize(workspacePath)
  const slug = cursorWorkspaceSlug(absPath)
  if (!slug) {
    return
  }
  const trustDir = join(homedir(), '.cursor', 'projects', slug)
  const trustFile = join(trustDir, '.workspace-trusted')
  if (existsSync(trustFile)) {
    return
  }
  mkdirSync(trustDir, { recursive: true })
  const payload = JSON.stringify(
    { trustedAt: new Date().toISOString(), workspacePath: absPath },
    null,
    2
  )
  writeFileAtomically(trustFile, `${payload}\n`)
}

/**
 * GitHub Copilot CLI keeps a global list of trusted folders in
 * ~/.copilot/config.json under `trustedFolders` (verified against the
 * @github/copilot 1.0.32 bundle: `addTrustedFolder` and `isFolderTrusted`
 * both read/write this exact key, and folder comparison is done after a
 * realpath() resolution).
 *
 * We append to the array in-place so unrelated config keys (loggedInUsers,
 * copilotTokens, etc.) survive untouched.
 */
export function markCopilotFolderTrusted(workspacePath: string): void {
  const absPath = canonicalize(workspacePath)
  const configDir = join(homedir(), '.copilot')
  const configPath = join(configDir, 'config.json')
  let config: Record<string, unknown> = {}
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        config = parsed as Record<string, unknown>
      }
    }
  } catch {
    // Why: a corrupted config.json is the user's to fix — refuse to overwrite
    // it from this side-effect path. Copilot will rewrite the file itself
    // after the user accepts the trust prompt manually.
    return
  }
  const existing = Array.isArray(config.trustedFolders) ? (config.trustedFolders as unknown[]) : []
  const normalizedExisting = existing.map((entry) =>
    typeof entry === 'string' ? canonicalize(entry) : null
  )
  if (normalizedExisting.includes(absPath)) {
    return
  }
  const next = [...existing.filter((e) => typeof e === 'string'), absPath]
  config.trustedFolders = next
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }
  writeFileAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

/**
 * Codex stores project trust in ~/.codex/config.toml under:
 *   [projects."<realpath>"]
 *   trust_level = "trusted"
 *
 * Verified against codex-rs/tui/src/onboarding/trust_directory.rs and
 * codex-rs/core/src/config/config_tests.rs in the Codex CLI source.
 */
export function markCodexProjectTrusted(
  workspacePath: string,
  codexHomePath?: string
): Promise<void> {
  const absPath = resolveCodexProjectTrustRoot(workspacePath)
  const systemTomlPath = join(homedir(), '.codex', 'config.toml')
  // Why: OmniConsole-launched Codex runs with an OmniConsole-owned CODEX_HOME, so the trust
  // preset must also update the runtime config Codex will actually read.
  const runtimeTomlPath = join(
    codexHomePath ? resolve(codexHomePath) : getOrcaManagedCodexHomePath(),
    'config.toml'
  )
  // Why (#16441): hook installs now await a codex app-server grant, so an
  // unqueued write here can land inside their capture->restore window and be
  // reverted. Same runtime-before-system lock order the installer takes.
  return runExclusivelyForCodexTrustConfig(runtimeTomlPath, () =>
    runExclusivelyForCodexTrustConfig(systemTomlPath, async () => {
      upsertProjectTrustLevel(systemTomlPath, absPath, 'trusted')
      upsertProjectTrustLevel(runtimeTomlPath, absPath, 'trusted')
    })
  )
}

/**
 * Claude Code keeps per-project trust in `.claude.json` (next to its config directory:
 * `~/.claude.json` by default, `<CLAUDE_CONFIG_DIR>/.claude.json` for an account profile)
 * under `projects[<path>].hasTrustDialogAccepted`. Verified live on 2.1.267: a worker started
 * in a fresh child worktree without the entry shows the trust menu, and the pasted
 * instruction selects its exit option. Other keys of the file and of the project entry survive.
 */
export function markClaudeProjectTrusted(workspacePath: string, configDir?: string): void {
  const absPath = canonicalize(workspacePath)
  const configPath = join(configDir ? resolve(configDir) : homedir(), '.claude.json')
  let config: Record<string, unknown> = {}
  try {
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
      if (parsed && typeof parsed === 'object') {
        config = parsed as Record<string, unknown>
      }
    }
  } catch {
    // Why: a corrupted .claude.json is the person's to fix; never overwrite it from here.
    return
  }
  const projects =
    config.projects && typeof config.projects === 'object'
      ? { ...(config.projects as Record<string, unknown>) }
      : {}
  const existing =
    projects[absPath] && typeof projects[absPath] === 'object'
      ? (projects[absPath] as Record<string, unknown>)
      : {}
  if (existing.hasTrustDialogAccepted === true) {
    return
  }
  projects[absPath] = {
    ...existing,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true
  }
  const dir = dirname(configPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileAtomically(configPath, `${JSON.stringify({ ...config, projects }, null, 2)}\n`)
}

function claudeProjectTrusted(configDir: string | undefined, absPath: string): boolean {
  try {
    const path = join(configDir ? resolve(configDir) : homedir(), '.claude.json')
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: unknown } | null>
    } | null
    return parsed?.projects?.[absPath]?.hasTrustDialogAccepted === true
  } catch {
    return false
  }
}

/**
 * Carry a folder trust the launch already recorded into the Claude config directory the spawn
 * settled on. Why: launches pre-trust before the spawn picks the account, so a balanced managed
 * account, or a CLAUDE_CONFIG_DIR inherited from the shell that started OmniConsole, reads a
 * `.claude.json` the trust never reached, and Claude asks "Is this a project you trust?". Only a
 * decision already recorded (in the requested directory or the default files) is carried, and
 * only into a `.claude.json` that already exists.
 */
export function carryClaudeProjectTrust(
  workspacePath: string | undefined,
  configDir: string | undefined,
  requestedConfigDir?: string
): void {
  if (!workspacePath || !configDir) {
    return
  }
  const absPath = canonicalize(workspacePath)
  if (
    !existsSync(join(resolve(configDir), '.claude.json')) ||
    claudeProjectTrusted(configDir, absPath)
  ) {
    return
  }
  const sources = [requestedConfigDir?.trim() || undefined, undefined, join(homedir(), '.claude')]
  if (sources.some((dir) => claudeProjectTrusted(dir, absPath))) {
    markClaudeProjectTrusted(workspacePath, configDir)
  }
}

function resolveCodexProjectTrustRoot(workspacePath: string): string {
  const absPath = canonicalize(workspacePath)
  try {
    const gitDirReference = readFileSync(join(absPath, '.git'), 'utf-8').trim()
    if (!gitDirReference.startsWith('gitdir:')) {
      return absPath
    }
    const gitDirPath = gitDirReference.slice('gitdir:'.length).trim()
    if (!gitDirPath) {
      return absPath
    }
    const gitDir = resolve(absPath, gitDirPath)
    const worktreesDir = dirname(gitDir)
    if (basename(worktreesDir) !== 'worktrees') {
      return absPath
    }
    // Why: workspace-controlled .git metadata must not broaden trust without Git's reciprocal link.
    const gitDirBacklink = readFileSync(join(gitDir, 'gitdir'), 'utf-8').trim()
    if (!gitDirBacklink) {
      return absPath
    }
    const resolvedBacklink = resolve(gitDir, gitDirBacklink)
    const workspaceGitFile = join(absPath, '.git')
    if (
      resolvedBacklink !== workspaceGitFile &&
      canonicalize(resolvedBacklink) !== canonicalize(workspaceGitFile)
    ) {
      return absPath
    }
    // Why: mirror Codex's validated .git/worktrees/<name> traversal instead of trusting arbitrary commondir contents.
    return canonicalize(dirname(dirname(worktreesDir)))
  } catch {
    return absPath
  }
}

function canonicalize(p: string): string {
  // Why: macOS reports `/tmp/x` and `/private/tmp/x` as the same inode, but
  // both Cursor and Copilot's trust comparators run realpath() before the
  // string compare. Mirror that so a worktree under a symlinked parent
  // (omni caches realpath()'d worktree paths) matches the agent's lookup.
  try {
    if (existsSync(p)) {
      return realpathSync.native(p)
    }
  } catch {
    // Fall through to the raw input.
  }
  return p
}

function cursorWorkspaceSlug(absPath: string): string {
  const stripped = absPath.replace(/^[\\/]+/, '')
  // Why: Windows absolute paths include characters such as ":" that cannot
  // be used in the ~/.cursor/projects/<slug> directory name.
  const slug = stripped.replace(/[\\/:*?"<>|]+/g, '-')
  return slug
}
