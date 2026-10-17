import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { resolveBackofficeBaseUrl } from '../../../../shared/backoffice-connection'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { consoleJiraIssueUrl } from '../../../../shared/console-jira-work-contract'

const ANSWERS = {
  pending: 'Awaiting a decision',
  attach_existing: 'Attach an existing task',
  create_jira: 'Creation requested',
  keep_taskless: 'Keep taskless',
  decline: 'Tracking declined',
  defer: 'Deferred'
} as const

export function HandoffTaskTracking({ detail }: { detail: HandoffDetail }) {
  const settings = useAppStore((state) => state.settings)
  const connection = resolveBackofficeBaseUrl(settings ?? {})
  const proposal = detail.task_proposal
  const ref = detail.thread.task_ref
  const jiraUrl = ref ? consoleJiraIssueUrl(ref) : null
  const canAttach =
    !ref && !proposal && !detail.thread.board_task_id && !detail.thread.communication_type
  if (!ref && !proposal && !canAttach) {
    return null
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm">
      {ref ? (
        <div className="flex items-center gap-2">
          <span>
            {translate('handoffs.jiraTask', 'Jira task')}: {ref.issue_key}
          </span>
          {jiraUrl ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void window.api.shell.openUrl(jiraUrl)}
            >
              {translate('auto.components.TaskPage.eee68073b2', 'Open in Jira')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {proposal ? (
        <>
          <p className="font-medium">{proposal.proposed_commitment}</p>
          <p>{ANSWERS[proposal.decision]}</p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'handoffs.trackingPermission',
              'This tracking decision does not create a task. Agent creation needs explicit permission.'
            )}
          </p>
        </>
      ) : null}
      {proposal || canAttach ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!connection.configured}
          onClick={() => {
            if (connection.configured) {
              void window.api.shell.openUrl(
                new URL(
                  `/work/handoffs/${encodeURIComponent(detail.thread.id)}`,
                  connection.baseUrl
                ).toString()
              )
            }
          }}
        >
          {proposal
            ? translate('handoffs.openTrackingDecision', 'Open conversation and tracking decision')
            : translate('handoffs.attachJiraTask', 'Attach an existing Jira task…')}
        </Button>
      ) : null}
    </div>
  )
}
