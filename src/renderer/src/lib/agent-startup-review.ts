import {
  detectAgentStartupIntervention,
  agentStartupInterventionAgent,
  type AgentStartupIntervention
} from '../../../shared/agent-startup-intervention'

/** A startup screen can sit for as long as the person needs; only an unexplained
 *  blank composer counts against the readiness budget. This is the absolute cap. */
const INTERVENTION_HOLD_MAX_MS = 30 * 60_000

/**
 * Codex and Claude can render their composer before drawing a startup screen
 * over it (update offer, hooks review, directory trust, sign-in). A live
 * process or an earlier prompt glyph cannot establish that paste will reach the
 * composer. Keep the existing delivery pending while the user handles setup.
 * This never writes input, grants trust, or dismisses a dialog on their behalf.
 */
export async function waitForAgentStartupReview(args: {
  ptyId: string
  agent?: string
  beforeWrite?: () => void
  timeoutMs?: number
  readScreen?: () => Promise<string | null>
  /** Reports the screen currently blocking delivery (null once it clears). */
  onIntervention?: (intervention: AgentStartupIntervention | null) => void
}): Promise<boolean> {
  const agent = agentStartupInterventionAgent(args.agent)
  if (!agent) {
    return true
  }
  if (!args.readScreen && !window.api?.pty?.getMainBufferSnapshot) {
    return true
  }
  const readScreen =
    args.readScreen ??
    (async () => {
      const snapshot = await window.api?.pty?.getMainBufferSnapshot?.(args.ptyId, {
        scrollbackRows: 0
      })
      return snapshot?.data ?? null
    })
  // Let the startup frame finish painting before checking the current viewport.
  await new Promise<void>((resolve) => window.setTimeout(resolve, 250))
  const budgetMs = args.timeoutMs ?? 120_000
  let deadline = Date.now() + budgetMs
  const holdDeadline = Date.now() + INTERVENTION_HOLD_MAX_MS
  let reported: AgentStartupIntervention | null = null
  const report = (next: AgentStartupIntervention | null): void => {
    if ((reported?.kind ?? null) !== (next?.kind ?? null)) {
      reported = next
      args.onIntervention?.(next)
    }
  }
  try {
    while (true) {
      args.beforeWrite?.()
      let screen: string | null
      try {
        screen = await readScreen()
      } catch {
        screen = null
      }
      const intervention = detectAgentStartupIntervention(agent, screen)
      report(intervention)
      if (intervention) {
        // Why: the person is answering a menu; a fixed budget would fail their
        // prompt out from under them. The composer check restarts once it clears.
        deadline = Date.now() + budgetMs
        if (Date.now() >= holdDeadline) {
          return false
        }
      } else if (
        screen !== null &&
        (agent === 'claude' ? screen.trim().length > 0 : screen.includes('›'))
      ) {
        return true
      } else if (Date.now() >= deadline) {
        // A blank/unavailable snapshot cannot prove input readiness. The earlier
        // stream glyph can belong to a composer now covered by setup.
        return false
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250))
    }
  } finally {
    report(null)
  }
}
