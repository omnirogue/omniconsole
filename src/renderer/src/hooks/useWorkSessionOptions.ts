import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useWorkAgentCapabilities } from './useWorkAgentCapabilities'
import type { CatalogModel } from '../../../shared/agent-session-option-catalog'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../shared/native-chat-session-options'

export function workSessionOptions(
  snapshot: SessionOptionDescriptor[],
  models: CatalogModel[]
): SessionOptionDescriptor[] {
  const selected = snapshot.find((option) => option.category === 'model')
  const modelId = selected?.kind.type === 'select' ? selected.kind.currentValue : undefined
  const model = models.find((entry) => entry.id === modelId)
  return snapshot.flatMap((option) => {
    if (option.category === 'model' && option.kind.type === 'select') {
      const choices = option.kind.choices.filter((choice) =>
        models.some((entry) => entry.id === choice.value)
      )
      return [
        {
          ...option,
          settable: option.settable && choices.length > 0,
          kind: { ...option.kind, choices }
        }
      ]
    }
    if (option.category === 'thought_level' && option.kind.type === 'select') {
      const supported = model?.options.find((entry) => entry.id === 'effort')
      // Why a diverging row survives the constraint: dropping it would hide the effort
      // the session is actually running at, which is exactly how that stayed invisible.
      if (supported?.kind.type !== 'select') {
        return option.parity ? [{ ...option, settable: false }] : []
      }
      const choices = option.kind.choices.filter(
        (choice) =>
          supported.kind.type === 'select' &&
          supported.kind.choices.some((entry) => entry.value === choice.value)
      )
      return choices.length || option.action || option.parity
        ? [{ ...option, kind: { ...option.kind, choices } }]
        : []
    }
    return [option]
  })
}

export type WorkSessionOptionsTransport = 'catalog' | 'agent-session'

/** Structured sessions use their provider snapshot; terminal launches use account discovery. */
function constrainingModels(
  entry: { models: CatalogModel[]; modelsProbed?: boolean } | undefined,
  agent: string,
  transport: WorkSessionOptionsTransport
): CatalogModel[] | null {
  if (transport === 'agent-session') {
    return null
  }
  if (!entry) {
    return []
  }
  if (entry.modelsProbed === false && agent === 'codex') {
    return null
  }
  return entry.models
}

/** Validate each setting against the options offered by its execution transport. */
export function useWorkSessionOptions(args: {
  agent: string
  tabId: string
  worktreeId?: string
  surface: SessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
  /** Which surface `surface` wraps; defaults to the agent-session (structured) rules. */
  transport?: WorkSessionOptionsTransport
}) {
  const transport = args.transport ?? 'agent-session'
  const worktreeId = useAppStore(
    (state) =>
      args.worktreeId ??
      Object.entries(state.tabsByWorktree).find(([, tabs]) =>
        tabs.some((tab) => tab.id === args.tabId)
      )?.[0] ??
      null
  )
  const availability = useWorkAgentCapabilities(worktreeId)
  const refreshAvailability = availability.refresh
  const models = constrainingModels(
    availability.usable.find((entry) => entry.id === args.agent),
    args.agent,
    transport
  )
  const snapshot = models ? workSessionOptions(args.snapshot, models) : args.snapshot
  const surface = useMemo<SessionOptionsSurface | null>(() => {
    if (!args.surface) {
      return null
    }
    const original = args.surface
    return {
      ...original,
      async setOption(id, value) {
        const available =
          transport === 'catalog'
            ? (await refreshAvailability([args.agent])).find(
                (entry) => entry.id === args.agent && entry.status === 'usable'
              )
            : undefined
        const probedModels = constrainingModels(available, args.agent, transport)
        const options = probedModels
          ? workSessionOptions(original.getSnapshot(), probedModels)
          : original.getSnapshot()
        const option = options.find((entry) => entry.id === id)
        if (
          !option?.settable ||
          (option.kind.type === 'select' &&
            !option.kind.choices.some((choice) => choice.value === value))
        ) {
          throw new Error('This setting is no longer available. Refresh and choose another.')
        }
        return original.setOption(id, value)
      }
    }
  }, [args.surface, args.agent, refreshAvailability, transport])
  return { surface, snapshot }
}
