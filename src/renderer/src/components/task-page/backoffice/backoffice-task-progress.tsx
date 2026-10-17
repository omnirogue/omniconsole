import { translate } from '@/i18n/i18n'
import { useEffect, useState } from 'react'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage,
  workflowWebLink
} from '@/lib/console-workflow-client'
import { WorkflowGraph } from '@/components/console-workflows/WorkflowGraph'
import { WorkflowJobsList } from '@/components/console-workflows/WorkflowJobsList'
import { WorkflowDetail } from '@/components/console-workflows/WorkflowDetail'
import type { WorkLifecycle } from '../../../../../shared/console-work-home-contract'

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : []
}
export function label(value: unknown, fallback = 'Not reported'): string {
  return typeof value === 'string' && value ? value : fallback
}
export function BackofficeTaskProgress({
  taskId,
  baseUrl,
  onOpenTask
}: {
  taskId: string
  baseUrl: string | null
  onOpenTask: (id: string) => void
}) {
  const [data, setData] = useState<WorkLifecycle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [workflowId, setWorkflowId] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false,
      busy = false
    const read = async () => {
      if (busy) {
        return
      }
      busy = true
      try {
        const value = workflowData(await consoleWorkflowApi().getTaskLifecycle({ taskId }))
        if (!disposed) {
          setData(value)
          setError(null)
        }
      } catch (reason) {
        if (!disposed) {
          setError(workflowErrorMessage(reason))
          setData(null)
        }
      } finally {
        busy = false
      }
    }
    void read()
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        void read()
      }
    }, 30_000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [taskId])
  const graph = record(data?.graph),
    edges = records(graph.edges),
    nodes = records(graph.nodes)
  const next = record(data?.next_action),
    owner = record(data?.owner)
  const selectedNode = nodes.find((node) => node.key === selected)
  return (
    <section
      className="space-y-3"
      aria-label={translate('unifiedWork.6e2e8081efd5', 'Workflow and history')}
    >
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {translate('unifiedWork.bd930d12eec1', 'Lifecycle unavailable:')}
          {error}
        </p>
      )}
      {data && (
        <>
          <dl className="space-y-1 text-xs">
            <div>
              {translate('unifiedWork.d7bbfed51fd5', 'Accountable owner:')}
              {label(owner.name, label(owner.id))}
            </div>
            <div>
              {translate('unifiedWork.75f03f30fb41', 'Current actors:')}{' '}
              {records(data.actors)
                .map((actor) => label(actor.id))
                .join(', ') || translate('unifiedWork.adadface0166', 'Not reported')}
            </div>
            <div>
              {translate('unifiedWork.5693e770dd67', 'Next:')}
              {label(next.label)} ·{' '}
              {Array.isArray(next.owners)
                ? next.owners.join(', ')
                : translate('unifiedWork.eacadfff5ed1', 'Actor not reported')}
            </div>
            <div>
              {translate('unifiedWork.3425d1086921', 'Reason:')}
              {label(next.reason)}
            </div>
          </dl>
          <h3 className="text-sm font-semibold">
            {translate('unifiedWork.a13e6ab32892', 'Workflow progress')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate('unifiedWork.c707ee4ecc24', 'Source:')}
            {label(graph.source)}
            {translate('unifiedWork.19377f4ab204', '· Execution mode:')}
            {label(data.execution_mode)}
            {translate('unifiedWork.dca164d2fc6e', '. Readiness comes from the server.')}
          </p>
          <WorkflowGraph
            nodes={nodes.map((node) => ({
              key: label(node.key),
              title: label(node.label),
              status: label(node.state),
              actorType: label(node.executor_kind),
              incoming: edges
                .filter((edge) => edge.to === node.key && edge.kind !== 'context')
                .map((edge) => ({
                  from: label(edge.from),
                  label: label(edge.condition, ''),
                  ...(typeof edge.selected === 'boolean' ? { selected: edge.selected } : {})
                })),
              after: edges
                .filter((edge) => edge.to === node.key && edge.kind !== 'context')
                .map((edge) => label(edge.from)),
              conditions: edges
                .filter((edge) => edge.to === node.key)
                .map((edge) => ({
                  condition: edge.condition,
                  selected: edge.selected,
                  state: edge.state
                }))
            }))}
            selectedKey={selected}
            onSelect={setSelected}
          />
          <ul className="space-y-1 text-xs">
            {edges.map((edge) => (
              <li key={`${label(edge.from)}:${label(edge.to)}:${label(edge.condition, '')}`}>
                {label(edge.from)} → {label(edge.to)} · {label(edge.condition, 'Dependency')}{' '}
                {edge.selected === true
                  ? translate('unifiedWork.9088360dd6d5', '· Selected branch')
                  : edge.selected === false
                    ? translate('unifiedWork.5498b6b7a01f', '· Not selected')
                    : ''}
              </li>
            ))}
          </ul>
          {selectedNode && (
            <div className="text-xs">
              {label(selectedNode.label)} · {label(selectedNode.state)}
              {typeof selectedNode.task_id === 'string' && (
                <button
                  className="ml-2 underline"
                  onClick={() => onOpenTask(String(selectedNode.task_id))}
                >
                  {translate('unifiedWork.6b5c9394cb7f', 'Open task')}
                </button>
              )}
            </div>
          )}
          <h3 className="text-sm font-semibold">
            {translate('unifiedWork.02cf062c1847', 'Waits and reminders')}
          </h3>
          {Array.isArray(data.waits) && !data.waits.length ? (
            <p className="text-xs text-muted-foreground">
              {translate('unifiedWork.edaf0c75fe36', 'No waits returned for this task.')}
            </p>
          ) : (
            records(data.waits).map((wait) => (
              <div
                key={label(wait.id, JSON.stringify(wait))}
                className="rounded-md border border-border p-2 text-xs"
              >
                <p>
                  {label(wait.reason, label(wait.label, label(wait.cause_kind, label(wait.kind))))}
                </p>
                <p>
                  {translate('unifiedWork.ad478f8e5337', 'Trigger:')}
                  {label(
                    wait.trigger_id,
                    label(record(wait.wake).trigger_kind, label(wait.source))
                  )}
                  {translate('unifiedWork.d0de81a8d29e', '· Reminder:')} {label(wait.reminder_id)}
                  {translate('unifiedWork.525b54f16314', '· Health:')}{' '}
                  {label(wait.health, label(wait.scheduler_health, 'Unknown'))}
                </p>
                <details>
                  <summary>{translate('unifiedWork.f05661860559', 'Saved wait details')}</summary>
                  <pre className="overflow-auto scrollbar-sleek whitespace-pre-wrap">
                    {JSON.stringify(wait, null, 2)}
                  </pre>
                </details>
              </div>
            ))
          )}
          {['attempts', 'sessions', 'evidence'].map((key) => (
            <details key={key}>
              <summary className="text-sm">
                {key} · {records(data[key]).length}
              </summary>
              <ul className="space-y-2 text-xs">
                {records(data[key]).map((item) => (
                  <li
                    key={label(item.id, label(item.ref, JSON.stringify(item)))}
                    className="rounded-md border border-border p-2"
                  >
                    <p>{label(item.title, label(item.id, label(item.ref)))}</p>
                    {workflowWebLink(typeof item.url === 'string' ? item.url : null) && (
                      <a
                        className="underline"
                        href={String(item.url)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {translate('unifiedWork.098c234bb535', 'Open evidence')}
                      </a>
                    )}
                    <pre className="overflow-auto scrollbar-sleek whitespace-pre-wrap">
                      {JSON.stringify(item, null, 2)}
                    </pre>
                  </li>
                ))}
              </ul>
            </details>
          ))}
          {Array.isArray(data.degraded) && data.degraded.length > 0 && (
            <p role="status" className="text-xs text-destructive">
              {translate('unifiedWork.8a22571ad31a', 'Partial lifecycle:')}{' '}
              {data.degraded
                .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
                .join(', ')}
            </p>
          )}
        </>
      )}
      <WorkflowJobsList taskId={taskId} onOpen={setWorkflowId} />
      {workflowId && <WorkflowDetail key={workflowId} workflowId={workflowId} />}
      {baseUrl && (
        <a
          className="text-xs underline"
          href={`${baseUrl}/board/${encodeURIComponent(taskId)}`}
          target="_blank"
          rel="noreferrer"
        >
          {translate('unifiedWork.77c370012d2d', 'Open this task in Work')}
        </a>
      )}
    </section>
  )
}
