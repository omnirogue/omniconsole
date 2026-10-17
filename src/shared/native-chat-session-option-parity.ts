import {
  evaluateSessionEffortParity,
  isSessionEffortParityDivergent,
  type SessionEffortParity
} from './session-effort-parity'
import {
  requestedTrackedValue,
  type TrackedNativeChatSessionOption
} from './native-chat-session-option-state'
import { CLAUDE_ULTRACODE_BASE_EFFORT, CLAUDE_ULTRACODE_EFFORT } from './claude-ultracode-effort'

/**
 * Requested vs applied for one picker row. Only the model and effort rows carry a
 * parity record: those are the two values forwarded at launch and re-applied
 * mid-session, and the only ones a provider reports back.
 *
 * A record is attached only when the two diverge, so a matching row stays a single
 * value and a snapshot of matching rows keeps its previous shape.
 */
export function trackedSessionOptionParity(args: {
  optionId: string
  tracked: TrackedNativeChatSessionOption | undefined
  /** The values this model advertises; null/empty means unknown, never unsupported. */
  supportedValues?: readonly string[] | null
  /** Where the report came from: a structured session's own readback, or a screen scrape. */
  transport?: 'catalog' | 'agent-session'
}): SessionEffortParity | undefined {
  if (args.optionId !== 'model' && args.optionId !== 'effort') {
    return undefined
  }
  const requested = requestedTrackedValue(args.tracked)
  if (typeof requested !== 'string') {
    return undefined
  }
  const reported =
    args.tracked?.source === 'reported' && typeof args.tracked.value === 'string'
      ? args.tracked.value
      : undefined
  // Why: ultracode is xhigh plus a flag, and a screen-scraped report of its ladder level
  // says nothing about the flag — Claude Code's startup frame prints `xhigh` under
  // ultracode. That report is no observation of the request, not a divergence from it.
  // A structured session's readback CAN see the flag and reports `ultracode` itself
  // (readClaudeSettingsEffort), so its `xhigh` is a real divergence and stays one.
  const applied =
    args.optionId === 'effort' &&
    args.transport !== 'agent-session' &&
    requested === CLAUDE_ULTRACODE_EFFORT &&
    reported === CLAUDE_ULTRACODE_BASE_EFFORT
      ? undefined
      : reported
  const key = args.optionId === 'model' ? 'model' : 'effort'
  const parity = evaluateSessionEffortParity({
    requested: { [key]: requested },
    ...(applied ? { applied: { [key]: applied } } : {}),
    ...(key === 'effort' ? { supportedEfforts: args.supportedValues ?? null } : {})
  })
  return isSessionEffortParityDivergent(parity) ? parity : undefined
}
