import type { Store } from '../persistence'
import type { PublishAutomationsChanged } from '../../shared/runtime-client-events'
import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'
import { clearAutomationDispatchTokens } from './dispatch-tokens'
import { readCodexRolloutTail } from './codex-rollout-turn-result'
import { reconcileCompletedAutomationRun } from './completed-run-reconciliation'
import {
  withoutClaimedAssistantProvenance,
  type ResolveAutomationFinalOutput
} from './automation-output-provenance'

export type AutomationRunWriter = {
  createRun: Store['createAutomationRun']
  updateRun: (result: AutomationDispatchResult, proofIsCurrent?: () => boolean) => AutomationRun
  /** Null when nothing could be folded — the caller then writes an ordinary run. */
  repeatSkip: Store['recordRepeatedAutomationSkip']
}

/** Wraps run persistence so every committed write announces itself. Clients with
 *  the Automations page closed — or none attached at all — have no other way to
 *  learn that a run progressed, so the event must follow the write, not a render. */
export function createAutomationRunWriter(
  store: Store,
  publish: PublishAutomationsChanged | null,
  /** Test seam for the Codex rollout a completed run is reconciled against. */
  readRollout: (path: string) => string | null = readCodexRolloutTail,
  resolveFinalOutput?: ResolveAutomationFinalOutput,
  captureTerminalProcessIncarnation?: (run: AutomationRun) => string | null
): AutomationRunWriter {
  // A run write never moves the record, so its own host is the whole publication.
  // A record that can no longer be named degrades to the authority-wide event.
  const announce = (automationId: string, reason: 'run' | 'usage'): void => {
    if (!publish) {
      return
    }
    const selector = store.automationChangeSelector(automationId)
    publish({ reason, ...(selector ? { selector } : {}) })
  }
  return {
    createRun: (automation, scheduledFor, trigger, options): AutomationRun => {
      const run = store.createAutomationRun(automation, scheduledFor, trigger, options)
      announce(automation.id, 'run')
      return run
    },
    updateRun: (result, proofIsCurrent): AutomationRun => {
      const current =
        result.status === 'completed' ||
        (result.status === 'dispatched' && captureTerminalProcessIncarnation)
          ? (store.listAutomationRuns().find((entry) => entry.id === result.runId) ?? null)
          : null
      const needsNativeProof = Boolean(
        current &&
        store
          .listAutomations()
          .some((row) => row.id === current.automationId && row.structuredOutput)
      )
      // Why here: renderer, watcher and headless completions all land on this one write,
      // so this is where a "completed" claim is checked against the agent's transcript.
      let reconciled = reconcileCompletedAutomationRun(
        withoutClaimedAssistantProvenance(result),
        () => current,
        // Opted-in decisions never read a renderer-supplied/stored transcript locator as proof.
        needsNativeProof ? () => null : readRollout
      )
      if (
        current?.outputSnapshot?.provenance === 'assistant_message' &&
        current.status === 'completed' &&
        (needsNativeProof || !Object.hasOwn(result, 'outputSnapshot'))
      ) {
        // A duplicate completion or late renderer capture cannot replace proven native output.
        reconciled = { ...reconciled, outputSnapshot: current.outputSnapshot }
      } else if (
        needsNativeProof &&
        resolveFinalOutput &&
        current &&
        reconciled.status === 'completed' &&
        // Usage collection is a follow-up write, never a new final-output proof admission.
        (!Object.hasOwn(result, 'usage') || Object.hasOwn(result, 'outputSnapshot')) &&
        (!proofIsCurrent || proofIsCurrent())
      ) {
        try {
          const finalOutput = resolveFinalOutput(current, reconciled)
          if (finalOutput && (!proofIsCurrent || proofIsCurrent())) {
            reconciled = { ...reconciled, outputSnapshot: finalOutput }
          }
        } catch {
          // Missing native evidence leaves the ordinary result intact and structured output unproven.
        }
      }
      const incarnation =
        current?.dispatchedAt === null && reconciled.status === 'dispatched'
          ? captureTerminalProcessIncarnation?.({
              ...current,
              terminalPaneKey: Object.hasOwn(reconciled, 'terminalPaneKey')
                ? (reconciled.terminalPaneKey ?? null)
                : current.terminalPaneKey,
              terminalPtyId: Object.hasOwn(reconciled, 'terminalPtyId')
                ? (reconciled.terminalPtyId ?? null)
                : current.terminalPtyId
            })
          : null
      const run = incarnation
        ? store.updateAutomationRun(reconciled, incarnation)
        : store.updateAutomationRun(reconciled)
      if (run.status !== 'dispatching') {
        clearAutomationDispatchTokens(run.automationId, run.id)
      }
      announce(run.automationId, result.usage ? 'usage' : 'run')
      return run
    },
    repeatSkip: (automationId, error, scheduledFor): AutomationRun | null => {
      const run = store.recordRepeatedAutomationSkip(automationId, error, scheduledFor)
      if (run) {
        announce(automationId, 'run')
      }
      return run
    }
  }
}
