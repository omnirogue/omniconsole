import type { BulkChangeRow } from '../../../../shared/console-access-bulk'
import type {
  AccessSectionSummary,
  PrincipalSummary
} from '../../../../shared/console-access-contract'
import { cellFor } from './tool-shelf-matrix-state'

/**
 * The matrix as a spreadsheet: `principal,section,read,write`, on/off.
 *
 * Why a file at all: reviewing everybody's reach a cell at a time is how a wrong
 * grant survives a review. Exported, the whole grid is one page a person can read
 * beside somebody else; imported, it is a DRY RUN first — the hub computes the
 * diff, the diff is shown, and only then is anything written.
 *
 * Pure and string-free on purpose: every message a person reads is translated by
 * the pane, so this module returns codes, and the parser can be tested without a
 * locale or a renderer.
 */

export const SHELF_CSV_HEADER = 'principal,section,read,write'

export type ShelfCsvRow = {
  principal: string
  section: string
  read: boolean
  write: boolean
}

export type ShelfCsvProblem = {
  line: number
  code: 'header' | 'columns' | 'value' | 'principal' | 'section'
  detail: string
}

export type ShelfCsvParse = {
  rows: ShelfCsvRow[]
  problems: ShelfCsvProblem[]
}

const PRINCIPAL_RE = /^(?:human:emp_[a-z0-9_-]{1,64}|agent:[a-z0-9][a-z0-9_-]{0,63})$/
const SECTION_RE = /^[a-z][a-z0-9-]{1,40}$/
const ON = new Set(['on', 'true', 'yes', '1'])
const OFF = new Set(['off', 'false', 'no', '0', ''])

function flag(value: string): boolean | null {
  const token = value.trim().toLowerCase()
  if (ON.has(token)) {
    return true
  }
  return OFF.has(token) ? false : null
}

export function serialiseShelfCsv(
  principals: PrincipalSummary[],
  sections: AccessSectionSummary[]
): string {
  const lines = [SHELF_CSV_HEADER]
  for (const principal of principals) {
    for (const section of sections) {
      const read = cellFor(principal, section, 'read')
      const write = cellFor(principal, section, 'write')
      // Why `on` only when the whole ref is held: the file is a statement of
      // intent, and a partial cell re-imported as "on" would grant the rest.
      lines.push(
        [
          principal.principal,
          section.key,
          read.state === 'on' ? 'on' : 'off',
          write.state === 'on' ? 'on' : 'off'
        ].join(',')
      )
    }
  }
  return `${lines.join('\n')}\n`
}

export function parseShelfCsv(text: string): ShelfCsvParse {
  const rows: ShelfCsvRow[] = []
  const problems: ShelfCsvProblem[] = []
  const lines = text.split(/\r?\n/)
  let seenHeader = false
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (line === '') {
      return
    }
    const cells = line.split(',').map((cell) => cell.trim())
    const at = index + 1
    if (!seenHeader) {
      seenHeader = true
      if (cells.slice(0, 4).join(',').toLowerCase() === SHELF_CSV_HEADER) {
        return
      }
      problems.push({ line: at, code: 'header', detail: line })
      return
    }
    if (cells.length < 4) {
      problems.push({ line: at, code: 'columns', detail: line })
      return
    }
    const [principal, section, readCell, writeCell] = cells
    if (!PRINCIPAL_RE.test(principal)) {
      problems.push({ line: at, code: 'principal', detail: principal })
      return
    }
    if (!SECTION_RE.test(section)) {
      problems.push({ line: at, code: 'section', detail: section })
      return
    }
    const read = flag(readCell)
    const write = flag(writeCell)
    if (read === null || write === null) {
      problems.push({ line: at, code: 'value', detail: `${readCell},${writeCell}` })
      return
    }
    rows.push({ principal, section, read, write })
  })
  return { rows, problems }
}

/**
 * Two changes per row — a section's reads and its writes — each naming the
 * section ref, never a capability id. The hub expands the ref, so a section that
 * grew a connector since the file was written is covered by the same line.
 */
export function shelfCsvChanges(rows: ShelfCsvRow[]): BulkChangeRow[] {
  const changes: BulkChangeRow[] = []
  for (const row of rows) {
    changes.push(sectionChange(row.principal, `@section:${row.section}:read`, row.read))
    changes.push(sectionChange(row.principal, `@section:${row.section}:write`, row.write))
  }
  return changes
}

function sectionChange(principal: string, target: string, on: boolean): BulkChangeRow {
  return on ? { principal, action: 'grant', target } : { principal, action: 'deny', target }
}
