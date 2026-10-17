import { readWorkflowGraph, refreshWorkflowGraph } from '@/lib/workflow-graph-read-cache'
import { conversationFleetScope } from '@/store/conversation-fleet-store'
import { useEffect, useEffectEvent, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { workflowErrorMessage } from '@/lib/console-workflow-client'
import { translate } from '@/i18n/i18n'
import type { ConsoleWorkflowJob } from '../../../../shared/console-workflow-types'
import { WorkflowGraph } from './WorkflowGraph'
import { WorkflowError, WorkflowSelect } from './WorkflowFields'
import { WorkflowInspector } from './WorkflowInspector'
import { WorkflowTimeline } from './WorkflowTimeline'
import { WorkflowAutoAdvance } from './WorkflowAutoAdvance'
import { WorkflowViewExport } from './WorkflowViewExport'

export function WorkflowDetail({
  workflowId,
  onJobs
}: {
  workflowId: string
  /** The graph projection as each read returns it, for a caller that summarises the run. */
  onJobs?: (jobs: ConsoleWorkflowJob[]) => void
}) {
  const [jobs, setJobs] = useState<ConsoleWorkflowJob[]>([])
  const publishJobs = useEffectEvent((received: ConsoleWorkflowJob[]) => onJobs?.(received))
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const refresh = () => setRevision((value) => value + 1)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const read = revision > 0 ? refreshWorkflowGraph : readWorkflowGraph
        const result = await read(conversationFleetScope(), workflowId)
        if (result.workflow_id !== workflowId) {
          throw new Error('The server returned a different workflow identity.')
        }
        if (!cancelled) {
          setJobs(result.jobs)
          setError(null)
          publishJobs(result.jobs)
        }
      } catch (failure) {
        if (!cancelled) {
          setError(workflowErrorMessage(failure))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workflowId, revision])
  const keys = new Map(jobs.map((job) => [job.id, job.policy.workflow.key]))
  const nodes = jobs.map((job) => ({
    key: job.policy.workflow.key,
    title: job.title,
    actorType: job.actor_type,
    after: job.policy.workflow.after.map((id) => keys.get(id) ?? id),
    status: job.workflow_state,
    machine: job.machine,
    placement: job.policy.workflow.placement,
    conditions: {
      ...(job.policy.workflow.require_merged.length
        ? { require_merged: job.policy.workflow.require_merged }
        : {}),
      ...(job.policy.workflow.approval_ancestors.length
        ? { approval_ancestors: job.policy.workflow.approval_ancestors }
        : {}),
      ...(job.policy.workflow.skipped ? { skipped: job.policy.workflow.skipped } : {}),
      ...(job.blockers.length ? { blockers: job.blockers } : {})
    }
  }))
  const selected = jobs.find((job) => job.policy.workflow.key === selectedKey) ?? jobs[0]
  const fleetConversation = jobs.some(
    (job) => job.policy.workflow.placement !== 'local' && !!job.policy.workflow.source
  )
  const graph = (
    <WorkflowGraph
      nodes={nodes}
      selectedKey={selected?.policy.workflow.key ?? null}
      onSelect={setSelectedKey}
    />
  )
  const inspector = selected && (
    <WorkflowInspector
      key={selected.id}
      job={selected}
      workflowId={workflowId}
      onRefresh={refresh}
    />
  )
  return (
    <section className="space-y-4">
      {!fleetConversation && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-mono text-sm">{workflowId}</h2>
          <Button size="sm" variant="outline" disabled={loading} onClick={refresh}>
            <RefreshCw />
            {translate('consoleWorkflows.refreshWorkflow', 'Refresh workflow')}
          </Button>
        </div>
      )}
      <WorkflowError message={error} />
      {error && !!jobs.length && (
        <p className="text-xs text-muted-foreground">
          {translate('consoleWorkflows.lastReceived', 'Showing the last received server view.')}
        </p>
      )}
      {loading && (
        <p className="text-sm text-muted-foreground">
          {translate('consoleWorkflows.loadingWorkflow', 'Loading workflow…')}
        </p>
      )}
      <Tabs defaultValue="graph" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="graph">
              {fleetConversation
                ? translate('consoleWorkflows.workAndLogsTab', 'Work and logs')
                : translate('consoleWorkflows.graphTab', 'Graph')}
            </TabsTrigger>
            <TabsTrigger value="timeline">
              {translate('consoleWorkflows.timeline', 'Timeline')}
            </TabsTrigger>
          </TabsList>
          {fleetConversation && (
            <Button size="sm" variant="outline" disabled={loading} onClick={refresh}>
              <RefreshCw />
              {translate('consoleWorkflows.refreshWorkflow', 'Refresh workflow')}
            </Button>
          )}
        </div>
        <TabsContent value="graph" className="space-y-4">
          {fleetConversation ? (
            <>
              <WorkflowSelect
                label={translate('consoleWorkflows.selectedStage', 'Stage')}
                value={selected?.policy.workflow.key ?? ''}
                onChange={setSelectedKey}
                options={jobs.map((job) => ({
                  value: job.policy.workflow.key,
                  label: `${job.title} · ${job.workflow_state}`
                }))}
              />
              {inspector}
              <details className="space-y-3">
                <summary className="cursor-pointer text-sm font-medium">
                  {translate('consoleWorkflows.workflowDetails', 'Workflow details')}
                </summary>
                <p className="font-mono text-xs text-muted-foreground">{workflowId}</p>
                {graph}
              </details>
            </>
          ) : (
            <>
              {!loading && !error && !jobs.length ? (
                <p className="text-sm text-muted-foreground">
                  {translate('consoleWorkflows.noJobs', 'No jobs returned for this workflow.')}
                </p>
              ) : (
                graph
              )}
              {inspector}
            </>
          )}
        </TabsContent>
        <TabsContent value="timeline" className="space-y-3">
          {jobs.length ? (
            <div
              className="grid gap-4 overflow-x-auto"
              style={{ gridTemplateColumns: `repeat(${jobs.length}, minmax(16rem, 1fr))` }}
            >
              {jobs.map((job) => (
                <section
                  key={job.id}
                  aria-label={job.title}
                  className="space-y-2 rounded-lg border border-border p-3"
                >
                  <h3 className="text-sm font-medium">{job.title}</h3>
                  <WorkflowTimeline
                    jobId={job.id}
                    replay={job.policy.workflow.placement === 'local'}
                  />
                </section>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {translate(
                'consoleWorkflows.selectTimelineJob',
                'Load a workflow job to view its server events.'
              )}
            </p>
          )}
        </TabsContent>
      </Tabs>
      {!loading && !error && <WorkflowViewExport view={{ workflow_id: workflowId, jobs }} />}
      {jobs.some((job) => job.policy.workflow.placement === 'local') && (
        <WorkflowAutoAdvance workflowId={workflowId} />
      )}
    </section>
  )
}
