import { translate as t } from '@/i18n/i18n'
import type { UpNextView } from '../../../../shared/up-next-types'
import { Notation } from './notation'
import { UpNextHeaderStatus } from './up-next-header-status'
import { runUpNextAttentionAction, upNextAttentionDoors } from './up-next-attention-actions'
import { retryFinishedSessionDisposition } from './finished-session-disposition'
import { ownPaneKey } from './up-next-chain-rules'

/**
 * "UP NEXT" with the notation chips, then the run's phase line when it has one. Rendered on
 * the rail UNDER the Now row (Sal, 2026-09-18: "confusing that Up next is before the Now"):
 * what is happening comes first, and this heading names what follows it.
 */
export function UpNextChainHeading({
  view,
  chainId,
  onOpenBlock,
  focusComposer
}: {
  view: UpNextView | null
  chainId: string | null
  onOpenBlock: (id: string) => void
  focusComposer: () => void
}): React.JSX.Element {
  return (
    <>
      <header
        className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1"
        data-up-next-heading
      >
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('upNext.title', 'Up next')}
        </h3>
        {view && <Notation view={view} onOpen={onOpenBlock} />}
      </header>
      {view && (
        <UpNextHeaderStatus
          header={view.header}
          onAction={(request) =>
            runUpNextAttentionAction(
              request,
              { ownPaneKey: ownPaneKey(view), chainId },
              upNextAttentionDoors(focusComposer)
            )
          }
          onRetryDisposition={chainId ? () => retryFinishedSessionDisposition(chainId) : undefined}
        />
      )}
    </>
  )
}
