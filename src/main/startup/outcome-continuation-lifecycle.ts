/**
 * Marks a replacement started only to finish outstanding outcomes. The child carries it so a person
 * reading `ps` can tell why a window-less OmniConsole is alive, and so the child can announce itself.
 */
export const OUTCOME_CONTINUATION_SWITCH = '--outcome-continuation'

/** Reuse the existing serve owner after a desktop quit, without creating a quit loop. */
export class OutcomeContinuationLifecycle {
  private desktopOpened = false
  private systemEnding = false

  noteDesktopOpened(): void {
    this.desktopOpened = true
  }

  noteSystemEnding(): void {
    this.systemEnding = true
  }

  shouldRelaunch(options: {
    pending: boolean
    ownsProfile: boolean
    updateInstalling: boolean
    replacementScheduled: boolean
    devParentEnding: boolean
  }): boolean {
    return (
      this.desktopOpened &&
      !this.systemEnding &&
      options.pending &&
      options.ownsProfile &&
      !options.updateInstalling &&
      !options.replacementScheduled &&
      !options.devParentEnding
    )
  }
}

// Why process-shaping switches only: the replacement is a background process the user cannot see, so
// nothing carrying session state (a stale profile, a one-use deep link, a debugging port) may ride in.
const SAFE_SWITCHES = new Set([
  '--no-sandbox',
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--disable-gpu-sandbox',
  '--disable-dev-shm-usage',
  '--in-process-gpu',
  '--use-mock-keychain',
  '--password-store=basic'
])

// Why: the relaunch writes these itself, so losing the originals is the point. Reporting them would
// fire the dropped-switch warning on every serve-owner quit, and a warning that always fires is unread.
const SUPERSEDED_SWITCHES = new Set([
  '--user-data-dir',
  '--serve',
  '--serve-json',
  '--serve-mobile-pairing',
  '--serve-no-pairing',
  '--serve-pairing-address',
  '--serve-port',
  '--serve-project-root',
  '--serve-recipe-json',
  OUTCOME_CONTINUATION_SWITCH
])

export type OutcomeContinuationRelaunch = {
  /** argv for the replacement process. */
  args: string[]
  /** Switch names the allowlist refused that the relaunch does not itself rewrite. */
  droppedSwitches: string[]
}

/**
 * Names only, never values: a dropped token's value can be a one-use auth code or a profile path, and
 * this list is logged and stored in a crash breadcrumb. Non-flag tokens (entry paths, deep links,
 * consumed values) are omitted for the same reason — the relaunch always resolves those itself.
 */
function droppedSwitchNames(argv: readonly string[]): string[] {
  const dropped = new Set<string>()
  for (const token of argv.slice(1)) {
    if (!token.startsWith('-') || SAFE_SWITCHES.has(token)) {
      continue
    }
    const name = token.split('=')[0]!
    if (!SUPERSEDED_SWITCHES.has(name)) {
      dropped.add(name)
    }
  }
  return [...dropped]
}

/** Resolve entry/profile from Electron; launchers may put switches before the app path. */
export function outcomeContinuationRelaunchPlan(
  argv: readonly string[],
  isPackaged: boolean,
  paths: { appPath: string; userDataPath: string; pairedListenerPort?: number }
): OutcomeContinuationRelaunch {
  const args = argv.slice(1).filter((argument) => SAFE_SWITCHES.has(argument))
  const port = paths.pairedListenerPort
  const reconnectPort =
    port !== undefined && Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 0
  if (!isPackaged) {
    args.push(paths.appPath)
  }
  return {
    args: [
      ...args,
      '--user-data-dir',
      paths.userDataPath,
      '--serve',
      '--serve-no-pairing',
      '--serve-port',
      String(reconnectPort),
      OUTCOME_CONTINUATION_SWITCH
    ],
    droppedSwitches: droppedSwitchNames(argv)
  }
}
