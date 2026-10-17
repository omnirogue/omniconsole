import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

/**
 * Why: OMP's own `tools.approvalMode` default is `yolo` (verified against the
 * installed 18.2.0 CLI's `--help` and shipped default config), so a launch that
 * supplies no permission flag at all still runs unattended. Every other agent's
 * un-flagged default is some form of prompt-first, so this file exists to give
 * OMP the same "never yolo unless the preset says so" guarantee the rest of the
 * permission catalog (tui-agent-permissions.ts, chat-launch-permissions.ts)
 * already provides for the agents that need an explicit flag to *reach* yolo.
 */

export const OMP_APPROVAL_OVERLAY_FILE_NAME = 'omp-approval-overlay.yaml'

/** Why: `tools.approvalMode: write` is OMP's per-tool-approval-prompt mode
 * (`always-ask | write | yolo` per `omp --help`) — the closest OMP has to the
 * catalog's non-Bypass presets. */
export const OMP_APPROVAL_OVERLAY_YAML = 'tools:\n  approvalMode: write\n'

/** Deterministic — computable identically in main and renderer without Electron's
 * `app.getPath`, so both the writer (main) and the argv builder (main + renderer
 * preview) agree on the same path without threading it through IPC. */
export function getOmpApprovalOverlayConfigPath(homeDirectory?: string): string {
  const preloadHome = (globalThis as { window?: { api?: { app?: { homeDirectory?: string } } } })
    .window?.api?.app?.homeDirectory
  const env = typeof process === 'undefined' ? undefined : process.env
  const nativeHome =
    typeof process !== 'undefined' && process.platform === 'win32'
      ? env?.USERPROFILE ||
        (env?.HOMEDRIVE && env?.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined)
      : env?.HOME
  const home = homeDirectory ?? preloadHome ?? nativeHome
  if (!home) {
    throw new Error('The host home directory is unavailable for OMP approval configuration.')
  }
  const separator = home.includes('\\') ? '\\' : '/'
  return `${home.replace(/[\\/]+$/, '')}${separator}.omniconsole${separator}${OMP_APPROVAL_OVERLAY_FILE_NAME}`
}

const OMP_EXPLICIT_APPROVAL_FLAG_NAMES = new Set([
  '--yolo',
  '--auto-approve',
  '--approval-mode',
  '--config'
])

/**
 * Append `--config <overlay path>` to an OMP launch's argv unless the caller's
 * own args already name an approval-mode-affecting flag (`--yolo`,
 * `--auto-approve`, `--approval-mode`, or an explicit `--config`) — an explicit
 * user override always wins over the managed overlay.
 */
export function applyOmpApprovalOverlayArgs(
  agentArgs: string | null | undefined,
  overlayConfigPath: string,
  shell: AgentStartupShell = 'posix'
): string {
  const trimmed = agentArgs?.trim() ?? ''
  const parsed = tokenizeStartupCommand(trimmed, shell)
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  const hasExplicitApproval = parsed.tokens.some((token) => {
    const name = token.split('=')[0]
    return name !== undefined && OMP_EXPLICIT_APPROVAL_FLAG_NAMES.has(name)
  })
  if (hasExplicitApproval) {
    return trimmed
  }
  const quotedPath = /^[A-Za-z0-9_./:=,-]+$/.test(overlayConfigPath)
    ? overlayConfigPath
    : quoteStartupArg(overlayConfigPath, shell)
  const configFlag = `--config ${quotedPath}`
  return trimmed ? `${trimmed} ${configFlag}` : configFlag
}
