import type React from 'react'
import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import type { PendingCell } from './tool-shelf-controller'

/**
 * What a click on a cell is about to write, before it writes it.
 *
 * One reason, always — the ledger is the only record of why somebody's reach
 * changed — and an expiry only where an expiry means anything, which is a grant.
 * The row named here is exactly the row the hub will be asked for: one override
 * on one section reference, never a silent fan-out over capability ids.
 */
export function ShelfCellDialog({
  pending,
  busy,
  onCancel,
  onApply
}: {
  pending: PendingCell
  busy: boolean
  onCancel: () => void
  onApply: (reason: string, expiresAt: string) => void
}): React.JSX.Element {
  const [reason, setReason] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const op = pending.intent.change.op
  const target = op === 'remove' ? pending.cell.ref : pending.intent.change.capability
  return (
    <form
      role="dialog"
      data-testid="tool-shelf-cell-dialog"
      aria-label={translate('toolShelf.cellDialog', 'Change one section for one principal')}
      className="flex flex-col gap-2 rounded border p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!reason.trim() || busy) {
          return
        }
        onApply(reason, expiresAt)
      }}
    >
      <div className="text-sm font-medium">
        {translate('toolShelf.cellDialogTitle', '{{op}} {{target}} for {{principal}}', {
          op,
          target,
          principal: pending.cell.principal
        })}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <Label htmlFor="tool-shelf-cell-reason" className="text-xs">
            {translate('toolShelf.reason', 'Reason (recorded in the audit ledger)')}
          </Label>
          <Input
            id="tool-shelf-cell-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        {op === 'grant' ? (
          <div className="flex min-w-40 flex-col gap-1">
            <Label htmlFor="tool-shelf-cell-expiry" className="text-xs">
              {translate('toolShelf.expiry', 'Expires (optional)')}
            </Label>
            <Input
              id="tool-shelf-cell-expiry"
              value={expiresAt}
              placeholder={translate('toolShelf.expiryExample', '2026-12-31')}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </div>
        ) : null}
        <Button type="submit" size="sm" disabled={busy || !reason.trim()}>
          {translate('toolShelf.apply', 'Apply')}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {translate('toolShelf.cancel', 'Cancel')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {op === 'remove'
          ? translate(
              'toolShelf.cellRemoveHelp',
              'This withdraws the standing row that decided this cell; its own reason stays in the ledger.'
            )
          : translate(
              'toolShelf.cellHelp',
              'One row is written against the whole section. A deny beats every grant, and the estate floor stays out of reach of both.'
            )}
      </p>
    </form>
  )
}
