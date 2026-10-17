import { quoteStartupArg, type AgentStartupShell } from './tui-agent-startup-shell'

/**
 * The bare command names the OmniConsole CLI answers to on PATH: the packaged
 * `omni`, the dev launcher `omni-dev`, and the Linux shim `omni-ide`.
 */
export const OMNICONSOLE_CLI_COMMAND_NAMES = ['omni', 'omni-dev', 'omni-ide'] as const

export type OmniConsoleCliCommandName = (typeof OMNICONSOLE_CLI_COMMAND_NAMES)[number]

type LauncherSource = string | null | (() => string | null)

/**
 * Why a realm-anchored slot: the launcher path is known to the host process (Electron
 * main reads `resourcesPath`; the renderer asks main once at bootstrap) but consumed by
 * the shared launch-command resolver, which has a dozen call sites and no injection
 * point. `Symbol.for` keeps one slot per process however often vitest rebuilds the
 * module registry, matching `app-environment.ts`.
 */
const SLOT = Symbol.for('omni.host.omniConsoleCliLauncher')

type Slot = { [SLOT]?: LauncherSource }

function slot(): Slot {
  return globalThis as unknown as Slot
}

/** Install the launcher (or a lazy resolver) every launch-command build in this process consults. */
export function setLocalOmniConsoleCliLauncher(source: LauncherSource): void {
  slot()[SLOT] = source
}

/** The OmniConsole CLI launcher on this host's disk, or null when none is registered. */
export function getLocalOmniConsoleCliLauncher(): string | null {
  const source = slot()[SLOT]
  try {
    const value = typeof source === 'function' ? source() : source
    const trimmed = typeof value === 'string' ? value.trim() : ''
    return trimmed ? trimmed : null
  } catch {
    return null
  }
}

export function isOmniConsoleCliCommandName(token: string): token is OmniConsoleCliCommandName {
  return (OMNICONSOLE_CLI_COMMAND_NAMES as readonly string[]).includes(token)
}

type LeadingToken = { unquoted: string; rest: string }

/** The first shell word of a command line, bare or quoted, and everything after it. */
function splitLeadingToken(command: string): LeadingToken | null {
  const trimmed = command.trimStart()
  if (!trimmed) {
    return null
  }
  const quote = trimmed[0]
  if (quote === "'" || quote === '"') {
    const end = trimmed.indexOf(quote, 1)
    if (end === -1) {
      return null
    }
    return { unquoted: trimmed.slice(1, end), rest: trimmed.slice(end + 1) }
  }
  const match = /^\S+/.exec(trimmed)
  if (!match) {
    return null
  }
  return { unquoted: match[0], rest: trimmed.slice(match[0].length) }
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\')
}

function basenameOf(value: string): string {
  return value.split(/[\\/]/).pop() ?? value
}

/**
 * Point a local POSIX launch at the OmniConsole CLI on disk instead of whichever
 * `omni` the login shell finds first.
 *
 * Why: the shell's rc files rebuild PATH, and a Mac that also carries another `omni`
 * (a Python CLI behind a pyenv shim) handed `omni claude-teams` to that program. The
 * Agent Teams pane sat at a bare prompt while the chat composer typed `/model` and the
 * person's prompt into zsh. Worker preambles already name the launcher by absolute
 * path (`cli-command.ts`); the agent launch must do the same. Remote hosts keep the
 * bare name because their relay shim is registered as plain `omni`, and an explicit
 * command override is never rewritten (callers apply this to the default only).
 */
export function applyLocalOmniConsoleCliLauncher(
  command: string,
  args: {
    platform: NodeJS.Platform
    shell: AgentStartupShell
    isRemote?: boolean
    /** Explicit launcher for tests; omitted reads the registered one. */
    launcher?: string | null
  }
): string {
  if (args.isRemote || args.platform === 'win32' || args.shell !== 'posix') {
    return command
  }
  const leading = splitLeadingToken(command)
  if (
    !leading ||
    hasPathSeparator(leading.unquoted) ||
    !isOmniConsoleCliCommandName(leading.unquoted)
  ) {
    return command
  }
  const launcher =
    args.launcher === undefined ? getLocalOmniConsoleCliLauncher() : args.launcher?.trim() || null
  if (!launcher) {
    return command
  }
  return `${quoteStartupArg(launcher, 'posix')}${leading.rest}`
}

/**
 * Fold an absolute OmniConsole launcher back to its bare name so a captured launch
 * command still matches the agent's configured default (sleeping records, restores).
 */
export function normalizeOmniConsoleCliLauncherForMatch(command: string): string {
  const leading = splitLeadingToken(command)
  if (!leading || !hasPathSeparator(leading.unquoted)) {
    return command
  }
  const name = basenameOf(leading.unquoted)
  if (!isOmniConsoleCliCommandName(name)) {
    return command
  }
  return `${name}${leading.rest}`
}
