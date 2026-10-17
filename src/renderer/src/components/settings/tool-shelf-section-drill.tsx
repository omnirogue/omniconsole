import type React from 'react'
import { useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { companiesErrorMessage, useCompaniesRead } from '@/components/companies/companies-client'
import type { AccessSection } from '../../../../shared/console-access-contract'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { accessApi, errorLine } from './tool-shelf-shared'
import { targetIntent } from './tool-shelf-matrix-state'

/**
 * One row × one section, tool by tool.
 *
 * The matrix answers a section at a time because that is how a person thinks about
 * their work; this is where a review gets exact — which capability inside Finance
 * this person actually holds, and one override on that capability id alone.
 * Floor capabilities are listed and not togglable: they are nobody's to grant.
 */
export function ShelfSectionDrill({
  principal,
  section,
  digest,
  onChanged,
  onClose
}: {
  principal: string
  section: AccessSection
  digest: string
  onChanged: () => void
  onClose: () => void
}): React.JSX.Element {
  const shelf = useCompaniesRead(
    () => accessApi().person({ ref: principal }),
    `access:person:${principal}`
  )
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const held = useMemo(
    () => new Set((shelf.data?.capabilities ?? []).map((row) => row.id)),
    [shelf.data]
  )

  async function toggle(id: string, isOn: boolean): Promise<void> {
    if (!reason.trim()) {
      setNotice(
        translate('toolShelf.reasonFirst', 'Give one reason for this change — it is recorded.')
      )
      return
    }
    const { change } = targetIntent(id, isOn, shelf.data?.overrides, digest, reason.trim())
    setBusy(true)
    setNotice(null)
    try {
      const result = await accessApi().change({ ref: principal, change })
      if (!result.ok) {
        setNotice(result.error.message)
        return
      }
      shelf.reload()
      onChanged()
    } catch (error) {
      setNotice(companiesErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded border p-3" data-testid="tool-shelf-drill">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-medium">
          {translate('toolShelf.drillTitle', '{{section}} · {{principal}}', {
            section: section.label,
            principal
          })}
        </h4>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {translate('toolShelf.close', 'Close')}
        </Button>
      </div>
      <div className="flex max-w-md flex-col gap-1">
        <Label htmlFor="tool-shelf-drill-reason" className="text-xs">
          {translate('toolShelf.reason', 'Reason (recorded in the audit ledger)')}
        </Label>
        <Input
          id="tool-shelf-drill-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {shelf.loading && !shelf.data ? (
        <p className="text-sm text-muted-foreground">
          {translate('toolShelf.loading', 'Loading…')}
        </p>
      ) : null}
      {shelf.error ? (
        <p className="text-sm text-destructive" role="alert">
          {errorLine(shelf.error)}
        </p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {section.capabilities.map((capability) => {
          const isOn = held.has(capability.id)
          const floored = capability.hard_denied === true
          return (
            <li key={capability.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-xs">{capability.id}</span>
              <span className="text-xs text-muted-foreground">
                {capability.read_only
                  ? translate('toolShelf.read', 'read')
                  : translate('toolShelf.write', 'write')}
              </span>
              <span className="rounded border px-1 text-xs">
                {floored
                  ? translate('toolShelf.cellFloor', 'Floor')
                  : isOn
                    ? translate('toolShelf.cellOn', 'On')
                    : translate('toolShelf.cellOff', 'Off')}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || floored}
                aria-label={translate('toolShelf.toolToggle', 'Toggle {{capability}}', {
                  capability: capability.id
                })}
                onClick={() => void toggle(capability.id, isOn)}
              >
                {isOn
                  ? translate('toolShelf.turnOff', 'Turn off')
                  : translate('toolShelf.turnOn', 'Turn on')}
              </Button>
            </li>
          )
        })}
      </ul>
      {notice ? (
        <p className="text-sm" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  )
}
