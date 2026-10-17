import React, { useState } from 'react'
import { CircleCheck, GitMerge, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  findMergeWhenReadyBlockers,
  mergeWhenReadyStatus
} from '../../../../../shared/github/merge-when-ready-facts'
import { armMergeWhenReady, disarmMergeWhenReady } from './merge-when-ready-actions'
import {
  armOutcomeNotice,
  describeMergeHold,
  describeMergeWhenReadyBlockers,
  disarmOutcomeNotice,
  type MergeWhenReadyNotice
} from './merge-when-ready-copy'
import type { MergeWhenReadyState } from './use-merge-when-ready'

function showNotice(notice: MergeWhenReadyNotice): void {
  toast[notice.tone](notice.message)
}

/**
 * The PR's Merge when ready box as one button: on click it ticks the box (Sal's or Uma's OK
 * to ship) and the estate merge job merges once the required checks pass. Held PRs ask first.
 */
export function MergeWhenReadyControl({
  state,
  onMutated
}: {
  state: MergeWhenReadyState
  onMutated: () => void
}): React.JSX.Element | null {
  const [pending, setPending] = useState(false)
  const confirm = useConfirmationDialog()
  const { client, facts, number, refresh } = state

  if (state.error) {
    return (
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate" title={state.error}>
          {translate('mergeWhenReady.readFailed', "Couldn't check Merge when ready.")}
        </span>
        <Button type="button" variant="ghost" size="xs" onClick={refresh}>
          {translate('mergeWhenReady.retry', 'Retry')}
        </Button>
      </div>
    )
  }
  if (!client || !facts) {
    return null
  }
  const status = mergeWhenReadyStatus(facts)
  if (status.kind === 'not-open' || status.kind === 'no-box') {
    return null
  }
  const waitingOn = describeMergeWhenReadyBlockers(findMergeWhenReadyBlockers(facts))

  const run = async (action: () => Promise<MergeWhenReadyNotice & { changed: boolean }>) => {
    setPending(true)
    try {
      const { changed, ...notice } = await action()
      showNotice(notice)
      if (changed) {
        useAppStore.getState().recordFeatureInteraction('github-tasks')
        onMutated()
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('mergeWhenReady.writeFailed', "Couldn't update PR #{{number}}.", { number })
      )
    } finally {
      setPending(false)
      refresh()
    }
  }

  const handleArm = async (): Promise<void> => {
    if (pending) {
      return
    }
    // Why: only the holds shown in the confirm are lifted; one set since then stops the write.
    const liftHolds = status.kind === 'held' ? status.holds : []
    if (status.kind === 'held') {
      const confirmed = await confirm({
        title: translate('mergeWhenReady.liftTitle', 'Lift the hold on PR #{{number}}?', {
          number
        }),
        description: translate(
          'mergeWhenReady.liftDescription',
          'On hold: {{holds}}. Lifting removes the hold and turns on Merge when ready, so the merge job merges and deploys this PR once its checks pass.',
          { holds: status.holds.map(describeMergeHold).join('; ') }
        ),
        confirmLabel: translate('mergeWhenReady.liftConfirm', 'Lift hold and merge when ready')
      })
      if (!confirmed) {
        return
      }
    }
    await run(async () => {
      const outcome = await armMergeWhenReady(client, number, { liftHolds })
      return {
        ...armOutcomeNotice(outcome, number),
        changed: outcome.kind === 'armed' || outcome.kind === 'unverified'
      }
    })
  }

  const handleDisarm = async (): Promise<void> => {
    if (pending) {
      return
    }
    await run(async () => {
      const outcome = await disarmMergeWhenReady(client, number)
      return {
        ...disarmOutcomeNotice(outcome, number),
        changed: outcome.kind === 'disarmed' || outcome.kind === 'unverified'
      }
    })
  }

  const waitingLine = waitingOn ? (
    <p className="text-xs leading-snug text-muted-foreground">{waitingOn}</p>
  ) : null

  if (status.kind === 'armed') {
    return (
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 py-1 pr-1 pl-2.5 text-xs font-medium text-emerald-700 dark:text-emerald-200">
          <span className="flex min-w-0 items-center gap-1.5">
            <CircleCheck className="size-3.5 shrink-0" />
            {translate('mergeWhenReady.on', 'Merge when ready is on')}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={pending}
            onClick={() => void handleDisarm()}
          >
            {pending ? <LoaderCircle className="size-3 animate-spin" /> : null}
            {translate('mergeWhenReady.stop', 'Stop')}
          </Button>
        </div>
        {waitingLine}
      </div>
    )
  }

  return (
    <div className="grid gap-1.5">
      {status.kind === 'held' ? (
        <div className="flex items-start gap-2 text-xs">
          <Badge
            variant="outline"
            className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-200"
          >
            {translate('mergeWhenReady.held', 'Held')}
          </Badge>
          <span className="min-w-0 leading-snug text-muted-foreground">
            {status.holds.map(describeMergeHold).join('; ')}
          </span>
        </div>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={status.kind === 'held' ? 'outline' : 'default'}
            size="sm"
            className="w-full justify-center gap-2"
            disabled={pending}
            onClick={() => void handleArm()}
          >
            {pending ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <GitMerge className="size-3.5" />
            )}
            {translate('mergeWhenReady.arm', 'Merge when ready')}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64">
          {translate(
            'mergeWhenReady.armTooltip',
            'Ticks the Merge when ready box: your OK to ship. The merge job merges and deploys once the required checks pass.'
          )}
        </TooltipContent>
      </Tooltip>
      {waitingLine}
    </div>
  )
}
