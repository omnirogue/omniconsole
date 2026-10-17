import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { NativeChatCopyButton } from '../native-chat/NativeChatCopyButton'
import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../../../../shared/ansi-escape-sequences'
import type { LocalWorkflowReadCallResult } from '../../../../shared/local-workflow-rpc'
import type { LocalWorkflowCallView } from '../../../../shared/local-workflow-view'
import { workflowCallActivity, type WorkflowActivityEntry } from './workflow-call-activity'
import { workflowErrorText, workflowErrorWasTranslated } from './workflow-error-text'

const DISPLAY_LIMIT = 64_000

function CapturedStream({ name, raw, search }: { name: string; raw: string; search: string }) {
  const text = stripAnsiEscapeSequences(raw).replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
  const retained = text.slice(-DISPLAY_LIMIT)
  const matching = retained
    .split('\n')
    .filter((line) => line.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  return (
    <section className="space-y-1.5" aria-label={name}>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{name}</span>
        {retained ? (
          <NativeChatCopyButton
            text={retained}
            label={translate('localWorkflow.copyStream', 'Copy {{name}}', { name })}
          />
        ) : null}
        {text.length > DISPLAY_LIMIT && (
          <span>
            {translate('localWorkflow.run.logTail', 'last {{limit}} characters', {
              limit: DISPLAY_LIMIT.toLocaleString()
            })}
          </span>
        )}
        {search && (
          <span>
            {translate('localWorkflow.matchingLines', '{{count}} matching lines', {
              count: matching.length
            })}
          </span>
        )}
      </div>
      <pre
        className="max-h-80 overflow-auto scrollbar-sleek whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs"
        tabIndex={0}
      >
        {search
          ? matching.join('\n') || translate('localWorkflow.noMatches', 'No matches.')
          : retained || translate('localWorkflow.run.noLogs', 'Nothing captured.')}
      </pre>
    </section>
  )
}

/** Search plus both captured streams, as the host recorded them. */
function RawOutput({ logs }: { logs: LocalWorkflowReadCallResult }) {
  const [search, setSearch] = useState('')
  return (
    <div className="space-y-3">
      <Input
        type="search"
        value={search}
        className="h-8 text-xs"
        aria-label={translate('localWorkflow.searchCapturedOutput', 'Search captured output')}
        placeholder={translate('localWorkflow.run.searchLogs', 'Search logs…')}
        onChange={(event) => setSearch(event.target.value)}
      />
      <CapturedStream name="stdout" raw={logs.stdout} search={search} />
      <CapturedStream name="stderr" raw={logs.stderr} search={search} />
    </div>
  )
}

function entryLabel(kind: WorkflowActivityEntry['kind']): string {
  switch (kind) {
    case 'tool':
      return translate('localWorkflow.activity.kindTool', 'Tool')
    case 'message':
      return translate('localWorkflow.activity.kindMessage', 'Wrote')
    case 'thinking':
      return translate('localWorkflow.activity.kindThinking', 'Thought')
    case 'problem':
      return translate('localWorkflow.activity.kindProblem', 'Problem')
  }
}

/** What the agent did, step by step: tools, messages and reasoning instead of raw events. */
function ActivityList({ entries }: { entries: readonly WorkflowActivityEntry[] }) {
  return (
    <ol
      aria-label={translate('localWorkflow.activity.list', 'Activity')}
      className="max-h-96 space-y-1.5 overflow-y-auto scrollbar-sleek rounded-md border bg-muted/20 p-3 text-xs"
      tabIndex={0}
    >
      {entries.map((entry) => (
        <li key={entry.step} className="flex gap-2" data-activity-kind={entry.kind}>
          <span className="w-14 shrink-0 text-[11px] text-muted-foreground">
            {entryLabel(entry.kind)}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 whitespace-pre-wrap break-words',
              entry.kind === 'tool' && 'font-mono text-[11px]',
              entry.kind === 'thinking' && 'text-muted-foreground italic',
              entry.kind === 'problem' && 'text-destructive'
            )}
          >
            {entry.kind === 'problem' ? workflowErrorText(entry.text, 'details') : entry.text}
          </span>
        </li>
      ))}
    </ol>
  )
}

/**
 * One agent's Details, loaded on demand; never on the main path. Streamed JSON output reads as
 * an activity list, with the raw capture one toggle away; output that is not a stream (older
 * envelopes, a worker's terminal) shows as captured.
 */
export function LocalWorkflowCallInspector({
  call,
  logs
}: {
  call: LocalWorkflowCallView
  logs: LocalWorkflowReadCallResult
}) {
  const [rawOpen, setRawOpen] = useState(false)
  const activity = useMemo(
    () => workflowCallActivity(call.agent, stripAnsiEscapeSequences(logs.stdout)),
    [call.agent, logs.stdout]
  )
  return (
    <section
      className="space-y-3"
      aria-label={translate('localWorkflow.run.callDetailsFor', 'Details for {{name}}', {
        name: call.modelLabel ?? call.seatLabel
      })}
    >
      <p className="font-mono text-[11px] text-muted-foreground">
        {call.model}
        {call.effort ? ` · ${call.effort}` : ''}
        {call.attempt > 1
          ? ` · ${translate('localWorkflow.run.attempt', 'try {{attempt}}', {
              attempt: call.attempt
            })}`
          : ''}
      </p>
      {call.error && workflowErrorWasTranslated(call.error) ? (
        <p className="break-words font-mono text-[11px] text-muted-foreground">
          {translate('localWorkflow.run.reportedError', 'Reported: {{error}}', {
            error: call.error
          })}
        </p>
      ) : null}
      {logs.outputTruncated && (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'localWorkflow.captureIncomplete',
            'Captured output exceeded its limit. This capture is incomplete.'
          )}
        </p>
      )}
      {activity.length ? (
        <>
          <ActivityList entries={activity} />
          <button
            type="button"
            aria-expanded={rawOpen}
            className="inline-flex items-center gap-0.5 rounded-sm text-[11px] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            onClick={() => setRawOpen(!rawOpen)}
          >
            {translate('localWorkflow.run.rawOutput', 'Raw output')}
            <ChevronRight
              aria-hidden="true"
              className={cn('size-3 transition-transform', rawOpen && 'rotate-90')}
            />
          </button>
          {rawOpen ? <RawOutput logs={logs} /> : null}
        </>
      ) : (
        <RawOutput logs={logs} />
      )}
    </section>
  )
}
