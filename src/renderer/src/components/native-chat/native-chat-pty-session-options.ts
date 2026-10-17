import {
  getAgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  ReportedSessionOptionValues,
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import { recordNativeChatSessionOptionCommand } from '../../../../shared/native-chat-session-option-commands'
import {
  acceptReportedSessionOption,
  applyNativeChatReportedSessionOptions,
  clearNativeChatSessionModel,
  createNativeChatSessionOptionRecord,
  setTrackedSessionOption
} from '../../../../shared/native-chat-session-option-state'
import {
  readNativeChatSessionOptionCache,
  writeNativeChatSessionOptionCache
} from './native-chat-session-option-cache'
import type { CodexResumeRelaunchSelectedOption } from './codex-resume-relaunch-state'
import { createSessionOptionAppliers } from './native-chat-session-option-apply'
import {
  buildNativeChatSessionOptionSnapshot,
  resolveEffectiveNativeChatModelId,
  withTrackedNativeChatModel,
  type NativeChatSessionOptionMode
} from './native-chat-session-option-snapshot'
import type {
  NativeChatSessionOptionDispatchCommand,
  NativeChatSessionOptionRelaunch
} from './native-chat-session-option-command-dispatch'

type PersistSelection = (args: {
  modelId: string
  optionId: string
  value: SessionOptionValue
  /** False leaves the model scoping this value only, never a persisted launch flag. */
  adoptModelAsLaunchDefault: boolean
}) => Promise<void> | void

export type NativeChatPtySessionOptionsSurface = SessionOptionsSurface & {
  recordOutgoingCommand(command: string): void
  reportSessionOptions(values: ReportedSessionOptionValues): void
  replaceModels(models: CatalogModel[]): void
  /** A relaunch verified against the agent's own header: `observed` becomes the
   *  displayed truth; the model is persisted, the effort only for an effort pick. */
  confirmRelaunchedSessionOptions(args: {
    observed: { model: string; effort?: string }
    requested: { model: string; effort?: string }
    selectedOption: CodexResumeRelaunchSelectedOption
  }): void
  /** Forget every `dispatched` value — a relaunch that never came back. */
  dropDispatchedSessionOptions(): void
}

export type CreateNativeChatPtySessionOptionsArgs = {
  agent: AgentType
  scopeKey: string
  fallbackScopeKey?: string
  initialModels?: readonly CatalogModel[]
  mode: NativeChatSessionOptionMode
  reportedValues?: ReportedSessionOptionValues | null
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  relaunchSessionOptions?: NativeChatSessionOptionRelaunch
  onAgentPicker?: () => void
  persistSelection?: PersistSelection
  onDraftValuesChanged?: (values: Record<string, SessionOptionValue>) => void
}

export function createNativeChatPtySessionOptions(
  args: CreateNativeChatPtySessionOptionsArgs
): NativeChatPtySessionOptionsSurface | null {
  const catalog = getAgentSessionOptionCatalog(args.agent)
  // Why: OpenCode's catalog seeds no models and lists none; a picker there would be empty.
  if (!catalog || (!catalog.models.length && !catalog.listModels && !args.initialModels?.length)) {
    return null
  }
  let models = [...(args.initialModels ?? catalog.models)]
  // The enrichment cache only ever holds probe output, so being handed a list at all
  // means `isDefault` below names the account's real default rather than the seed guess.
  let modelsAreDiscovered = args.initialModels !== undefined
  let record =
    readNativeChatSessionOptionCache(args.scopeKey, args.fallbackScopeKey) ??
    createNativeChatSessionOptionRecord(args.agent)
  if (record.agent !== args.agent) {
    record = createNativeChatSessionOptionRecord(args.agent)
  }

  if (args.reportedValues && applyNativeChatReportedSessionOptions(record, args.reportedValues)) {
    writeNativeChatSessionOptionCache(args.scopeKey, record)
  }
  /** Why: an authoritative probe proved this id gone; left tracked it would re-enter
   *  the picker via re-injection and re-persist the fatal `-m` on any later option
   *  write, undoing the settings retirement. */
  const untrackRetiredModel = (): boolean => {
    if (
      catalog.preserveExplicitModelSelection ||
      !catalog.discoveredModelsAreAuthoritative ||
      !modelsAreDiscovered
    ) {
      return false
    }
    const trackedId = typeof record.model?.value === 'string' ? record.model.value : null
    if (!trackedId || models.some((model) => model.id === trackedId)) {
      return false
    }
    clearNativeChatSessionModel(record)
    return true
  }
  if (untrackRetiredModel()) {
    writeNativeChatSessionOptionCache(args.scopeKey, record)
  }
  const activeModels = (): CatalogModel[] => withTrackedNativeChatModel(catalog, models, record)
  let snapshot = buildNativeChatSessionOptionSnapshot({
    catalog,
    models: activeModels(),
    record,
    mode: args.mode
  })
  const listeners = new Set<(value: SessionOptionDescriptor[]) => void>()

  const publish = (): SessionOptionDescriptor[] => {
    writeNativeChatSessionOptionCache(args.scopeKey, record)
    snapshot = buildNativeChatSessionOptionSnapshot({
      catalog,
      models: activeModels(),
      record,
      mode: args.mode
    })
    for (const listener of listeners) {
      listener(snapshot)
    }
    return snapshot
  }

  const clearModelTruth = (): void => {
    clearNativeChatSessionModel(record)
  }

  /** Resolved at commit, not pre-dispatch: with nothing tracked the pre-dispatch id was
   *  only the seed's guess at grok's default, and a probe landing mid-dispatch replaces
   *  it with the id the CLI actually reported — the model the command truly reached. */
  const setTrackedValue = (
    optionId: string,
    value: SessionOptionValue,
    source: 'applied' | 'dispatched' | 'reported'
  ): string | null =>
    setTrackedSessionOption(
      record,
      optionId,
      value,
      source,
      resolveEffectiveNativeChatModelId(catalog, activeModels(), record)
    )

  /** The sole answer to "may this id become the persisted `-m` launch flag?", read at
   *  persist time because a probe can settle mid-pick. Before one, `isDefault` is just
   *  the seed's guess, so only an id the session actually tracks is evidence of
   *  anything; after one, an authoritative list that omits the id proves it retired —
   *  adopting either would emit an `-m` that is fatal on an account without it. */
  const modelIsAdoptableAsLaunchDefault = (modelId: string): boolean =>
    modelsAreDiscovered
      ? !catalog.discoveredModelsAreAuthoritative || models.some((model) => model.id === modelId)
      : record.model !== undefined

  /** Every persist path — picker applies and typed commands — funnels through here. */
  const persist = (modelId: string | null, optionId: string, value: SessionOptionValue): void => {
    if (modelId) {
      void args.persistSelection?.({
        modelId,
        optionId,
        value,
        adoptModelAsLaunchDefault: modelIsAdoptableAsLaunchDefault(modelId)
      })
    }
  }

  const appliers = createSessionOptionAppliers({
    mode: args.mode,
    catalog,
    getModels: activeModels,
    getRecord: () => record,
    dispatchCommand: args.dispatchCommand,
    relaunchSessionOptions: args.relaunchSessionOptions,
    onAgentPicker: args.onAgentPicker,
    persist,
    onDraftValuesChanged: args.onDraftValuesChanged,
    publish,
    clearModelTruth,
    setTrackedValue
  })

  return {
    getSnapshot: () => snapshot,
    setOption: appliers.setOption,
    invokeAction: appliers.invokeAction,
    // Why not automatic: dropping the request is how a surfaced mismatch stops
    // blocking the send, so only the person may do it, per divergence.
    acceptApplied: (id) => {
      if (
        acceptReportedSessionOption(
          record,
          resolveEffectiveNativeChatModelId(catalog, activeModels(), record),
          id
        )
      ) {
        return Promise.resolve({ snapshot: publish() })
      }
      return Promise.resolve({ snapshot })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    recordOutgoingCommand: (command) => {
      const result = recordNativeChatSessionOptionCommand({
        catalog,
        models: activeModels(),
        record,
        command,
        persist
      })
      if (result.changed) {
        publish()
      }
      if (result.opensAgentPicker) {
        args.onAgentPicker?.()
      }
    },
    reportSessionOptions: (values) => {
      if (applyNativeChatReportedSessionOptions(record, values)) {
        publish()
      }
    },
    replaceModels: (nextModels) => {
      models = [...nextModels]
      modelsAreDiscovered = true
      untrackRetiredModel()
      publish()
    },
    confirmRelaunchedSessionOptions: ({ observed, requested, selectedOption }) => {
      applyNativeChatReportedSessionOptions(record, observed)
      publish()
      // Why here and not at apply time: the launch default is written only once
      // the resumed Codex reports the values, so a refused or failed relaunch
      // never rewrites settings. Why only an effort pick persists effort: a model
      // pick carries the effort the person was already on (or none), and writing
      // it into the new model's defaults would overwrite a saved effort they never
      // changed — or pin the default Codex chose on its own as an explicit flag.
      persist(requested.model, 'model', requested.model)
      if (selectedOption === 'effort' && requested.effort) {
        persist(requested.model, 'effort', requested.effort)
      }
    },
    dropDispatchedSessionOptions: () => {
      if (record.model?.source === 'dispatched') {
        record.model = undefined
      }
      for (const [modelId, values] of Object.entries(record.valuesByModel)) {
        const kept = Object.fromEntries(
          Object.entries(values).filter(([, tracked]) => tracked.source !== 'dispatched')
        )
        if (Object.keys(kept).length === 0) {
          delete record.valuesByModel[modelId]
        } else {
          record.valuesByModel[modelId] = kept
        }
      }
      publish()
    }
  }
}
