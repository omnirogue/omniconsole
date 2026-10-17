import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type {
  BuildReviewPipelineSnapshot,
  BuildReviewWorkspaceHoldItem
} from '../../../../shared/build-review-pipeline'
import { BuildReviewOpenTerminalButton } from './BuildReviewOpenTerminalButton'
import { BuildReviewTechnicalDetails } from './BuildReviewTechnicalDetails'

function terminalText(item: BuildReviewWorkspaceHoldItem): string {
  return item.role === 'builder'
    ? translate('buildReview.hold.builderTerminal', "The builder's terminal is still open.")
    : item.role === 'reviewer'
      ? translate('buildReview.hold.reviewerTerminal', "A reviewer's terminal is still open.")
      : translate(
          'buildReview.hold.agentTerminal',
          'An agent terminal from that run is still open.'
        )
}

/**
 * Why: Release can close only a terminal the run still owns; any other one frees the workspace
 * the moment the person closes it, and saying so is the whole way out.
 */
function itemHint(item: BuildReviewWorkspaceHoldItem): string | null {
  return item.kind === 'terminal-open' && !item.releasable
    ? translate('buildReview.hold.closeToFree', 'Close it to free the workspace.')
    : null
}

function itemText(item: BuildReviewWorkspaceHoldItem): string {
  switch (item.kind) {
    case 'terminal-open':
      return terminalText(item)
    case 'maybe-working':
      return translate(
        'buildReview.hold.maybeWorking',
        'An agent from that run may still be working in its terminal. Close that terminal once it has stopped.'
      )
    case 'worker-running':
      return translate('buildReview.hold.workerRunning', 'An agent from that run has not finished.')
    case 'unverified':
      return translate('buildReview.hold.unverified', 'Part of that run could not be checked.')
    case 'run-active':
      return translate('buildReview.hold.runActive', 'That run is still going.')
    case 'other-window':
      return translate(
        'buildReview.hold.otherWindow',
        'Another OmniConsole window is using this workspace.'
      )
  }
}

/** A terminal the person can open, and close to free the workspace. */
const TERMINAL_KINDS: ReadonlySet<BuildReviewWorkspaceHoldItem['kind']> = new Set([
  'terminal-open',
  'maybe-working'
])

/**
 * Why the workspace is still reserved, in words, with the safe way out. Release workspace runs
 * the ordinary release for finished agents: it never stops an agent that may still be working
 * and keeps a terminal someone typed in, so it is offered only for a terminal the run still owns.
 * Any other terminal frees the workspace once it is closed; the host notices that by itself.
 */
export function BuildReviewWorkspaceHoldNotice({
  pipeline,
  pending,
  onRelease
}: {
  pipeline: BuildReviewPipelineSnapshot
  pending: boolean
  onRelease: () => void
}) {
  const hold = pipeline.workspaceHold
  if (!hold) {
    return null
  }
  const owned = hold.items.some(
    (item) => item.kind === 'run-active' || item.kind === 'other-window'
  )
  const releasable =
    !owned && hold.items.some((item) => item.kind === 'terminal-open' && item.releasable)
  const closable = hold.items.some((item) => TERMINAL_KINDS.has(item.kind) && item.terminalHandle)
  return (
    <section
      aria-label={translate('buildReview.hold.title', 'Workspace still reserved')}
      data-build-review-hold={hold.pipelineId === pipeline.id ? 'own' : 'earlier'}
      className="space-y-2 rounded-md border border-status-warning/40 p-3 text-sm"
    >
      <p className="font-medium">
        {hold.pipelineId === pipeline.id
          ? translate('buildReview.hold.own', 'This run still holds its workspace.')
          : translate(
              'buildReview.hold.earlier',
              'An earlier Build + Review run still holds this workspace.'
            )}
      </p>
      {hold.items.length > 0 && (
        <ul className="space-y-1 text-muted-foreground">
          {hold.items.map((item) => {
            const handle = TERMINAL_KINDS.has(item.kind) ? item.terminalHandle : null
            return (
              <li
                key={`${item.kind}:${item.dispatchId ?? ''}`}
                className="flex flex-wrap items-center gap-2"
              >
                <span>{itemText(item)}</span>
                {itemHint(item) && <span>{itemHint(item)}</span>}
                {handle && <BuildReviewOpenTerminalButton handle={handle} compact />}
              </li>
            )
          })}
        </ul>
      )}
      {!owned && !releasable && !closable && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'buildReview.hold.cannotRelease',
            'OmniConsole cannot confirm that this part of that run has stopped, so it keeps the workspace reserved. Use another workspace for now.'
          )}
        </p>
      )}
      {releasable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onRelease}>
            {translate('buildReview.hold.release', 'Release workspace')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {translate(
              'buildReview.hold.releaseHelp',
              'Closes what finished agents left open. An agent that is still working, or a terminal you typed in, is left alone.'
            )}
          </span>
        </div>
      )}
      <BuildReviewTechnicalDetails
        lines={[
          hold.pipelineId,
          hold.runId,
          ...hold.items.map((item) => item.dispatchId),
          ...hold.items.map((item) => item.terminalHandle)
        ]}
      />
    </section>
  )
}
