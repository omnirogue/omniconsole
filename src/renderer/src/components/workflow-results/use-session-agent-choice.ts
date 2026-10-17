import { useEffect, useMemo, useState } from 'react'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { detectAgentSessionContinuationAgents } from '@/lib/launch-agent-session-continuation'
import { useAppStore } from '@/store'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { chooseInitialContinuationAgent } from '../agent-session-continuation/agent-session-continuation-selection'

const NO_AGENTS: TuiAgent[] = []

/** The agents installed and enabled on the workspace's host, with the default one picked. */
export function useSessionAgentChoice(worktreeId: string) {
  const disabledAgents = useAppStore((state) => state.settings?.disabledTuiAgents ?? NO_AGENTS)
  const defaultAgent = useAppStore((state) => state.settings?.defaultTuiAgent)
  const [detected, setDetected] = useState<TuiAgent[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [picked, setAgent] = useState<TuiAgent | null>(null)

  useEffect(() => {
    let cancelled = false
    void detectAgentSessionContinuationAgents(worktreeId)
      .then((found) => {
        if (cancelled) {
          return
        }
        const enabled = found.filter((entry) => isTuiAgentEnabled(entry, disabledAgents))
        setDetected(enabled)
        // A pick that is no longer installed or enabled gives way to the default.
        setAgent((current) =>
          current && enabled.includes(current)
            ? current
            : chooseInitialContinuationAgent({
                availableAgents: enabled,
                sourceAgent: null,
                defaultAgent
              })
        )
      })
      .catch((error: unknown) => {
        console.error('Agent detection failed for a results session', error)
        if (!cancelled) {
          setDetected([])
          setFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [worktreeId, disabledAgents, defaultAgent])

  const agents = useMemo(
    () =>
      getAgentCatalog().filter(
        (entry) =>
          (detected ?? NO_AGENTS).includes(entry.id) && isTuiAgentEnabled(entry.id, disabledAgents)
      ),
    [detected, disabledAgents]
  )
  // Why: between a settings change and the next detection, the old pick may be disabled already.
  const agent = picked && agents.some((entry) => entry.id === picked) ? picked : null
  return { agents, agent, setAgent, detecting: detected === null, failed }
}
