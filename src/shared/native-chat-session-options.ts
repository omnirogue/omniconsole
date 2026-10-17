import type { SessionEffortParity } from './session-effort-parity'

import type { AgentType } from './agent-status-types'

export type SessionOptionValue = string | boolean

/** Provider readback: null clears a concrete value; omission leaves it unchanged.
 *  This is not a user-selectable option value. */
export type ReportedSessionOptionValues = Record<string, SessionOptionValue | null>

export type SessionOptionSelectChoice = {
  value: string
  label: string
  description?: string
}

/** `default` is the catalog's own value shown before anything is observed —
 *  truthful to display, but never evidence about a running agent. */
export type SessionOptionValueSource = 'applied' | 'dispatched' | 'reported' | 'default' | 'unknown'

/** Closed set of reasons an option is not settable in the current mode. A key
 *  (not free English) so the producer and the localized label stay in sync —
 *  an exhaustive switch turns any drift into a type error instead of leaking
 *  untranslated text. */
export type SessionOptionDisabledReason =
  | 'available-after-session-start'
  | 'set-when-session-starts'

export type SessionOptionDescriptor = {
  id: string
  label: string
  description?: string
  category?: 'model' | 'thought_level' | 'model_config' | 'mode'
  kind:
    | {
        type: 'select'
        currentValue?: string
        choices: SessionOptionSelectChoice[]
      }
    | {
        type: 'boolean'
        currentValue?: boolean
      }
  valueSource: SessionOptionValueSource
  /** Set only while the provider reported a value other than the requested one, or
   *  refused the requested one. Absent means requested and applied agree, and the
   *  surface shows a single value. */
  parity?: SessionEffortParity
  settable: boolean
  disabledReason?: SessionOptionDisabledReason
  /** Why: picker-only and toggle-only PTY commands cannot be represented as
   * a truthful radio/checkbox state, so the producer exposes an action row. */
  action?: { type: 'agent-picker' | 'toggle-command' }
  /** Set only for live catalog-transport rows whose apply restarts the agent on the
   *  same thread; radios still render, the menu shows a hint. */
  applyKind?: 'resume-relaunch'
}

export type SessionOptionSetResult = {
  snapshot: SessionOptionDescriptor[]
}

export type PersistedNativeChatSessionOptions = Partial<
  Record<
    string,
    {
      model?: string
      valuesByModel?: Record<string, Record<string, SessionOptionValue>>
    }
  >
>

export type NativeChatSessionOptionSettingsMutation =
  | {
      type: 'apply-picks'
      agent: AgentType
      picks: readonly {
        modelId: string
        optionId: string
        value: SessionOptionValue
        adoptModelAsLaunchDefault?: boolean
      }[]
    }
  | { type: 'clear-model-if-missing'; agent: AgentType; availableModelIds: readonly string[] }

export type SessionOptionsSurface = {
  getSnapshot(): SessionOptionDescriptor[]
  /** Apply an absolute target; known flip-only options use their tracked baseline. */
  setOption(id: string, value: SessionOptionValue): Promise<SessionOptionSetResult>
  /** Invoke the value-less action exposed by the current descriptor. */
  invokeAction(id: string): Promise<SessionOptionSetResult>
  /** Keep the value the provider reported and stop asking for the refused one, so a
   *  surfaced mismatch can be settled without pretending it never happened. Optional:
   *  a surface that cannot hold a request (mobile, read-only views) omits it. */
  acceptApplied?(id: string): Promise<SessionOptionSetResult>
  subscribe(listener: (snapshot: SessionOptionDescriptor[]) => void): () => void
}
