import { useCallback, useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  companiesErrorMessage,
  useCompaniesRead,
  type AsyncRead
} from '@/components/companies/companies-client'
import type { BulkAnswer, BulkChange, BulkChangeRow } from '../../../../shared/console-access-bulk'
import type {
  AccessSectionSummary,
  AccessTemplates,
  PeopleAccess,
  PrincipalSummary,
  SectionAccess,
  SectionsAccess
} from '../../../../shared/console-access-contract'
import { accessApi } from './tool-shelf-shared'
import {
  cellIntent,
  orderedPrincipals,
  type CellIntent,
  type MatrixCell
} from './tool-shelf-matrix-state'
import {
  parseShelfCsv,
  serialiseShelfCsv,
  shelfCsvChanges,
  type ShelfCsvProblem
} from './tool-shelf-csv'

/**
 * The state behind the Tool Shelf matrix: what is selected, what is being
 * changed, and every call that changes it.
 *
 * Separated from the pane so the rules — one reason per change, a CSV import is
 * always dry-run first, a refusal is shown in the hub's own words and nothing is
 * repainted optimistically — are readable without reading a table of buttons.
 * Authority is never decided here: every call is judged again at the hub.
 */

export type PendingCell = { cell: MatrixCell; intent: CellIntent }
export type CsvPreview = { answer: BulkAnswer; changes: BulkChangeRow[] }
export type DrillTarget = { principal: string; section: string }

export type ShelfAdmin = {
  people: AsyncRead<PeopleAccess>
  sections: AsyncRead<SectionsAccess>
  principals: PrincipalSummary[]
  columns: AccessSectionSummary[]
  templates: AccessTemplates
  digest: string
  busy: boolean
  notice: string | null
  reason: string
  setReason: (value: string) => void
  selected: string[]
  toggleSelected: (principal: string, on: boolean) => void
  pending: PendingCell | null
  openCell: (cell: MatrixCell) => void
  closeCell: () => void
  applyCell: (reason: string, expiresAt: string) => Promise<void>
  applyColumn: (section: AccessSectionSummary, access: SectionAccess, on: boolean) => Promise<void>
  applyTemplate: (name: string) => Promise<void>
  exportCsv: () => string
  importCsv: (text: string) => Promise<void>
  preview: CsvPreview | null
  applyPreview: () => Promise<void>
  dismissPreview: () => void
  problems: ShelfCsvProblem[]
  drill: DrillTarget | null
  openDrill: (target: DrillTarget | null) => void
  person: string | null
  openPerson: (principal: string | null) => void
}

export function useShelfAdmin(): ShelfAdmin {
  const people = useCompaniesRead(() => accessApi().people(), 'access:people')
  const sections = useCompaniesRead(() => accessApi().sections(), 'access:sections')
  const [selected, setSelected] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingCell | null>(null)
  const [preview, setPreview] = useState<CsvPreview | null>(null)
  const [problems, setProblems] = useState<ShelfCsvProblem[]>([])
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const [person, setPerson] = useState<string | null>(null)

  const principals = useMemo(() => orderedPrincipals(people.data?.principals ?? []), [people.data])
  const columns = useMemo(
    () => people.data?.sections ?? sections.data?.sections ?? [],
    [people.data, sections.data]
  )
  const templates = people.data?.templates ?? sections.data?.templates ?? {}
  const digest = people.data?.digest ?? ''

  const toggleSelected = useCallback((principal: string, on: boolean) => {
    setSelected((rows) =>
      on ? [...new Set([...rows, principal])] : rows.filter((row) => row !== principal)
    )
  }, [])

  const overridesOf = useCallback(
    (principal: string) =>
      people.data?.principals.find((row) => row.principal === principal)?.overrides ?? [],
    [people.data]
  )

  const openCell = useCallback(
    (cell: MatrixCell) => {
      setNotice(null)
      setPending({
        cell,
        intent: cellIntent(cell, overridesOf(cell.principal), digest, 'preview')
      })
    },
    [digest, overridesOf]
  )

  const runBulk = useCallback(
    async (change: BulkChange): Promise<BulkAnswer | null> => {
      setBusy(true)
      setNotice(null)
      try {
        const result = await accessApi().bulk({ change })
        if (!result.ok) {
          setNotice(result.error.message)
          return null
        }
        if (!result.data.dry_run) {
          people.reload()
          setNotice(
            translate('toolShelf.bulkApplied', '{{count}} changes applied. The store is updated.', {
              count: result.data.changes.length
            })
          )
        }
        return result.data
      } catch (error) {
        setNotice(companiesErrorMessage(error))
        return null
      } finally {
        setBusy(false)
      }
    },
    [people]
  )

  const needReason = useCallback((): boolean => {
    if (reason.trim()) {
      return false
    }
    setNotice(
      translate('toolShelf.reasonFirst', 'Give one reason for this change — it is recorded.')
    )
    return true
  }, [reason])

  const applyCell = useCallback(
    async (cellReason: string, expiresAt: string): Promise<void> => {
      if (!pending) {
        return
      }
      const { change } = cellIntent(
        pending.cell,
        overridesOf(pending.cell.principal),
        digest,
        cellReason.trim(),
        expiresAt.trim() || undefined
      )
      setBusy(true)
      setNotice(null)
      try {
        const result = await accessApi().change({ ref: pending.cell.principal, change })
        if (!result.ok) {
          setNotice(result.error.message)
          return
        }
        setPending(null)
        people.reload()
        setNotice(
          translate('toolShelf.cellSaved', 'Saved: {{op}} {{target}} for {{principal}}.', {
            op: change.op,
            target: change.op === 'remove' ? change.override_id : change.capability,
            principal: pending.cell.principal
          })
        )
      } catch (error) {
        setNotice(companiesErrorMessage(error))
      } finally {
        setBusy(false)
      }
    },
    [digest, overridesOf, pending, people]
  )

  const applyColumn = useCallback(
    async (section: AccessSectionSummary, access: SectionAccess, on: boolean): Promise<void> => {
      if (needReason()) {
        return
      }
      // Why principals may be omitted: an unselected column means everybody, which
      // is the hub's own default for a column change.
      await runBulk({
        reason: reason.trim(),
        expected_digest: digest,
        column: { section: section.key, access, on },
        ...(selected.length > 0 ? { principals: selected } : {})
      })
    },
    [digest, needReason, reason, runBulk, selected]
  )

  const applyTemplate = useCallback(
    async (name: string): Promise<void> => {
      if (needReason()) {
        return
      }
      if (selected.length === 0) {
        setNotice(translate('toolShelf.pickPeople', 'Tick the people this template applies to.'))
        return
      }
      await runBulk({
        reason: reason.trim(),
        expected_digest: digest,
        template: name,
        principals: selected
      })
    },
    [digest, needReason, reason, runBulk, selected]
  )

  const importCsv = useCallback(
    async (text: string): Promise<void> => {
      if (needReason()) {
        return
      }
      const parsed = parseShelfCsv(text)
      setProblems(parsed.problems)
      setPreview(null)
      if (parsed.rows.length === 0) {
        setNotice(translate('toolShelf.csvEmpty', 'That file has no rows this shelf can read.'))
        return
      }
      const changes = shelfCsvChanges(parsed.rows)
      const answer = await runBulk({
        reason: reason.trim(),
        expected_digest: digest,
        dry_run: true,
        changes
      })
      if (answer) {
        setPreview({ answer, changes })
      }
    },
    [digest, needReason, reason, runBulk]
  )

  const applyPreview = useCallback(async (): Promise<void> => {
    if (!preview || needReason()) {
      return
    }
    const answer = await runBulk({
      reason: reason.trim(),
      expected_digest: digest,
      dry_run: false,
      changes: preview.changes
    })
    if (answer) {
      setPreview(null)
      setProblems([])
    }
  }, [digest, needReason, preview, reason, runBulk])

  const exportCsv = useCallback(() => serialiseShelfCsv(principals, columns), [columns, principals])

  return {
    people,
    sections,
    principals,
    columns,
    templates,
    digest,
    busy,
    notice,
    reason,
    setReason,
    selected,
    toggleSelected,
    pending,
    openCell,
    closeCell: () => setPending(null),
    applyCell,
    applyColumn,
    applyTemplate,
    exportCsv,
    importCsv,
    preview,
    applyPreview,
    dismissPreview: () => {
      setPreview(null)
      setProblems([])
    },
    problems,
    drill,
    openDrill: setDrill,
    person,
    openPerson: setPerson
  }
}
