import type React from 'react'
import { translate } from '@/i18n/i18n'
import type {
  AccessSectionSummary,
  PrincipalSummary,
  SectionAccess
} from '../../../../shared/console-access-contract'
import { Button } from '../ui/button'
import {
  cellFor,
  cellIsChangeable,
  overrideForRef,
  type CellState,
  type MatrixCell
} from './tool-shelf-matrix-state'

/**
 * Everybody's reach on one page: rows are people (humans first, then agent
 * roles), columns are the derived sections split into Read and Write.
 *
 * A cell is the hub's EFFECTIVE answer, not a checkbox this pane owns — "partial"
 * is a real and common state, and "floor" means the estate keeps those tools from
 * everyone, so it is shown and cannot be clicked at all rather than looking like
 * an ordinary off.
 */

const ACCESSES: readonly SectionAccess[] = ['read', 'write']

function stateWord(state: CellState): string {
  if (state === 'on') {
    return translate('toolShelf.cellOn', 'On')
  }
  if (state === 'off') {
    return translate('toolShelf.cellOff', 'Off')
  }
  if (state === 'partial') {
    return translate('toolShelf.cellPartial', 'Partial')
  }
  if (state === 'floor') {
    return translate('toolShelf.cellFloor', 'Floor')
  }
  return translate('toolShelf.cellEmpty', 'None')
}

function accessWord(access: SectionAccess): string {
  return access === 'read'
    ? translate('toolShelf.read', 'read')
    : translate('toolShelf.write', 'write')
}

function cellTone(state: CellState): string {
  if (state === 'on') {
    return 'border-primary font-medium'
  }
  if (state === 'partial') {
    return 'border-primary/40'
  }
  if (state === 'floor') {
    return 'border-dashed text-muted-foreground'
  }
  return 'text-muted-foreground'
}

function tooltipFor(cell: MatrixCell, principal: PrincipalSummary): string {
  const counts = translate('toolShelf.cellCounts', '{{granted}} of {{total}} tools', {
    granted: cell.granted,
    total: cell.total
  })
  const last = overrideForRef(principal.overrides, cell.ref)
  if (!last) {
    return counts
  }
  return `${counts} · ${translate(
    'toolShelf.cellLast',
    'last {{action}} by {{who}} {{when}} — {{reason}}',
    {
      action: last.action,
      who: last.issued_by ?? '—',
      when: last.updated_at ?? last.created_at ?? '—',
      reason: last.reason ?? '—'
    }
  )}`
}

function Cell({
  principal,
  section,
  access,
  busy,
  onCell
}: {
  principal: PrincipalSummary
  section: AccessSectionSummary
  access: SectionAccess
  busy: boolean
  onCell: (cell: MatrixCell) => void
}): React.JSX.Element {
  const cell = cellFor(principal, section, access)
  return (
    <button
      type="button"
      data-testid={`shelf-cell-${principal.principal}-${section.key}-${access}`}
      data-state={cell.state}
      className={`w-full rounded border px-2 py-1 text-xs ${cellTone(cell.state)}`}
      disabled={busy || !cellIsChangeable(cell)}
      title={tooltipFor(cell, principal)}
      aria-label={translate(
        'toolShelf.cellLabel',
        '{{access}} {{section}} for {{principal}}: {{state}}',
        {
          access: accessWord(access),
          section: section.label,
          principal: principal.principal,
          state: stateWord(cell.state)
        }
      )}
      onClick={() => onCell(cell)}
    >
      {stateWord(cell.state)}
    </button>
  )
}

export function ShelfMatrix({
  principals,
  sections,
  selected,
  busy,
  onSelect,
  onCell,
  onDrill,
  onPerson,
  onColumn
}: {
  principals: PrincipalSummary[]
  sections: AccessSectionSummary[]
  selected: string[]
  busy: boolean
  onSelect: (principal: string, on: boolean) => void
  onCell: (cell: MatrixCell) => void
  onDrill: (target: { principal: string; section: string }) => void
  onPerson: (principal: string) => void
  onColumn: (section: AccessSectionSummary, access: SectionAccess, on: boolean) => void
}): React.JSX.Element {
  if (sections.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {translate(
          'toolShelf.noSections',
          'This hub does not report tool sections yet — open a person to change their shelf one tool at a time.'
        )}
      </p>
    )
  }
  return (
    <div className="overflow-x-auto" data-testid="tool-shelf-matrix">
      <table className="w-full border-separate border-spacing-1 text-left text-xs">
        <thead>
          <tr>
            <th scope="col" className="align-bottom">
              {translate('toolShelf.personColumn', 'Person or agent')}
            </th>
            {sections.map((section) => (
              <th key={section.key} scope="col" colSpan={2} className="text-center">
                {section.label}
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col" />
            {sections.flatMap((section) =>
              ACCESSES.map((access) => (
                <th key={`${section.key}:${access}`} scope="col" className="align-top">
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-muted-foreground">{accessWord(access)}</span>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={translate(
                          'toolShelf.columnOnLabel',
                          'Turn on {{access}} {{section}} for everybody selected',
                          { access: accessWord(access), section: section.label }
                        )}
                        onClick={() => onColumn(section, access, true)}
                      >
                        {translate('toolShelf.columnOn', 'All on')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={translate(
                          'toolShelf.columnOffLabel',
                          'Turn off {{access}} {{section}} for everybody selected',
                          { access: accessWord(access), section: section.label }
                        )}
                        onClick={() => onColumn(section, access, false)}
                      >
                        {translate('toolShelf.columnOff', 'All off')}
                      </Button>
                    </div>
                  </div>
                </th>
              ))
            )}
          </tr>
        </thead>
        <tbody>
          {principals.map((principal) => (
            <tr key={principal.principal}>
              <th scope="row" className="whitespace-nowrap font-normal">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(principal.principal)}
                    disabled={busy}
                    aria-label={translate('toolShelf.selectPerson', 'Select {{principal}}', {
                      principal: principal.principal
                    })}
                    onChange={(event) => onSelect(principal.principal, event.target.checked)}
                  />
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() => onPerson(principal.principal)}
                  >
                    {principal.principal}
                  </button>
                </label>
                <span className="text-muted-foreground">
                  {translate('toolShelf.rowSummary', '{{count}} tools{{admin}}', {
                    count: principal.count ?? 0,
                    admin: principal.super_admin
                      ? ` · ${translate('toolShelf.superAdmin', 'super admin')}`
                      : ''
                  })}
                </span>
              </th>
              {sections.flatMap((section) =>
                ACCESSES.map((access) => (
                  <td key={`${section.key}:${access}`} className="align-middle">
                    <div className="flex items-center gap-1">
                      <Cell
                        principal={principal}
                        section={section}
                        access={access}
                        busy={busy}
                        onCell={onCell}
                      />
                      {access === 'write' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          aria-label={translate(
                            'toolShelf.drillLabel',
                            'Tools in {{section}} for {{principal}}',
                            { section: section.label, principal: principal.principal }
                          )}
                          onClick={() =>
                            onDrill({ principal: principal.principal, section: section.key })
                          }
                        >
                          {translate('toolShelf.drill', '⋯')}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                ))
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
