import type React from 'react'
import { useRef } from 'react'
import { translate } from '@/i18n/i18n'
import type { AccessTemplates } from '../../../../shared/console-access-contract'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import type { CsvPreview } from './tool-shelf-controller'
import type { ShelfCsvProblem } from './tool-shelf-csv'

/**
 * The bulk bar: one reason, then a template for the people who are ticked, a
 * whole column at a time from the matrix header, or the grid as a file.
 *
 * Every one of these can change many people at once, so they all carry the SAME
 * required reason, and the file route never writes on the first pass — it asks
 * the hub for the diff, shows it, and waits.
 */
export function ToolShelfBulkBar({
  reason,
  onReason,
  templates,
  selected,
  busy,
  onTemplate,
  onExport,
  onImport
}: {
  reason: string
  onReason: (value: string) => void
  templates: AccessTemplates
  selected: string[]
  busy: boolean
  onTemplate: (name: string) => void
  onExport: () => string
  onImport: (text: string) => void
}): React.JSX.Element {
  const file = useRef<HTMLInputElement | null>(null)
  const names = Object.keys(templates).sort()
  return (
    <div className="flex flex-col gap-2 rounded border p-3" data-testid="tool-shelf-bulk">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <Label htmlFor="tool-shelf-bulk-reason" className="text-xs">
            {translate('toolShelf.bulkReason', 'Reason for this bulk change')}
          </Label>
          <Input
            id="tool-shelf-bulk-reason"
            value={reason}
            onChange={(event) => onReason(event.target.value)}
          />
        </div>
        <label className="flex flex-col gap-1 text-xs">
          {translate('toolShelf.template', 'Template')}
          <select
            aria-label={translate('toolShelf.template', 'Template')}
            className="rounded border bg-background px-2 py-1 text-sm"
            defaultValue=""
            disabled={busy || names.length === 0}
            onChange={(event) => {
              const name = event.target.value
              event.target.value = ''
              if (name) {
                onTemplate(name)
              }
            }}
          >
            <option value="">
              {translate('toolShelf.templatePick', 'Apply to the ticked people…')}
            </option>
            {names.map((name) => (
              <option key={name} value={name}>
                {templates[name]?.label ?? name}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-muted-foreground">
          {translate('toolShelf.selectedCount', '{{count}} selected', { count: selected.length })}
        </span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => downloadCsv(onExport())}>
          {translate('toolShelf.exportCsv', 'Export CSV')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => file.current?.click()}>
          {translate('toolShelf.importCsv', 'Import CSV')}
        </Button>
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          aria-label={translate('toolShelf.importCsv', 'Import CSV')}
          onChange={(event) => {
            const chosen = event.target.files?.[0]
            event.target.value = ''
            if (chosen) {
              void chosen.text().then(onImport)
            }
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'toolShelf.bulkHelp',
          'A template rewrites the section rows of the people you tick. A column turns one section on or off for them — or for everybody, when nobody is ticked. An imported file is shown as a diff before anything is written.'
        )}
      </p>
    </div>
  )
}

function downloadCsv(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'tool-shelf.csv'
  link.click()
  URL.revokeObjectURL(url)
}

/** What the hub says the imported file would do, before it is allowed to do it. */
export function ToolShelfBulkDiff({
  preview,
  problems,
  busy,
  onApply,
  onDismiss
}: {
  preview: CsvPreview | null
  problems: ShelfCsvProblem[]
  busy: boolean
  onApply: () => void
  onDismiss: () => void
}): React.JSX.Element | null {
  if (!preview && problems.length === 0) {
    return null
  }
  return (
    <div className="flex flex-col gap-2 rounded border p-3" data-testid="tool-shelf-bulk-diff">
      {problems.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-destructive">
          {problems.map((problem) => (
            <li key={`${problem.line}:${problem.code}`}>
              {translate('toolShelf.csvProblem', 'Line {{line}}: {{what}} ({{detail}})', {
                line: problem.line,
                what: problemWord(problem.code),
                detail: problem.detail
              })}
            </li>
          ))}
        </ul>
      ) : null}
      {preview ? (
        <>
          <div className="text-sm font-medium">
            {translate('toolShelf.diffTitle', '{{count}} changes would be written', {
              count: preview.answer.diff.length || preview.changes.length
            })}
          </div>
          <ul className="flex flex-col gap-1 text-xs">
            {preview.answer.diff.map((row) => (
              // Why not the index: the hub writes one diff row per principal and
              // target, so that pair is the row's own identity.
              <li
                key={`${row.principal}:${row.section ?? ''}:${row.target ?? ''}:${row.action ?? ''}`}
              >
                {translate('toolShelf.diffRow', '{{principal}} · {{action}} {{target}}', {
                  principal: row.principal,
                  action: row.action ?? '—',
                  target: row.target ?? row.section ?? '—'
                })}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={onApply}>
              {translate('toolShelf.applyImport', 'Apply this import')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>
              {translate('toolShelf.discardImport', 'Discard')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}

function problemWord(code: ShelfCsvProblem['code']): string {
  if (code === 'header') {
    return translate('toolShelf.csvHeader', 'the header must be principal,section,read,write')
  }
  if (code === 'columns') {
    return translate('toolShelf.csvColumns', 'four columns are needed')
  }
  if (code === 'principal') {
    return translate('toolShelf.csvPrincipal', 'not a principal')
  }
  if (code === 'section') {
    return translate('toolShelf.csvSection', 'not a section key')
  }
  return translate('toolShelf.csvValue', 'read and write must be on or off')
}
