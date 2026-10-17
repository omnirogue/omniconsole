export type AutomationLaunchOutcome = 'unverifiable'

export type AutomationRunLaunchFields = { launchOutcome?: AutomationLaunchOutcome | null }
export type AutomationDispatchLaunchFields = { launchOutcome?: AutomationLaunchOutcome | null }

export type AutomationLaunchTerminalBinding = {
  workspaceId: string
  workspaceDisplayName?: string | null
  terminalSessionId: string | null
  terminalPaneKey?: string | null
  terminalPtyId?: string | null
  ownsTerminal?: boolean
}

/** A rejected launch whose process may still be executing on its owner. */
export class AutomationLaunchUnverifiableError extends Error {
  constructor(
    cause: unknown,
    readonly terminal?: AutomationLaunchTerminalBinding
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}
