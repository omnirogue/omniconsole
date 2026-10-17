import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import type { LedgerPublicRow } from '@/lib/session-ledger-types'
import { openSessionLedgerConsole } from '@/lib/session-ledger-console'
import { useSessionLedger } from '@/store/session-ledger-store'
import { collisionPeerName } from './collision-peers'

// Why: a stable snapshot; a fresh [] per selector call would re-render forever.
const noRows: LedgerPublicRow[] = []

export function CollisionBanner({ store = useSessionLedger }: { store?: typeof useSessionLedger }) {
  const collision = store((state) => state.collisions[0])
  const rows = store((state) => (state.live?.ok ? state.live.rows : noRows))
  if (!collision) {
    return null
  }
  const { peer, local } = collision
  const files = peer.shared_files?.slice(0, 3).map(basename).join(', ')
  // The server composes the reason; only a blank one falls back to naming the peer.
  const reason =
    peer.reason.trim() ||
    translate('sessionLedger.peerWorkingNearby', '{{name}} is working nearby', {
      name: collisionPeerName(peer, rows) ?? translate('sessionLedger.teammate', 'a teammate')
    })
  const message = files
    ? translate('sessionLedger.reasonWithFiles', '{{reason}} · {{files}}', { reason, files })
    : reason
  return (
    <div
      role="status"
      className="mx-2 mb-2 rounded-md border border-sidebar-border bg-sidebar px-2 py-2 text-sidebar-foreground"
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 break-words text-xs">{message}</p>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={translate('sessionLedger.dismiss', 'Dismiss collision notice')}
          onClick={() => store.getState().dismissCollision(local.ledgerId, peer.ledger_id)}
        >
          <X className="size-3" />
        </Button>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <Button variant="ghost" size="xs" onClick={() => openSessionLedgerConsole(peer.ledger_id)}>
          {translate('sessionLedger.openConsole', 'Open in console')}
        </Button>
        {local.repo ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void store.getState().muteRepo(local.repo!)}
          >
            {translate('sessionLedger.muteRepo', 'Mute this repo')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
