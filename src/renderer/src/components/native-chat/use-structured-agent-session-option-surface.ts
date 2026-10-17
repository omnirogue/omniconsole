// The structured chat's option surface: the snapshot, the write, and the
// SessionOptionsSurface the composer consumes.
//
// Lifted out of use-structured-agent-session.ts so that file stays inside its line
// budget. It is a closed unit — the only things it needs from the session are the
// option state and the mutation callback, and the only thing it hands back is the
// surface, which is exactly why the split lands here rather than mid-lifecycle.

import { useCallback, useMemo, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentSessionOptionResult } from '../../../../shared/agent-session-wire'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import {
  acceptAppliedStructuredAgentSessionOption,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionResult,
  structuredAgentSessionOptionPicks,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { enqueueSessionOptionSettingsWrite } from './native-chat-session-option-settings-write'

export function useStructuredAgentSessionOptionSurface(input: {
  agent: AgentType
  target: RuntimeClientTarget
  optionState: StructuredAgentSessionOptionState
  setOptionState: Dispatch<SetStateAction<StructuredAgentSessionOptionState>>
  activeOptionRecordRef: RefObject<StructuredAgentSessionOptionState['record']>
  mutate: <T>(
    method: string,
    fingerprintMethod: string,
    fields: Record<string, unknown>
  ) => Promise<T | null>
}): {
  optionSnapshot: SessionOptionDescriptor[]
  setStructuredOption: (id: string, value: string | boolean) => Promise<boolean>
  optionSurface: SessionOptionsSurface
} {
  const { agent, activeOptionRecordRef, mutate, optionState, setOptionState, target } = input
  const optionSnapshot = useMemo(
    () => structuredAgentSessionOptionSnapshot(optionState),
    [optionState]
  )
  const setStructuredOption = useCallback(
    async (id: string, value: string | boolean): Promise<boolean> => {
      if (
        !canSetStructuredAgentSessionOption(optionState, id, value) ||
        typeof value !== 'string'
      ) {
        return false
      }
      const targetRecord = optionState.record
      setOptionState((current) => ({ ...current, pendingId: id }))
      try {
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value }
        )
        if (result && activeOptionRecordRef.current === targetRecord) {
          const committed = result.options ?? { [id]: value }
          setOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOptionResult(current, { id, value }, result.options)
              : current
          )
          const picks = structuredAgentSessionOptionPicks(optionState, committed)
          if (picks.length > 0) {
            void enqueueSessionOptionSettingsWrite(target, {
              type: 'apply-picks',
              agent,
              picks
            })
          }
        }
        return Boolean(result)
      } finally {
        setOptionState((current) =>
          current.record === targetRecord && current.pendingId === id
            ? { ...current, pendingId: null }
            : current
        )
      }
    },
    [activeOptionRecordRef, agent, mutate, optionState, setOptionState, target]
  )
  const setOption = useCallback(
    async (id: string, value: string | boolean) => {
      await setStructuredOption(id, value)
      return { snapshot: optionSnapshot }
    },
    [optionSnapshot, setStructuredOption]
  )
  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      acceptApplied: async (id: string) => {
        setOptionState((current) => acceptAppliedStructuredAgentSessionOption(current, id))
        return { snapshot: optionSnapshot }
      },
      subscribe: () => () => {}
    }),
    [optionSnapshot, setOption, setOptionState]
  )

  return { optionSnapshot, setStructuredOption, optionSurface }
}
