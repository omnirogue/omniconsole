import { Fragment, useState, type ReactNode } from 'react'
import { ChevronRight, Loader2, RefreshCw, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useNow } from '@/hooks/use-now'
import { translate } from '@/i18n/i18n'
import { WorkflowMarkdown } from './WorkflowMarkdown'
import { WorkflowWebChecks } from './WorkflowWebChecks'
import type { LocalWorkflowReadCallResult } from '../../../../shared/local-workflow-rpc'
import type { LocalWorkflowCallView } from '../../../../shared/local-workflow-view'
import { LocalWorkflowCallInspector } from './LocalWorkflowCallInspector'
import {
  formatWorkflowElapsed,
  formatWorkflowTokens,
  workflowRouteName
} from './local-workflow-labels'
import { workflowErrorText } from './workflow-error-text'
import { liveTailSegments } from './workflow-live-tail'

export type WorkflowCallHandlers = {
  onReadCall?: (callId: string) => Promise<LocalWorkflowReadCallResult>
  /** Brings a worker's own terminal forward by its handle (working-agent calls carry one). */
  onOpenTerminal?: (handle: string) => Promise<void>
}

const DOT_CLASS: Record<LocalWorkflowCallView['state'], string> = {
  queued: 'border border-muted-foreground/50 bg-transparent',
  running: 'bg-status-info motion-safe:animate-pulse',
  completed: 'bg-status-success',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground/50',
  unverifiable: 'bg-status-warning'
}

/** A 6px state dot; the state is always also written somewhere nearby. */
export function WorkflowCallDot({ call }: { call?: Pick<LocalWorkflowCallView, 'state'> }) {
  return (
    <span
      aria-hidden="true"
      className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS[call?.state ?? 'queued'])}
    />
  )
}

function callTokens(call: LocalWorkflowCallView): number | undefined {
  const tokens = call.tokens ?? call.live?.tokens
  return tokens ? tokens.input + tokens.output : undefined
}

/** Leaf so the shared one-second clock re-renders only the digits. */
export function CallElapsed({ call }: { call: LocalWorkflowCallView }) {
  const running = call.state === 'running'
  const now = useNow(1_000, running)
  const startedAt = call.live?.startedAt ?? call.startedAt
  if (startedAt === undefined) {
    return null
  }
  const end = running ? now : (call.endedAt ?? now)
  // A ticking clock inside a live region would announce itself every second.
  return <span aria-hidden={running || undefined}>{formatWorkflowElapsed(end - startedAt)}</span>
}

/** Why a call waits: its provider account is busy (Codex, Grok), or every slot is taken. */
function waitingLine(call: LocalWorkflowCallView): string {
  if (call.live?.reason !== 'account') {
    return translate('localWorkflow.run.waitingSlot', 'Waiting for a free slot…')
  }
  return call.agent
    ? translate('localWorkflow.run.waitingAccount', 'Waiting for the {{account}} account…', {
        account: workflowRouteName(call.agent)
      })
    : translate('localWorkflow.run.waitingAnyAccount', 'Waiting for its account to be free…')
}

export function activityLine(call: LocalWorkflowCallView): string {
  if (call.live?.activity) {
    return call.live.activity
  }
  switch (call.live?.phase) {
    case 'waiting':
      return waitingLine(call)
    case 'starting':
      return translate('localWorkflow.run.starting', 'Starting…')
    case 'finishing':
      return translate('localWorkflow.run.finishing', 'Finishing…')
    case 'running':
      return translate('localWorkflow.run.thinking', 'Thinking…')
    case undefined:
      return call.state === 'queued'
        ? translate('localWorkflow.run.waitingToStart', 'Waiting to start…')
        : translate('localWorkflow.run.writing', 'Writing…')
  }
}

/** The streamed text with its light marks read: bold and headings in weight, code in mono. */
function LiveTailText({ tail }: { tail: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
      {liveTailSegments(tail).map((segment) =>
        segment.style === 'strong' ? (
          <strong key={segment.offset} className="font-medium text-foreground/80">
            {segment.text}
          </strong>
        ) : segment.style === 'code' ? (
          <code key={segment.offset} className="font-mono text-[0.9em]">
            {segment.text}
          </code>
        ) : (
          <Fragment key={segment.offset}>{segment.text}</Fragment>
        )
      )}
    </p>
  )
}

/** What an agent is doing right now and the last of what it is writing. */
export function LiveTail({ call }: { call: LocalWorkflowCallView }) {
  const tail = call.live?.tail?.trim()
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 aria-hidden="true" className="size-3 motion-safe:animate-spin" />
        <span className="truncate">{activityLine(call)}</span>
      </p>
      {tail ? (
        <div className="flex max-h-72 flex-col-reverse overflow-y-auto scrollbar-sleek">
          <LiveTailText tail={tail} />
        </div>
      ) : null}
    </div>
  )
}

/** A working agent's own terminal: opens the worker's terminal tab, and says why when it can't. */
function OpenCallTerminal({
  handle,
  onOpenTerminal
}: {
  handle: string
  onOpenTerminal: (handle: string) => Promise<void>
}) {
  const [opening, setOpening] = useState(false)
  const [failure, setFailure] = useState<string>()
  return (
    <>
      <button
        type="button"
        disabled={opening}
        className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
        onClick={async () => {
          setOpening(true)
          setFailure(undefined)
          try {
            await onOpenTerminal(handle)
          } catch (cause) {
            setFailure(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setOpening(false)
          }
        }}
      >
        <SquareTerminal aria-hidden="true" className="size-3" />
        {translate('localWorkflow.run.openTerminal', 'Open terminal')}
      </button>
      {failure ? (
        <span role="alert" className="basis-full font-sans text-xs text-destructive">
          {failure}
        </span>
      ) : null}
    </>
  )
}

/** elapsed · tokens · Details · Open terminal; the raw logs open underneath, loaded on demand. */
export function CallFooter({
  call,
  onReadCall,
  onOpenTerminal
}: WorkflowCallHandlers & { call: LocalWorkflowCallView }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState<LocalWorkflowReadCallResult>()
  const [failure, setFailure] = useState<string>()
  const load = async () => {
    if (!onReadCall) {
      return
    }
    setLoading(true)
    setFailure(undefined)
    try {
      setLoaded(await onReadCall(call.id))
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }
  // Older hosts still ship logs inside the view; newer ones load them on demand.
  const logs = loaded ?? {
    stdout: call.stdout,
    stderr: call.stderr,
    outputTruncated: call.outputTruncated
  }
  const tokens = callTokens(call)
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-muted-foreground">
        <CallElapsed call={call} />
        {tokens !== undefined ? (
          <span>
            {translate('localWorkflow.run.tokens', '{{amount}} tokens', {
              amount: formatWorkflowTokens(tokens)
            })}
          </span>
        ) : null}
        {/* A JEV ballot runs no process, so it has no logs to show. */}
        {call.seatId !== 'jev' && (
          <button
            type="button"
            aria-expanded={open}
            className="inline-flex items-center gap-0.5 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            onClick={() => {
              if (!open && !loaded) {
                void load()
              }
              setOpen(!open)
            }}
          >
            {translate('localWorkflow.run.details', 'Details')}
            <ChevronRight
              aria-hidden="true"
              className={cn('size-3 transition-transform', open && 'rotate-90')}
            />
          </button>
        )}
        {onOpenTerminal && call.terminalHandle ? (
          <OpenCallTerminal handle={call.terminalHandle} onOpenTerminal={onOpenTerminal} />
        ) : null}
      </div>
      {open && (
        <div className="space-y-2 pt-2">
          {onReadCall && (
            <div className="flex flex-wrap items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11px]"
                disabled={loading}
                onClick={() => void load()}
              >
                <RefreshCw
                  aria-hidden="true"
                  className={cn('size-3', loading && 'motion-safe:animate-spin')}
                />
                {translate('localWorkflow.run.refreshLogs', 'Refresh')}
              </Button>
            </div>
          )}
          {failure ? (
            <p role="alert" className="text-xs text-destructive">
              {failure}
            </p>
          ) : loading && !loaded ? (
            <p role="status" className="text-xs text-muted-foreground">
              {translate('localWorkflow.run.loadingLogs', 'Loading logs…')}
            </p>
          ) : (
            <LocalWorkflowCallInspector call={call} logs={logs} />
          )}
        </div>
      )}
    </div>
  )
}

/** Why a call has no result: stopped, or failed with the host's reason. */
export function callEndedText(call: LocalWorkflowCallView, subject: string): string {
  return call.state === 'cancelled'
    ? translate('localWorkflow.run.callStopped', '{{name}} was stopped before it finished.', {
        name: subject
      })
    : translate('localWorkflow.run.callFailed', "{{name}} didn't finish: {{reason}}", {
        name: subject,
        reason: call.error
          ? workflowErrorText(call.error)
          : translate('localWorkflow.run.noReason', 'no reason was reported.')
      })
}

/**
 * One agent's slot: live activity and streamed tail while it works, the result once accepted,
 * the error inline when it failed. The footer always offers elapsed, tokens and Details.
 */
export function WorkflowCallBody({
  call,
  subject,
  onReadCall,
  onOpenTerminal,
  children
}: WorkflowCallHandlers & {
  call?: LocalWorkflowCallView
  /** Who this is, for messages: "Grok 4.6". */
  subject: string
  /** The accepted result; defaults to the call's markdown. */
  children?: ReactNode
}) {
  if (!call) {
    return (
      <p className="text-sm text-muted-foreground">
        {translate('localWorkflow.run.notStarted', 'Not started yet.')}
      </p>
    )
  }
  return (
    <div className="space-y-3">
      {call.state === 'completed' ? (
        (children ??
        (call.resultMarkdown ? (
          <WorkflowMarkdown className="text-sm" content={call.resultMarkdown} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {translate('localWorkflow.run.emptyResult', 'Finished without any text.')}
          </p>
        )))
      ) : call.state === 'running' || call.state === 'queued' ? (
        <LiveTail call={call} />
      ) : (
        <p
          className={cn(
            'text-sm',
            call.state === 'cancelled' ? 'text-muted-foreground' : 'text-destructive'
          )}
        >
          {callEndedText(call, subject)}
        </p>
      )}
      {call.state === 'completed' ? <WorkflowWebChecks checks={call.webChecks} /> : null}
      <CallFooter call={call} onReadCall={onReadCall} onOpenTerminal={onOpenTerminal} />
    </div>
  )
}
