import type {
  AgentSessionOptionCatalog,
  CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import type {
  SessionOptionDescriptor,
  SessionOptionSetResult,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import {
  flattenNativeChatSessionOptionRecord,
  type NativeChatSessionOptionRecord
} from '../../../../shared/native-chat-session-option-state'
import type {
  NativeChatSessionOptionDispatchCommand,
  NativeChatSessionOptionRelaunch
} from './native-chat-session-option-command-dispatch'
import type { NativeChatSessionOptionMode } from './native-chat-session-option-snapshot'

export type SessionOptionApplyContext = {
  mode: NativeChatSessionOptionMode
  catalog: AgentSessionOptionCatalog
  getModels: () => CatalogModel[]
  getRecord: () => NativeChatSessionOptionRecord
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  /** Restart-on-thread apply for catalog kinds with no live setter (Codex). */
  relaunchSessionOptions?: NativeChatSessionOptionRelaunch
  onAgentPicker?: () => void
  /** The one persist entry point, shared with typed commands: it owns both the
   *  null-model guard and whether the id may be adopted as the launch default. */
  persist: (modelId: string | null, optionId: string, value: SessionOptionValue) => void
  onDraftValuesChanged?: (values: Record<string, SessionOptionValue>) => void
  publish: () => SessionOptionDescriptor[]
  clearModelTruth: () => void
  setTrackedValue: (
    optionId: string,
    value: SessionOptionValue,
    source: 'applied' | 'dispatched' | 'reported'
  ) => string | null
}

/** Why: the mid-dispatch guards watch for *record* changes. Resolving through the model
 *  list would also trip when discovery lands mid-dispatch and moves which row carries
 *  `isDefault` — nothing the agent saw changed, but the value would be discarded. */
export function trackedModelId(record: NativeChatSessionOptionRecord): string | null {
  return typeof record.model?.value === 'string' ? record.model.value : null
}

export function finishSessionOptionApply(
  ctx: SessionOptionApplyContext,
  args?: {
    modelId: string | null
    optionId: string
    value: SessionOptionValue
    skipPersist?: boolean
  }
): SessionOptionSetResult {
  if (args && !args.skipPersist) {
    ctx.persist(args.modelId, args.optionId, args.value)
  }
  const snapshot = ctx.publish()
  const record = ctx.getRecord()
  const draftModelId = trackedModelId(record)
  if (ctx.mode === 'draft' && draftModelId !== null) {
    ctx.onDraftValuesChanged?.(flattenNativeChatSessionOptionRecord(record, draftModelId))
  }
  return { snapshot }
}
