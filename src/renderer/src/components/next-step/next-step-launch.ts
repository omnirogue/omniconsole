import { OUTCOME_AGENT_MISSION } from '../../../../shared/outcome-agent-mission'
import { buildHandoffLaunch, type HandoffLaunch } from '@/components/handoffs/handoff-launch'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { BackofficeTodoItem } from '../../../../shared/backoffice-work-types'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { getSettingsFocusedExecutionHostId } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { NextStepAgentRecipient } from '../../../../shared/next-step-draft'
import { defaultNextStepInstructions } from '../../../../shared/next-step-draft'
import { SESSION_ACTION_PRESET_LABELS } from '../../../../shared/session-action-presets'
import { normalizeTaskSourceContext } from '../../../../shared/task-source-context'

type LaunchSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

/** The instruction an agent gets with a card or thread: the chosen action, then the work. */
export function nextStepAgentBrief(recipient: NextStepAgentRecipient): string {
  const action = recipient.presetId ? SESSION_ACTION_PRESET_LABELS[recipient.presetId] : null
  const instructions =
    recipient.instructions.trim() ||
    (recipient.presetId ? defaultNextStepInstructions(recipient.presetId) : '')
  return `${OUTCOME_AGENT_MISSION}\n\nChosen action: ${action ? `${action}: ${instructions}` : instructions}`
}

/**
 * A card handed to an agent starts a workspace bound to it, like Use task, with the
 * instruction as the draft prompt. The composer still lets the person pick the folder.
 */
export function buildCardLaunch({
  item,
  baseUrl,
  settings,
  brief
}: {
  item: BackofficeTodoItem
  baseUrl: string
  settings: LaunchSettings
  brief: string
}): HandoffLaunch | null {
  const taskSourceContext = normalizeTaskSourceContext({
    provider: 'backoffice',
    projectId: 'backoffice',
    hostId: getSettingsFocusedExecutionHostId(settings),
    providerIdentity: { provider: 'backoffice', baseUrl },
    accountLabel: baseUrl
  })
  if (!taskSourceContext) {
    return null
  }
  // WorkspaceLinkedItem requires an absolute, non-empty url; the BFF href is a console SPA path.
  const url = item.href ? `${baseUrl}${item.href.startsWith('/') ? '' : '/'}${item.href}` : baseUrl
  const linkedWorkItem: LinkedWorkItemSummary = {
    type: 'issue',
    provider: 'backoffice',
    number: 0,
    title: item.title,
    url,
    hubTaskId: item.task_id,
    ...(item.state_revision != null ? { hubStateRevision: item.state_revision } : {}),
    ...(item.next_action ? { hubNextAction: item.next_action } : {})
  }
  const context = [item.why, item.what ?? item.next_action]
    .filter((line): line is string => !!line?.trim())
    .join('\n')
  return {
    linkedWorkItem,
    taskSourceContext,
    prefilledName: item.title,
    prefilledNote: context ? `${brief}\n\nCard ${item.task_id} — ${item.title}\n${context}` : brief,
    telemetrySource: 'sidebar'
  }
}

/** A thread handed to an agent: the existing "start with my AI" launch, led by the instruction. */
export function buildThreadLaunch({
  detail,
  baseUrl,
  settings,
  brief
}: {
  detail: HandoffDetail
  baseUrl: string
  settings: LaunchSettings
  brief: string
}): HandoffLaunch | null {
  const launch = buildHandoffLaunch({ detail, baseUrl, settings })
  return launch ? { ...launch, prefilledNote: `${brief}\n\n${launch.prefilledNote}` } : null
}
