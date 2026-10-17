import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { WorkflowProviderIcon as AgentIcon } from '@/lib/workflow-provider-icon'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { WorkflowMarkdown } from './WorkflowMarkdown'
import { WorkflowWebChecks } from './WorkflowWebChecks'
import type { LocalWorkflowCallView } from '../../../../shared/local-workflow-view'
import { callStateLabel } from './local-workflow-labels'
import {
  activityLine,
  CallElapsed,
  callEndedText,
  CallFooter,
  LiveTail,
  WorkflowCallDot,
  type WorkflowCallHandlers
} from './WorkflowCallBody'

function isActive(call: LocalWorkflowCallView): boolean {
  return call.state === 'running' || call.state === 'queued'
}

function isFailed(call: LocalWorkflowCallView): boolean {
  return call.state === 'failed' || call.state === 'unverifiable'
}

const QUIET_BUTTON =
  'inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'

/** One agent: who, on what, how long; opens to its live tail or result and its logs. */
function AgentRow({
  call,
  task,
  handlers
}: {
  call: LocalWorkflowCallView
  task?: string
  handlers: WorkflowCallHandlers
}) {
  const [open, setOpen] = useState(false)
  const name = call.modelLabel ?? call.seatLabel
  const active = isActive(call)
  return (
    <li className="py-2" data-call-id={call.id}>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-md text-left text-xs focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        onClick={() => setOpen(!open)}
      >
        <WorkflowCallDot call={call} />
        {call.agent ? <AgentIcon agent={call.agent} size={12} /> : null}
        <span className="shrink-0 font-medium">{name}</span>
        {task ? <span className="min-w-0 truncate text-muted-foreground">{task}</span> : null}
        <span className="sr-only">{callStateLabel(call)}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
          <CallElapsed call={call} />
        </span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90'
          )}
        />
      </button>
      {active && !open ? (
        <p className="mt-0.5 truncate pl-3.5 text-[11px] text-muted-foreground">
          {activityLine(call)}
        </p>
      ) : null}
      {isFailed(call) || call.state === 'cancelled' ? (
        <p
          className={cn(
            'mt-0.5 pl-3.5 text-[11px]',
            call.state === 'cancelled' ? 'text-muted-foreground' : 'text-destructive'
          )}
        >
          {callEndedText(call, name)}
        </p>
      ) : null}
      {open ? (
        <div className="mt-2 space-y-2 pl-3.5">
          {active ? <LiveTail call={call} /> : null}
          {call.state === 'completed' && call.resultMarkdown ? (
            <WorkflowMarkdown className="text-sm" content={call.resultMarkdown} />
          ) : null}
          {call.state === 'completed' ? <WorkflowWebChecks checks={call.webChecks} /> : null}
          <CallFooter call={call} {...handlers} />
        </div>
      ) : null}
    </li>
  )
}

/**
 * The agents behind a many-call stage (Discover's finders and verifiers). Working and failed
 * agents are listed while it runs; the rest stay one click away, each with its logs.
 */
export function WorkflowAgentList({
  calls,
  handlers,
  describe
}: {
  calls: readonly LocalWorkflowCallView[]
  handlers: WorkflowCallHandlers
  describe?: (call: LocalWorkflowCallView) => string | undefined
}) {
  const [open, setOpen] = useState<boolean>()
  const [showAll, setShowAll] = useState(false)
  if (!calls.length) {
    return null
  }
  // Waiting agents are only counted; a full round can queue dozens of them.
  const pinned = calls.filter((call) => call.state === 'running' || isFailed(call))
  const expanded = open ?? pinned.length > 0
  const shown = showAll || !pinned.length ? calls : pinned
  const working = calls.filter((call) => call.state === 'running').length
  const waiting = calls.filter((call) => call.state === 'queued').length
  const summary = [
    translate('localWorkflow.run.agentCount', 'Agents: {{count}}', { count: calls.length }),
    working
      ? translate('localWorkflow.run.agentsWorking', '{{count}} working', { count: working })
      : '',
    waiting
      ? translate('localWorkflow.run.agentsWaiting', '{{count}} waiting', { count: waiting })
      : ''
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        className={QUIET_BUTTON}
        onClick={() => setOpen(!expanded)}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn('size-3 transition-transform', expanded && 'rotate-90')}
        />
        {summary}
      </button>
      {expanded ? (
        <div className="mt-1 pl-4">
          <ul className="divide-y divide-border/60">
            {shown.map((call) => (
              <AgentRow key={call.id} call={call} task={describe?.(call)} handlers={handlers} />
            ))}
          </ul>
          {pinned.length > 0 && pinned.length < calls.length ? (
            <button type="button" className={QUIET_BUTTON} onClick={() => setShowAll(!showAll)}>
              {showAll
                ? translate('localWorkflow.run.showFewerAgents', 'Show only working and failed')
                : translate('localWorkflow.run.showAllAgents', 'Show all {{count}}', {
                    count: calls.length
                  })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
