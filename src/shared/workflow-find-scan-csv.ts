/** CSV records retain malformed rows so Scan can count them as skipped. */
export function scanCsvRecords(source: string): (string[] | null)[] {
  const rows: (string[] | null)[] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let closed = false
  let invalid = false
  let touched = false
  let recordStart = 0
  const finish = () => {
    rows.push(invalid || quoted ? null : [...row, field])
    row = []
    field = ''
    closed = invalid = touched = quoted = false
  }
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    touched = true
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
          closed = true
        }
      } else {
        field += ch
      }
    } else if (ch === ',') {
      row.push(field)
      field = ''
      closed = false
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') {
        i++
      }
      finish()
      recordStart = i + 1
    } else if (ch === '"' && !closed && !field.trim()) {
      // A space (or other blank) before the opening quote does not make the field text.
      quoted = true
      field = ''
    } else {
      if (closed || ch === '"') {
        invalid = true
      }
      field += ch
    }
  }
  if (quoted) {
    // An unmatched quote must not swallow later complete rows.
    rows.push(null)
    const newline = /\r\n|\r|\n/.exec(source.slice(recordStart))
    if (newline) {
      return rows.concat(
        scanCsvRecords(source.slice(recordStart + newline.index + newline[0].length))
      )
    }
  } else if (touched) {
    finish()
  }
  return rows
}
