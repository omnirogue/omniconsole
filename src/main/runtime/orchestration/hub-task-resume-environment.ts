import { buildHubTaskEnvironment, HUB_TASK_ID_PATTERN } from '../../../shared/omnios-task-binding'
import type { OrchestrationDb } from './db'
import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../shared/tui-agent'
import { canonicalizeAgentSessionIdentity } from '../agent-session-claim-identity'
import { resolveInheritedHubBinding } from './db/hub/inherited-hub-binding'

export type HubTaskResumeCandidate = {
  paneKey: string
  terminalHandle?: string
  processIncarnation?: string
  capturedEnv?: Record<string, string>
}

export function resolveHubTaskResumeEnvironment(args: {
  db: OrchestrationDb | null
  candidates: HubTaskResumeCandidate[]
  workspaceHubTaskId?: string
  sessionHubTaskId?: string
}): Record<string, string> | undefined {
  const durableIds = new Set<string>()
  if (args.sessionHubTaskId) {
    durableIds.add(args.sessionHubTaskId)
  }
  for (const candidate of args.candidates) {
    const inherited = args.db
      ? resolveInheritedHubBinding(args.db, {
          coordinatorHandle: candidate.terminalHandle ?? '',
          coordinatorPaneKey: candidate.paneKey,
          coordinatorProcessIncarnation: candidate.processIncarnation
        })
      : undefined
    if (inherited?.hubTaskId) {
      durableIds.add(inherited.hubTaskId)
    }
  }
  const capturedIds = new Set(
    args.candidates.map((candidate) => candidate.capturedEnv?.OMNI_TASK_ID).filter(Boolean)
  )
  const ids = durableIds.size ? durableIds : capturedIds
  if (args.workspaceHubTaskId) {
    if (ids.size && !ids.has(args.workspaceHubTaskId)) {
      throw new Error('Conflicting omnios card identities; resume refused.')
    }
    ids.add(args.workspaceHubTaskId)
  }
  if (ids.size > 1) {
    throw new Error('Conflicting omnios card identities; resume refused.')
  }
  const hubTaskId = [...ids][0]
  if (!hubTaskId) {
    return undefined
  }
  if (!HUB_TASK_ID_PATTERN.test(hubTaskId)) {
    throw new Error('Invalid saved omnios card identity; resume refused.')
  }
  return {
    ...Object.assign({}, ...args.candidates.map((candidate) => candidate.capturedEnv)),
    ...buildHubTaskEnvironment(hubTaskId)
  }
}

export function matchesCanonicalHubResumeSession(
  agent: TuiAgent,
  candidate: AgentProviderSessionMetadata | null | undefined,
  canonical: AgentProviderSessionMetadata
): boolean {
  if (candidate?.key !== canonical.key || candidate.id !== canonical.id) {
    return false
  }
  if (agent !== 'pi' && agent !== 'prime-agent') {
    return true
  }
  try {
    return agentProviderSessionsEqual(
      agent,
      canonicalizeAgentSessionIdentity(agent, candidate).providerSession,
      canonical
    )
  } catch {
    return false
  }
}
