import { useCallback, useMemo } from 'react'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { useBackofficeWorkViews } from '@/components/task-page/backoffice/backoffice-work-store'
import { useWorkAgentCapabilities, workAgentProviderUsage } from '@/hooks/useWorkAgentCapabilities'
import { translate } from '@/i18n/i18n'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorkAgentStatus } from '../../../../shared/work-agent-availability'
import { nextStepSubjectTask, type NextStepSubject } from './next-step-subject'
import { useHandoffPeople } from './use-handoff-people'

export type NextStepLoad<T> =
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'error'; message: string }

export type NextStepAvailableAgent = AgentCatalogEntry & {
  status: string
  models: CatalogModel[]
}

export type NextStepRecipientSource = {
  agents: NextStepLoad<NextStepAvailableAgent[]>
  people: NextStepLoad<TeamRosterPerson[]>
  reload: () => void
  refreshAgents: () => Promise<NextStepAvailableAgent[]>
  /** Usage of each agent's provider; the Add Next menu shows it beside the name. */
  agentDetails?: ReadonlyMap<TuiAgent, AgentUsageDetail>
  /** Agents the host cannot launch, each with a plain-language reason. */
  hiddenAgents?: readonly HiddenAgent[]
  peopleSource?: 'directory' | 'employees'
  /** The people list was narrowed without the company folders; it may be missing people. */
  peopleIncomplete?: boolean
}

export type UsageWindowKind = 'session' | 'weekly' | 'monthly'
export type AgentUsageDetail = {
  usedPercent: number | null
  /** Which window is the most used; its label is localized here. */
  windowKind: UsageWindowKind | null
  windowLabel: string | null
  resetDescription: string | null
}
export type HiddenAgentCode =
  | 'not-installed'
  | 'disabled'
  | 'not-signed-in'
  | 'out-of-quota'
  | 'health-check-failed'
  | 'model-unavailable'
  | 'unverified'
export type HiddenAgent = {
  id: TuiAgent
  label: string
  code: HiddenAgentCode
  reason: string
  reset?: string | null
}

// Why: work-plan-required is the whole panel's refusal, not one agent being unavailable.
const HIDDEN_CODES: Partial<Record<WorkAgentStatus, HiddenAgentCode>> = {
  'cli-missing': 'not-installed',
  disabled: 'disabled',
  'logged-out': 'not-signed-in',
  'quota-exhausted': 'out-of-quota',
  'health-check-failed': 'health-check-failed',
  'model-unavailable': 'model-unavailable',
  unverified: 'unverified'
}

function hiddenAgentReason(code: HiddenAgentCode, reset: string | null): string {
  switch (code) {
    case 'not-installed':
      return translate('nextStep.agentNotInstalled', 'not installed on this host')
    case 'disabled':
      return translate('nextStep.agentDisabled', 'disabled in Settings → Agents')
    case 'not-signed-in':
      return translate('nextStep.agentNotSignedIn', 'not signed in')
    case 'out-of-quota':
      return translate('nextStep.agentOutOfQuota', 'out of quota until {{reset}}', {
        reset: reset ?? ''
      })
    case 'health-check-failed':
      return translate('nextStep.agentHealthCheckFailed', 'its account check failed')
    case 'model-unavailable':
      return translate('nextStep.agentModelUnavailable', 'no model of its own is available')
    case 'unverified':
      return translate('nextStep.agentUnverified', 'its sign-in and quota could not be checked')
  }
}

function usageWindowLabel(kind: UsageWindowKind | null): string | null {
  switch (kind) {
    case 'session':
      return translate('nextStep.usageWindowSession', '5 h')
    case 'weekly':
      return translate('nextStep.usageWindowWeekly', '7 d')
    case 'monthly':
      return translate('nextStep.usageWindowMonthly', 'month')
    case null:
      return null
  }
}

/** The window a person actually hits first: whichever is most used. */
export function mostUsedWindow(usage: ProviderRateLimits | null): AgentUsageDetail {
  const windows = (
    [
      { window: usage?.session ?? null, kind: 'session' },
      { window: usage?.weekly ?? null, kind: 'weekly' },
      { window: usage?.monthly ?? null, kind: 'monthly' }
    ] as const
  )
    .filter((value) => value.window && Number.isFinite(value.window.usedPercent))
    .sort((a, b) => b.window!.usedPercent - a.window!.usedPercent)
  const most = windows[0]
  return {
    usedPercent: most?.window?.usedPercent ?? null,
    windowKind: most?.kind ?? null,
    windowLabel: usageWindowLabel(most?.kind ?? null),
    resetDescription: most?.window?.resetDescription ?? null
  }
}

// Why: the provider's own reset text reads like a clock; a raw timestamp never should.
function resetText(usage: ProviderRateLimits | null, detail: AgentUsageDetail): string | null {
  if (detail.resetDescription) {
    return detail.resetDescription
  }
  const resetsAt = [usage?.session, usage?.weekly, usage?.monthly].find(
    (window) => window && window.usedPercent >= 100
  )?.resetsAt
  return resetsAt
    ? new Date(resetsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : null
}

/** People come from the signed-in account, independently of any execution host. */
export function useNextStepPeople(): {
  people: NextStepLoad<TeamRosterPerson[]>
  reload: () => void
} {
  const scope = useHandoffScope()
  const work = useBackofficeWorkViews(scope, true)
  const people = useMemo<NextStepLoad<TeamRosterPerson[]>>(() => {
    const roster = work.reads.roster
    switch (roster.phase) {
      case 'ready':
        return { phase: 'ready', value: roster.value }
      case 'error':
        return roster.previous
          ? { phase: 'ready', value: roster.previous }
          : { phase: 'error', message: roster.message }
      case 'loading':
        return roster.previous ? { phase: 'ready', value: roster.previous } : { phase: 'loading' }
      case 'not-served':
        return {
          phase: 'error',
          message: translate(
            'nextStep.rosterNotServed',
            'This server does not list your teammates yet.'
          )
        }
      case 'idle':
        return { phase: 'loading' }
    }
  }, [work.reads.roster])
  return { people, reload: work.refresh }
}

/**
 * Who can get the work next: the agents this workspace's host can actually launch —
 * the one availability projection Start Work uses — plus the active people the signed
 * person may hand work to. Agents the host cannot launch are not dropped silently; they
 * come back as `hiddenAgents` with a plain-language reason.
 */
export function useNextStepRecipients(subject: NextStepSubject): NextStepRecipientSource & {
  agentDetails: ReadonlyMap<TuiAgent, AgentUsageDetail>
  hiddenAgents: readonly HiddenAgent[]
  peopleSource: 'directory' | 'employees'
  peopleIncomplete: boolean
} {
  const worktreeId = subject.kind === 'session' ? subject.session.worktreeId : null
  const taskId = nextStepSubjectTask(subject)?.id
  const capability = useWorkAgentCapabilities(worktreeId, taskId, 'task-continuation')
  // Why: the capability hook already holds the owning host's usage; this computer's cannot attest to it.
  const rates = capability.rates ?? null
  const people = useHandoffPeople()
  const capabilities = capability.capabilities
  const projection = useMemo(() => {
    const details = new Map<TuiAgent, AgentUsageDetail>()
    const hidden: HiddenAgent[] = []
    for (const entry of capabilities) {
      const usage = rates ? workAgentProviderUsage(rates, entry.id) : null
      const detail = mostUsedWindow(usage)
      details.set(entry.id, detail)
      const code = HIDDEN_CODES[entry.status]
      if (!code) {
        continue
      }
      const reset = code === 'out-of-quota' ? resetText(usage, detail) : null
      hidden.push({
        id: entry.id,
        label: entry.label,
        code,
        reason: hiddenAgentReason(code, reset),
        reset
      })
    }
    return { details, hidden }
  }, [capabilities, rates])
  const agents: NextStepLoad<NextStepAvailableAgent[]> = capability.loading
    ? { phase: 'loading' }
    : capability.continuationUnavailableReason
      ? { phase: 'error', message: capability.continuationUnavailableReason }
      : capabilities.every((entry) => entry.status === 'work-plan-required')
        ? {
            phase: 'error',
            message: translate(
              'conversations.workPlanRequired',
              'This work location is linked to a task. Open that task to start its approved work plan, or choose another work location.'
            )
          }
        : { phase: 'ready', value: capability.usable }
  const refreshAgents = capability.refresh
  const reloadPeople = people.reload
  const reload = useCallback(() => {
    reloadPeople()
    void refreshAgents()
  }, [refreshAgents, reloadPeople])
  return {
    agents,
    people: people.people,
    reload,
    agentDetails: projection.details,
    hiddenAgents: projection.hidden,
    peopleSource: people.peopleSource,
    peopleIncomplete: people.peopleIncomplete,
    refreshAgents
  }
}
