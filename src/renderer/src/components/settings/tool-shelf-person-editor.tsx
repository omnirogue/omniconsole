import type React from 'react'
import { useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { companiesErrorMessage, useCompaniesRead } from '@/components/companies/companies-client'
import type {
  AccessOverride,
  PeopleAccess,
  PersonShelf,
  ShelfChange
} from '../../../../shared/console-access-contract'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { CapabilityRows, accessApi, errorLine } from './tool-shelf-shared'

/**
 * One person's shelf, whole: their standing overrides, the form that writes one
 * more, and what the gateway actually lets them use.
 *
 * This is the DRILL-IN behind the matrix. The matrix answers "who may reach which
 * section"; this answers "and exactly which tools, from where, decided by whom" —
 * the question a review asks once a cell looks wrong. Its own module since the
 * matrix moved in beside it, so neither file carries the other's controls.
 */

function OverrideRow({
  override,
  onRemove,
  busy
}: {
  override: AccessOverride
  onRemove: (override: AccessOverride) => void
  busy: boolean
}): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span className="rounded border px-1 text-xs">{override.action}</span>
      <span>{override.capability}</span>
      {override.expires_at ? (
        <span className="text-xs text-muted-foreground">
          {override.expired
            ? translate('toolShelf.expired', 'expired')
            : translate('toolShelf.until', 'until {{when}}', { when: override.expires_at })}
        </span>
      ) : null}
      {override.reason ? (
        <span className="text-xs text-muted-foreground">— {override.reason}</span>
      ) : null}
      {override.issued_by ? (
        <span className="text-xs text-muted-foreground">
          {translate('toolShelf.by', 'by {{who}}', { who: override.issued_by })}
        </span>
      ) : null}
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRemove(override)}>
        {translate('toolShelf.remove', 'Remove')}
      </Button>
    </li>
  )
}

export function PersonShelfEditor({
  principal,
  people,
  onChanged
}: {
  principal: string
  people: PeopleAccess
  onChanged: () => void
}): React.JSX.Element {
  const shelf = useCompaniesRead(
    () => accessApi().person({ ref: principal }),
    `access:person:${principal}`
  )
  const [current, setCurrent] = useState<PersonShelf | null>(null)
  const [capability, setCapability] = useState('')
  const [reason, setReason] = useState('')
  const [op, setOp] = useState<'grant' | 'deny'>('grant')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const view = current ?? shelf.data
  const catalogueIds = useMemo(
    () =>
      people.catalogue.connectors.flatMap((connector) =>
        connector.capabilities.map((row) => row.id)
      ),
    [people]
  )

  async function apply(change: ShelfChange): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      const result = await accessApi().change({ ref: principal, change })
      if (!result.ok) {
        setNotice(result.error.message)
        return
      }
      setCurrent(result.data)
      setCapability('')
      setReason('')
      setNotice(
        change.op === 'remove'
          ? translate('toolShelf.removed', 'Override removed and the store updated.')
          : translate('toolShelf.saved', 'Saved: {{op}} {{capability}}. The store is updated.', {
              op: change.op,
              capability: change.capability
            })
      )
      onChanged()
    } catch (error) {
      setNotice(companiesErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="tool-shelf-person">
      {shelf.loading && !view ? (
        <p className="text-sm text-muted-foreground">
          {translate('toolShelf.loading', 'Loading…')}
        </p>
      ) : null}
      {shelf.error ? (
        <p className="text-sm text-destructive" role="alert">
          {errorLine(shelf.error)}
        </p>
      ) : null}
      {view ? (
        <>
          <div className="text-xs text-muted-foreground">
            {translate(
              'toolShelf.personCount',
              '{{count}} capabilities · {{companies}} · {{domains}}',
              {
                count: view.count ?? view.capabilities.length,
                companies: (view.companies ?? []).join(', ') || '—',
                domains: (view.domains ?? []).join(', ') || '—'
              }
            )}
            {view.store_synced === false ? (
              <span className="ml-2 text-destructive">
                {translate('toolShelf.unsynced', 'store not yet synced')}
              </span>
            ) : null}
          </div>
          <div>
            <h4 className="text-sm font-medium">
              {translate('toolShelf.overrides', 'Tool Shelf overrides')}
            </h4>
            {view.overrides.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {translate(
                  'toolShelf.noOverrides',
                  'None — everything comes from their role, company and domains.'
                )}
              </p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {view.overrides.map((override) => (
                  <OverrideRow
                    key={override.id}
                    override={override}
                    busy={busy}
                    onRemove={(row) =>
                      void apply({
                        op: 'remove',
                        override_id: row.id,
                        expected_digest: view.digest
                      })
                    }
                  />
                ))}
              </ul>
            )}
          </div>
          <form
            className="flex flex-col gap-2 rounded border p-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (!capability.trim() || !reason.trim() || busy) {
                return
              }
              void apply({
                op,
                capability: capability.trim(),
                reason: reason.trim(),
                expected_digest: view.digest
              })
            }}
          >
            <div className="text-sm font-medium">
              {translate('toolShelf.changeTitle', 'Change this shelf')}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs">
                {translate('toolShelf.action', 'Action')}
                <select
                  aria-label={translate('toolShelf.action', 'Action')}
                  className="rounded border bg-background px-2 py-1 text-sm"
                  value={op}
                  onChange={(event) => setOp(event.target.value === 'deny' ? 'deny' : 'grant')}
                >
                  <option value="grant">{translate('toolShelf.grant', 'Grant')}</option>
                  <option value="deny">{translate('toolShelf.deny', 'Deny')}</option>
                </select>
              </label>
              <div className="flex min-w-56 flex-1 flex-col gap-1">
                <Label htmlFor={`tool-shelf-capability-${principal}`} className="text-xs">
                  {translate('toolShelf.capability', 'Capability (id or glob)')}
                </Label>
                <Input
                  id={`tool-shelf-capability-${principal}`}
                  list="tool-shelf-catalogue"
                  value={capability}
                  placeholder={translate('toolShelf.capabilityExample', 'stripe_acme.read')}
                  onChange={(event) => setCapability(event.target.value)}
                />
                <datalist id="tool-shelf-catalogue">
                  {catalogueIds.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              </div>
              <div className="flex min-w-56 flex-1 flex-col gap-1">
                <Label htmlFor={`tool-shelf-reason-${principal}`} className="text-xs">
                  {translate('toolShelf.reason', 'Reason (recorded in the audit ledger)')}
                </Label>
                <Input
                  id={`tool-shelf-reason-${principal}`}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <Button
                type="submit"
                size="sm"
                disabled={busy || !capability.trim() || !reason.trim()}
              >
                {translate('toolShelf.save', 'Save')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {translate(
                'toolShelf.changeHelp',
                'A deny beats every grant. The estate floor (money moves, infrastructure destruction) cannot be granted to anyone, and a granted consequential action still needs approval.'
              )}
            </p>
          </form>
          {notice ? (
            <p className="text-sm" role="status">
              {notice}
            </p>
          ) : null}
          <div>
            <h4 className="text-sm font-medium">
              {translate('toolShelf.effective', 'Effective tools')}
            </h4>
            <CapabilityRows capabilities={view.capabilities} sources={view.sources} />
          </div>
        </>
      ) : null}
    </div>
  )
}
