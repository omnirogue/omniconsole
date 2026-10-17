import type React from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { errorLine } from './tool-shelf-shared'
import { useShelfAdmin } from './tool-shelf-controller'
import { ShelfMatrix } from './tool-shelf-matrix'
import { ShelfCellDialog } from './tool-shelf-cell-dialog'
import { ShelfSectionDrill } from './tool-shelf-section-drill'
import { ToolShelfBulkBar, ToolShelfBulkDiff } from './tool-shelf-bulk'
import { PersonShelfEditor } from './tool-shelf-person-editor'

/**
 * The super-admin half of the Tool Shelf, as a MATRIX: every principal a row,
 * every derived section two columns (Read and Write), and each cell the hub's own
 * effective answer.
 *
 * Why a grid and not a person at a time: the question a review actually asks is
 * "who can move money" or "who can reach the servers", and that is a COLUMN. One
 * person at a time made that question unanswerable without opening ten shelves,
 * which is how a stale grant survives. The single-person editor is still here —
 * it is the drill-in, one click away, for the exact tool-by-tool answer.
 *
 * Authority is not decided here. The hub refuses a reader who is not one of the
 * policy's super admins, in its own words, and this pane renders that refusal.
 */
export function EverybodysShelf(): React.JSX.Element {
  const admin = useShelfAdmin()
  const people = admin.people
  const drillSection =
    admin.drill && admin.sections.data
      ? (admin.sections.data.sections.find((row) => row.key === admin.drill?.section) ?? null)
      : null
  return (
    <section data-testid="tool-shelf-admin" className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">
        {translate('toolShelf.adminTitle', 'Everybody’s shelf (super admins)')}
      </h3>
      {people.loading ? (
        <p className="text-sm text-muted-foreground">
          {translate('toolShelf.loading', 'Loading…')}
        </p>
      ) : null}
      {people.error ? (
        <p className="text-sm text-destructive" role="alert">
          {errorLine(people.error)}
        </p>
      ) : null}
      {people.data ? (
        <>
          <p className="text-xs text-muted-foreground">
            {translate(
              'toolShelf.adminHelp',
              'Super admins: {{admins}}. Floor (never grantable): {{count}} capabilities.',
              {
                admins: people.data.super_admins.join(', '),
                count: people.data.hard_deny.length
              }
            )}
          </p>
          {admin.sections.error ? (
            <p className="text-xs text-destructive" role="alert">
              {errorLine(admin.sections.error)}
            </p>
          ) : null}
          <ToolShelfBulkBar
            reason={admin.reason}
            onReason={admin.setReason}
            templates={admin.templates}
            selected={admin.selected}
            busy={admin.busy}
            onTemplate={(name) => void admin.applyTemplate(name)}
            onExport={admin.exportCsv}
            onImport={(text) => void admin.importCsv(text)}
          />
          <ToolShelfBulkDiff
            preview={admin.preview}
            problems={admin.problems}
            busy={admin.busy}
            onApply={() => void admin.applyPreview()}
            onDismiss={admin.dismissPreview}
          />
          {admin.notice ? (
            <p className="text-sm" role="status">
              {admin.notice}
            </p>
          ) : null}
          {admin.pending ? (
            <ShelfCellDialog
              pending={admin.pending}
              busy={admin.busy}
              onCancel={admin.closeCell}
              onApply={(reason, expiresAt) => void admin.applyCell(reason, expiresAt)}
            />
          ) : null}
          <ShelfMatrix
            principals={admin.principals}
            sections={admin.columns}
            selected={admin.selected}
            busy={admin.busy}
            onSelect={admin.toggleSelected}
            onCell={admin.openCell}
            onDrill={admin.openDrill}
            onPerson={admin.openPerson}
            onColumn={(section, access, on) => void admin.applyColumn(section, access, on)}
          />
          {admin.drill && drillSection ? (
            <ShelfSectionDrill
              key={`${admin.drill.principal}:${drillSection.key}`}
              principal={admin.drill.principal}
              section={drillSection}
              digest={admin.digest}
              onChanged={people.reload}
              onClose={() => admin.openDrill(null)}
            />
          ) : null}
          {admin.person ? (
            <div className="flex flex-col gap-2 rounded border p-3">
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="text-sm font-medium">{admin.person}</h4>
                <Button variant="ghost" size="sm" onClick={() => admin.openPerson(null)}>
                  {translate('toolShelf.close', 'Close')}
                </Button>
              </div>
              <PersonShelfEditor
                key={admin.person}
                principal={admin.person}
                people={people.data}
                onChanged={people.reload}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
