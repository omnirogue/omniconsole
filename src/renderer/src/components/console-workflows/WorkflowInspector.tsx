import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage,
  workflowWebLink
} from '@/lib/console-workflow-client'
import { translate } from '@/i18n/i18n'
import type {
  ConsoleJobRecord,
  ConsoleWorkflowJob
} from '../../../../shared/console-workflow-types'
import { WorkflowError, WorkflowValue } from './WorkflowFields'
import { WorkflowLocalExecution } from './WorkflowLocalExecution'
import { WorkflowJobEvidence } from './WorkflowJobEvidence'
import { WorkflowJobResults } from './WorkflowJobResults'

export function WorkflowInspector({
  job,
  workflowId,
  onRefresh
}: {
  job: ConsoleWorkflowJob
  workflowId: string
  onRefresh: () => void
}) {
  const [stored, setStored] = useState<ConsoleJobRecord | null>(null)
  const detail = stored
    ? {
        ...job,
        ...stored,
        policy: { ...job.policy, ...stored.policy, workflow: job.policy.workflow }
      }
    : job
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setStored(null)
    void (async () => {
      try {
        const result = workflowData(await consoleWorkflowApi().getJob({ jobId: job.id }))
        if (!cancelled) {
          setStored(result)
          setError(null)
        }
      } catch (failure) {
        if (!cancelled) {
          setError(workflowErrorMessage(failure))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [job])
  const prompt =
    'exact_prompt' in detail ? detail.exact_prompt : 'prompt' in detail ? detail.prompt : undefined
  const reviewUrl = workflowWebLink(detail.pr_url)
  const localPlacement = 'placement' in detail && detail.placement === 'local'
  const fleetConversation = !localPlacement && !!detail.policy.workflow.source
  const primaryTranscript = fleetConversation && detail.actor_type === 'ai'
  const canStart = localPlacement && 'can_start' in detail && detail.can_start === true
  return (
    <aside
      aria-label={translate('consoleWorkflows.inspector', 'Inspector')}
      className={
        fleetConversation
          ? 'space-y-3'
          : 'space-y-4 rounded-md border border-border bg-card p-4 text-card-foreground'
      }
    >
      {!fleetConversation && (
        <h2 className="text-sm font-medium">
          {translate('consoleWorkflows.inspector', 'Inspector')} · {detail.title}
        </h2>
      )}
      <WorkflowError message={error} />
      {reviewUrl && !primaryTranscript && (
        <Button variant="link" size="sm" asChild>
          <a href={reviewUrl} target="_blank" rel="noreferrer">
            <ExternalLink />
            {translate('consoleWorkflows.openReview', 'Open review')}
          </a>
        </Button>
      )}
      {!primaryTranscript && <WorkflowJobResults job={detail} />}
      {fleetConversation && (
        <WorkflowJobEvidence
          jobId={job.id}
          attempt={detail.attempt ?? undefined}
          leaseGeneration={detail.lease_generation ?? undefined}
          provider={detail.provider}
          initiallyOpen
        />
      )}
      {primaryTranscript && (
        <>
          {reviewUrl && (
            <Button variant="link" size="sm" asChild>
              <a href={reviewUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
                {translate('consoleWorkflows.openReview', 'Open review')}
              </a>
            </Button>
          )}
          <WorkflowJobResults job={detail} />
        </>
      )}
      <details open={!fleetConversation} className="space-y-3">
        <summary className="cursor-pointer text-sm font-medium">
          {translate('consoleWorkflows.jobDetails', 'Job details')}
        </summary>
        {prompt == null && (
          <p className="text-xs text-muted-foreground">
            {translate(
              'consoleWorkflows.promptUnavailable',
              'The exact execution prompt is unavailable in this server view.'
            )}
          </p>
        )}
        <dl className="space-y-3">
          <WorkflowValue
            label={translate('consoleWorkflows.stagePrompt', 'Exact stage prompt')}
            value={prompt}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.brief', 'Job brief')}
            value={'brief' in detail ? detail.brief : undefined}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.inputs', 'Inputs')}
            value={'inputs' in detail ? detail.inputs : undefined}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.acceptance', 'Acceptance')}
            value={'acceptance' in detail ? detail.acceptance : undefined}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.output', 'Output')}
            value={'output_tail' in detail ? detail.output_tail : undefined}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.branch', 'Branch')}
            value={'branch' in detail ? detail.branch : undefined}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.taskId', 'Task ID')}
            value={detail.task_id}
          />
          <WorkflowValue label={translate('consoleWorkflows.jobId', 'Job ID')} value={detail.id} />
          <WorkflowValue
            label={translate('consoleWorkflows.status', 'Job status')}
            value={detail.status}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.provider', 'Provider')}
            value={detail.provider}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.model', 'Model')}
            value={detail.model}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.effort', 'Effort')}
            value={detail.effort}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.attempt', 'Attempt')}
            value={detail.attempt}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.generation', 'Generation')}
            value={detail.lease_generation}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.ownedPaths', 'Owned paths')}
            value={detail.owned_paths}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.blockers', 'Blockers')}
            value={detail.blockers}
          />
          <WorkflowValue
            label={translate('consoleWorkflows.humanResult', 'Human decision receipt')}
            value={detail.policy.human_result}
          />
        </dl>
      </details>
      {!fleetConversation && (
        <WorkflowJobEvidence
          jobId={job.id}
          attempt={detail.attempt ?? undefined}
          leaseGeneration={detail.lease_generation ?? undefined}
          provider={detail.provider}
        />
      )}
      {!fleetConversation && (
        <WorkflowLocalExecution
          key={job.id}
          jobId={job.id}
          workflowId={workflowId}
          digest={job.policy.workflow.digest}
          canStart={canStart}
          onRefresh={onRefresh}
        />
      )}
    </aside>
  )
}
