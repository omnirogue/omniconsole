import { useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { resolveNativeChatSession } from './native-chat-pane-resolution'
import { requestOmpSessionExit } from './request-omp-session-exit'

type ExitTarget = {
  agent: string
  tabId: string
  paneKey: string
  ptyId: string | null
  sessionId: string | null
  runtimeEnvironmentId: string | null
  connectionId?: string | null
  agentExited: boolean
}

export function useOmpSessionExit(target: ExitTarget) {
  const identity = JSON.stringify(target)
  const currentIdentity = useRef(identity)
  const mounted = useRef(true)
  const active = useRef(false)
  const [state, setState] = useState<{
    identity: string
    phase: 'pending' | 'requested' | 'unverified'
    error?: string
  } | null>(null)
  useLayoutEffect(() => {
    currentIdentity.current = identity
    active.current = false
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [identity])
  const visible = state?.identity === identity ? state : null
  const end = async () => {
    if (
      target.agent !== 'omp' ||
      !target.ptyId ||
      !target.sessionId ||
      target.agentExited ||
      active.current
    ) {
      return
    }
    active.current = true
    setState({ identity, phase: 'pending' })
    const assertCurrent = () => {
      const store = useAppStore.getState()
      const entry = store.agentStatusByPaneKey[target.paneKey]
      const record = store.sleepingAgentSessionsByPaneKey[target.paneKey]
      // A status-only repaint can omit the identity the same pane's Chat view retains.
      const retained =
        record?.agent === 'omp' &&
        record.paneKey === target.paneKey &&
        (record.tabId === undefined || record.tabId === target.tabId) &&
        (!entry?.worktreeId || record.worktreeId === entry.worktreeId) &&
        (record.connectionId ?? null) === (target.connectionId ?? null)
          ? record
          : null
      const session = resolveNativeChatSession({
        paneKey: target.paneKey,
        ptyId: target.ptyId,
        agentStatusEntry: entry,
        sleepingRecord: retained
      })
      if (
        !mounted.current ||
        currentIdentity.current !== identity ||
        entry?.agentType !== 'omp' ||
        session?.sessionId !== target.sessionId ||
        (entry.connectionId ?? null) !== (target.connectionId ?? null)
      ) {
        throw new Error('The OMP conversation changed before the exit request could be confirmed.')
      }
    }
    try {
      await requestOmpSessionExit({
        ...target,
        ptyId: target.ptyId,
        sessionId: target.sessionId,
        assertCurrent
      })
      assertCurrent()
      setState({ identity, phase: 'requested' })
    } catch (error) {
      if (mounted.current && currentIdentity.current === identity) {
        setState({
          identity,
          phase: 'unverified',
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
  return { phase: visible?.phase, error: visible?.error, requested: !!visible, end }
}
