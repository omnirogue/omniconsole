import type {
  CatalogAgentInteractionDetection,
  CatalogCommandDelivery
} from '../../../../shared/agent-session-option-catalog'
import type { NativeChatModelSwitchOutcome } from './native-chat-model-switch-confirmation'
import type { CodexResumeRelaunchSelectedOption } from './codex-resume-relaunch-state'

export type NativeChatSessionOptionDispatchResult = {
  outcome?: NativeChatModelSwitchOutcome
}

export type NativeChatSessionOptionDispatchCommand = (
  command: string,
  options?: {
    detectAgentInteraction?: CatalogAgentInteractionDetection
    expectedChoiceLabel?: string
    expectedChoiceId?: string
    delivery?: CatalogCommandDelivery
  }
) =>
  | Promise<NativeChatSessionOptionDispatchResult | void>
  | NativeChatSessionOptionDispatchResult
  | void

/** Restart the agent on its current provider thread with `requested` as launch
 *  flags. `onCommitted` runs synchronously only once the relaunch is certain to
 *  be queued; a refusal rejects before it, leaving tracked truth untouched. */
export type NativeChatSessionOptionRelaunch = (args: {
  requested: { model: string; effort?: string }
  /** The option the person picked; only it is persisted once the relaunch confirms. */
  selectedOption: CodexResumeRelaunchSelectedOption
  onCommitted: () => void
}) => Promise<void>
