import { useMemo, useState } from 'react'
import { NativeChatMessageList } from '@/components/native-chat/NativeChatMessageList'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { downloadWorkflowExport } from '@/lib/console-workflow-client'
import { jobEvidenceTranscript } from '../../../../shared/console-job-transcript'
import { WorkflowError, WorkflowSelect } from './WorkflowFields'
import { WorkflowJobSavedLog } from './WorkflowJobSavedLog'
import { WorkflowTimeline } from './WorkflowTimeline'
import { useWorkflowJobEvidence } from './use-workflow-job-evidence'

type EvidenceProps = {
  jobId: string
  attempt?: number
  leaseGeneration?: number
  provider?: string | null
  initiallyOpen?: boolean
}

/** One evidence surface for a job in a workflow or a dispatched conversation. */
export function WorkflowJobEvidence(props: EvidenceProps) {
  const [open, setOpen] = useState(props.initiallyOpen ?? false)
  const [selected, setSelected] = useState('latest')
  const attempt = selected === 'latest' ? props.attempt : Number(selected)
  const generation = selected === 'latest' ? props.leaseGeneration : undefined
  const attemptSelector = props.attempt !== undefined && props.attempt > 1 && (
    <WorkflowSelect
      label={translate('consoleWorkflows.attempt', 'Attempt')}
      value={selected}
      onChange={setSelected}
      options={[
        { value: 'latest', label: translate('consoleWorkflows.latestAttempt', 'Latest attempt') },
        ...Array.from({ length: Math.min(props.attempt, 100) }, (_, index) => {
          const number = props.attempt! - index
          return { value: String(number), label: String(number) }
        })
      ]}
    />
  )
  return (
    <details
      open={open}
      className="rounded-md border border-border p-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        {translate('consoleWorkflows.sessionEvidence', 'Session transcript and logs')}
      </summary>
      {open && (
        <div className="mt-3 space-y-3">
          {!props.initiallyOpen && attemptSelector}
          <JobEvidenceContent
            key={`${props.jobId}:${attempt ?? 'latest'}:${generation ?? 'latest'}`}
            {...props}
            attempt={attempt}
            leaseGeneration={generation}
          />
          {props.initiallyOpen && attemptSelector}
        </div>
      )}
    </details>
  )
}

function JobEvidenceContent(props: EvidenceProps) {
  const evidence = useWorkflowJobEvidence(props)
  const { entries, page, error, loading, refresh } = evidence
  const transcript = useMemo(() => jobEvidenceTranscript(entries), [entries])
  const session = useMemo(
    () => ({
      messages: transcript.messages,
      status: 'ready' as const,
      sessionId: page?.session_id ?? null,
      agent: page?.provider ?? props.provider ?? 'agent',
      hasMore: false,
      loadingEarlier: false,
      loadEarlier: () => {},
      readPhase: 'ready' as const
    }),
    [transcript.messages, page?.session_id, page?.provider, props.provider]
  )
  const controls = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {page ? [page.host, page.provider, page.session_id].filter(Boolean).join(' · ') : null}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={loading} onClick={refresh}>
            {page?.has_more
              ? translate('consoleWorkflows.loadMoreEvidence', 'Load more')
              : translate('consoleWorkflows.refreshEvidence', 'Refresh logs')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!entries.length}
            onClick={() =>
              downloadWorkflowExport(
                JSON.stringify({ ...page, entries }, null, 2),
                'json',
                `${props.jobId}-evidence.json`
              )
            }
          >
            {translate('consoleWorkflows.downloadLoadedEvidence', 'Download loaded evidence')}
          </Button>
        </div>
      </div>
      <WorkflowError message={error} />
      {error && entries.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {translate('consoleWorkflows.lastReceived', 'Showing the last received server view.')}
        </p>
      )}
      {loading && (
        <p className="text-xs text-muted-foreground">
          {translate('consoleWorkflows.loadingEvidence', 'Loading session evidence…')}
        </p>
      )}
      {page && (
        <p className="text-xs text-muted-foreground">
          {page.has_more || transcript.pending > 0
            ? translate(
                'consoleWorkflows.moreEvidenceAvailable',
                'More session evidence is available. Load more to continue reading.'
              )
            : page.complete
              ? translate(
                  'consoleWorkflows.captureComplete',
                  'All captured session evidence is loaded.'
                )
              : translate(
                  'consoleWorkflows.capturePending',
                  'Showing received evidence. The runner has not confirmed the capture is complete.'
                )}
        </p>
      )}
    </>
  )
  return (
    <div className="space-y-3">
      {!props.initiallyOpen && controls}
      <Tabs defaultValue="transcript" className="space-y-3">
        <TabsList>
          <TabsTrigger value="transcript">
            {translate('consoleWorkflows.transcript', 'Transcript')}
          </TabsTrigger>
          <TabsTrigger value="session-log">
            {translate('consoleWorkflows.sessionLog', 'Session log')}
          </TabsTrigger>
          <TabsTrigger value="events">
            {translate('consoleWorkflows.eventLog', 'Event log')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="transcript">
          {transcript.messages.length > 0 ? (
            <div
              className={
                props.initiallyOpen
                  ? 'flex h-96 max-h-[40vh] min-h-0 flex-col overflow-hidden rounded-md border border-border'
                  : 'flex h-96 min-h-0 flex-col overflow-hidden rounded-md border border-border'
              }
            >
              <NativeChatMessageList
                session={session}
                isWorking={false}
                expandSignal={false}
                fontScale={1}
              />
            </div>
          ) : (
            !loading && (
              <p className="text-sm text-muted-foreground">
                {translate(
                  'consoleWorkflows.noCapturedTranscript',
                  'No conversation records have been received for this attempt yet.'
                )}
              </p>
            )
          )}
        </TabsContent>
        <TabsContent value="session-log" className="space-y-3">
          {entries.length > 0 ? (
            <pre
              aria-label={translate('consoleWorkflows.sessionLog', 'Session log')}
              className="scrollbar-sleek max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 font-mono text-xs"
            >
              {entries.map((entry) => `[${entry.at}] ${entry.kind}\n${entry.text}`).join('\n')}
            </pre>
          ) : (
            <WorkflowJobSavedLog jobId={props.jobId} attempt={props.attempt} />
          )}
        </TabsContent>
        <TabsContent value="events">
          <WorkflowTimeline jobId={props.jobId} replay placement="fleet" />
        </TabsContent>
      </Tabs>
      {props.initiallyOpen && controls}
    </div>
  )
}
