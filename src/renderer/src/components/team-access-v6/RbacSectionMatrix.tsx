import { useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate as t } from '@/i18n/i18n'
import { companiesData, useCompaniesRead } from '../companies/companies-client'
import type {
  AccessSectionSummary,
  ConsoleAccessApi,
  PrincipalSummary,
  SectionAccess
} from '../../../../shared/console-access-contract'
import { shelfDigest } from '../../../../shared/console-access-contract'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Badge } from '../ui/badge'
import { accessApi, errorLine } from '../settings/tool-shelf-shared'
import {
  cellFor,
  cellIntent,
  cellIsChangeable,
  orderedPrincipals
} from '../settings/tool-shelf-matrix-state'

// The desktop exposes set_access and set_access_bulk through its signed Tool Shelf bridge.
const set_access: ConsoleAccessApi['change'] = (args) => accessApi().change(args)
const set_access_bulk: ConsoleAccessApi['bulk'] = (args) => accessApi().bulk(args)
const ACCESSES: readonly SectionAccess[] = ['read', 'write']

function roleOf(principal: PrincipalSummary): string {
  return principal.role || principal.agent_role || t('rbac.noRole', 'Unreported')
}

function accessLabel(access: SectionAccess): string {
  return access === 'read' ? t('toolShelf.read', 'Read') : t('toolShelf.write', 'Write')
}

export function RbacSectionMatrix(): React.JSX.Element {
  const people = useCompaniesRead(() => accessApi().people(), 'rbac:people')
  const catalogue = useCompaniesRead(() => accessApi().sections(), 'rbac:sections')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const reasonId = useId()
  const principals = orderedPrincipals(people.data?.principals ?? [])
  const sections = people.data?.sections ?? catalogue.data?.sections ?? []
  const digest = people.data?.digest ?? ''
  const needle = query.trim().toLowerCase()
  const visible = principals.filter((principal) =>
    `${principal.principal} ${roleOf(principal)}`.toLowerCase().includes(needle)
  )
  const targets = visible.filter((principal) => selected.includes(principal.principal))
  const loading = people.loading || catalogue.loading
  const busy = saving || loading
  const coherent = !!people.data?.sections || catalogue.data?.digest === digest
  const editable = !busy && !people.error && coherent && shelfDigest.safeParse(digest).success
  const canSave = editable && reason.trim().length > 0 && reason.trim().length <= 500

  function refresh(): void {
    people.reload()
    catalogue.reload()
  }

  async function save(request: () => Promise<void>): Promise<void> {
    if (inFlight.current || !canSave) {
      return
    }
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      await request()
      toast.success(t('rbac.saved', 'Access change saved.'))
    } catch (failure) {
      setError(errorLine(failure))
    } finally {
      // A failed response can follow a committed write; reload before allowing another change.
      refresh()
      inFlight.current = false
      setSaving(false)
    }
  }

  function changeCell(
    principal: PrincipalSummary,
    section: AccessSectionSummary,
    access: SectionAccess
  ): void {
    const cell = cellFor(principal, section, access)
    if (!principal.sections?.[section.key] || !cellIsChangeable(cell)) {
      return
    }
    const { change } = cellIntent(cell, principal.overrides, digest, reason.trim())
    void save(async () => {
      companiesData(await set_access({ ref: principal.principal, change }))
    })
  }

  function columnReady(section: AccessSectionSummary, access: SectionAccess): boolean {
    return (
      canSave &&
      targets.length > 0 &&
      targets.length <= 200 &&
      targets.every(
        (principal) =>
          !!principal.sections?.[section.key] &&
          cellIsChangeable(cellFor(principal, section, access))
      )
    )
  }

  function changeColumn(section: AccessSectionSummary, access: SectionAccess, on: boolean): void {
    if (!columnReady(section, access)) {
      return
    }
    void save(async () => {
      const answer = companiesData(
        await set_access_bulk({
          change: {
            expected_digest: digest,
            reason: reason.trim(),
            dry_run: false,
            column: { section: section.key, access, on },
            principals: targets.map((principal) => principal.principal)
          }
        })
      )
      if (answer.dry_run) {
        throw new Error(
          t('rbac.previewOnly', 'The server returned a preview; no changes were saved.')
        )
      }
    })
  }

  return (
    <section
      className="space-y-3"
      aria-label={t('rbac.title', 'Team access matrix')}
      aria-busy={busy}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t('rbac.title', 'Team access matrix')}</h3>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={refresh}>
          {t('rbac.refresh', 'Refresh access')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'rbac.help',
          'WorkOS roles are read-only. Enter a reason to change effective section access. Select people or agents to update their access together, all or nothing.'
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-40 flex-1"
          aria-label={t('rbac.search', 'Search people, agents or roles')}
          placeholder={t('rbac.search', 'Search people, agents or roles')}
          value={query}
          disabled={busy}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected([])
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!editable || visible.length === 0}
          onClick={() =>
            setSelected(
              targets.length === visible.length ? [] : visible.map((row) => row.principal)
            )
          }
        >
          {targets.length === visible.length && targets.length > 0
            ? t('rbac.clear', 'Clear selection')
            : t('rbac.selectShown', 'Select shown')}
        </Button>
        <Badge variant="secondary">
          {t('rbac.selected', '{{count}} selected', { count: targets.length })}
        </Badge>
      </div>
      <div className="space-y-1">
        <Label htmlFor={reasonId}>{t('rbac.reason', 'Audit reason (required)')}</Label>
        <Input
          id={reasonId}
          value={reason}
          maxLength={500}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
          {saving ? t('rbac.saving', 'Saving access…') : t('toolShelf.loading', 'Loading…')}
        </p>
      )}
      {error || people.error || catalogue.error ? (
        <p role="alert" className="text-sm text-destructive">
          {error || errorLine(people.error || catalogue.error)}
        </p>
      ) : null}
      {!loading && people.data && !coherent && (
        <p role="alert" className="text-sm text-destructive">
          {t('rbac.stale', 'Access changed while loading. Refresh before editing.')}
        </p>
      )}
      {targets.length > 200 && (
        <p role="alert" className="text-sm text-destructive">
          {t('rbac.limit', 'Select at most 200 rows for one atomic update.')}
        </p>
      )}
      {!loading && people.data && (visible.length === 0 || sections.length === 0) && (
        <p className="text-sm text-muted-foreground">
          {t('rbac.empty', 'No matching rows or sections. Adjust search or refresh.')}
        </p>
      )}
      {people.data && sections.length > 0 && visible.length > 0 && (
        <div className="overflow-x-auto scrollbar-sleek rounded-md border">
          <table className="w-full border-collapse text-left text-xs">
            <caption className="sr-only">
              {t('rbac.caption', 'Effective read and write permissions by role and section')}
            </caption>
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th scope="col" rowSpan={2} className="p-3">
                  {t('rbac.principal', 'Person or agent')}
                </th>
                <th scope="col" rowSpan={2} className="p-3">
                  {t('rbac.role', 'Role')}
                </th>
                {sections.map((section) => (
                  <th key={section.key} scope="colgroup" colSpan={2} className="p-2 text-center">
                    {section.label}
                  </th>
                ))}
              </tr>
              <tr>
                {sections.flatMap((section) =>
                  ACCESSES.map((access) => (
                    <th key={`${section.key}:${access}`} scope="col" className="p-2 text-center">
                      <div>{accessLabel(access)}</div>
                      <div className="mt-1 flex justify-center gap-1">
                        {[true, false].map((on) => (
                          <Button
                            key={String(on)}
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={!columnReady(section, access)}
                            aria-label={t(
                              'rbac.columnAction',
                              '{{action}} {{access}} in {{section}} for {{count}} selected',
                              {
                                action: on ? t('rbac.grant', 'Grant') : t('rbac.deny', 'Deny'),
                                access: accessLabel(access),
                                section: section.label,
                                count: targets.length
                              }
                            )}
                            onClick={() => changeColumn(section, access, on)}
                          >
                            {on ? t('rbac.grant', 'Grant') : t('rbac.deny', 'Deny')}
                          </Button>
                        ))}
                      </div>
                    </th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {visible.map((principal) => (
                <tr key={principal.principal} className="border-t hover:bg-accent/50">
                  <th scope="row" className="p-3 font-normal">
                    <label className="flex items-center gap-2">
                      <Checkbox
                        checked={selected.includes(principal.principal)}
                        disabled={!editable}
                        aria-label={t('toolShelf.selectPerson', 'Select {{principal}}', {
                          principal: principal.principal
                        })}
                        onCheckedChange={(checked) =>
                          setSelected((current) =>
                            checked === true
                              ? [...new Set([...current, principal.principal])]
                              : current.filter((ref) => ref !== principal.principal)
                          )
                        }
                      />
                      <span>{principal.principal}</span>
                    </label>
                  </th>
                  <td className="p-3">
                    <Badge variant="outline">{roleOf(principal)}</Badge>
                  </td>
                  {sections.flatMap((section) =>
                    ACCESSES.map((access) => {
                      const cell = cellFor(principal, section, access)
                      const known = !!principal.sections?.[section.key]
                      const labels = {
                        floor: t('rbac.blocked', 'Policy blocked'),
                        empty: t('rbac.noTools', 'No tools'),
                        on: t('rbac.allowed', 'Allowed'),
                        partial: t('rbac.partial', 'Partial'),
                        off: t('rbac.off', 'Off')
                      }
                      const label = known ? labels[cell.state] : t('rbac.unknown', 'Unknown')
                      return (
                        <td key={`${section.key}:${access}`} className="p-2 text-center">
                          <Button
                            type="button"
                            size="sm"
                            variant={known && cell.state === 'on' ? 'secondary' : 'outline'}
                            className="w-full"
                            disabled={!canSave || !known || !cellIsChangeable(cell)}
                            aria-pressed={
                              known && cell.state === 'partial'
                                ? 'mixed'
                                : known && cell.state === 'on'
                            }
                            aria-label={`${principal.principal}: ${section.label} ${accessLabel(access)} — ${label}`}
                            onClick={() => changeCell(principal, section, access)}
                          >
                            {label}
                          </Button>
                          {known && (
                            <div className="mt-1 text-muted-foreground">
                              {cell.granted}/{cell.total}
                            </div>
                          )}
                        </td>
                      )
                    })
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
