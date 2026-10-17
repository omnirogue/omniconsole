import { useState, type ReactNode } from 'react'
import { PlanRowAction } from '@/components/session-team/PlanRowAction'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { translate as t } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { SessionChain } from '../../../../../shared/session-chain-types'
import {
  SessionDetails,
  type SessionDetailsSections,
  type SessionDetailsViewers
} from '../SessionDetails'
import type { SessionDetailsFacts } from '../session-details-facts'
import { openDoneWhenList } from '../use-done-when-list'
import { RunsOnMenu } from './RunsOnMenu'

/**
 * Each More datum opens its OWN viewer, and only when that datum exists. Receipts and verdicts
 * come from the chain, so they need one; the changed files are the workspace's own git status,
 * which a conversation has whether or not it ever set an outcome.
 */
export function SessionDetailsConnected({
  facts,
  chain,
  runsOnMenu,
  sections,
  onOpenOutcome
}: {
  facts: SessionDetailsFacts
  chain: SessionChain | null
  runsOnMenu?: ReactNode
  /** Surfaces the mount places around the facts (activity, files and links, context). */
  sections?: SessionDetailsSections
  onOpenOutcome?: () => void
}) {
  const [history, setHistory] = useState(false)
  // Why: the workspace is read when the link is pressed, not subscribed to on every render — the
  // details panel must not re-render on unrelated store ticks just to hold a viewer's address.
  const openFiles = (): void => {
    const state = useAppStore.getState()
    const worktreeId = facts.session.worktreeId
    const path = state.getKnownWorktreeById(worktreeId)?.path
    if (path) {
      state.openAllDiffs(worktreeId, path)
    }
  }
  const viewers: SessionDetailsViewers = {
    ...(chain?.outcomeSet
      ? {
          onOpenReceipts: () => {
            onOpenOutcome?.()
            openDoneWhenList(chain.id)
          },
          onOpenVerdicts: () => setHistory(true)
        }
      : {}),
    // Why: "7 changed ↗" must open those 7 files, not the run's output artifacts.
    ...(facts.more.files.count > 0 ? { onOpenFiles: openFiles } : {})
  }
  return (
    <>
      <SessionDetails
        facts={facts}
        runsOnMenu={runsOnMenu ?? <RunsOnMenu session={facts.session} label={facts.runsOn} />}
        viewers={viewers}
        sections={sections}
      />
      {history && chain && (
        <Dialog open onOpenChange={setHistory}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('upNext.verdictHistory', 'Verdicts')}</DialogTitle>
              <DialogDescription>
                {t(
                  'upNext.verdictHistoryHelp',
                  'Every verdict this chain consumed, with the seat and plan history behind it.'
                )}
              </DialogDescription>
            </DialogHeader>
            <PlanRowAction chain={chain} />
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
