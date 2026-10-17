/**
 * The relocation switch, separate from the steward's: moving a conversation to another computer is
 * available by default but always needs an explicit request, and this turns it off entirely on
 * this computer, as a requester and as a host. `OMNI_RELOCATION_DISABLED=1` in main's environment
 * turns it off whatever the setting says. Off stops new moves; it never undoes a move in progress,
 * because a relinquished source must not run again.
 */

export const SESSION_RELOCATION_DISABLED_ENV = 'OMNI_RELOCATION_DISABLED'

type RelocationSwitchSource = {
  /** The saved setting; anything but an explicit `false` is on. */
  readEnabled: () => unknown
  environment: Readonly<Record<string, string | undefined>>
}

let source: RelocationSwitchSource = { readEnabled: () => undefined, environment: process.env }

/** Called once at startup with the settings store; until then relocation is on. */
export function configureRelocationSwitch(next: Partial<RelocationSwitchSource>): () => void {
  const previous = source
  source = { ...source, ...next }
  return () => {
    source = previous
  }
}

/** Same reading as `OMNI_STEWARD_DISABLED`: set and not `0`/`false`. */
export function relocationDisabledByEnv(
  environment: Readonly<Record<string, string | undefined>> = source.environment
): boolean {
  const raw = environment[SESSION_RELOCATION_DISABLED_ENV]?.trim().toLowerCase()
  return Boolean(raw) && raw !== '0' && raw !== 'false'
}

export function sessionRelocationEnabled(): boolean {
  if (relocationDisabledByEnv()) {
    return false
  }
  try {
    return source.readEnabled() !== false
  } catch {
    return true
  }
}
