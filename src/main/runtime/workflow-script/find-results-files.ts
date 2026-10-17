import type { WorkflowFindRow, WorkflowFindTrail } from '../../../shared/workflow-find-trail'

/** Spreadsheets run a cell that starts with one of these as a formula; a leading quote keeps it text. */
const FORMULA = /^[=+\-@\t\r]/

function csvField(value: string): string {
  const text = FORMULA.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const checkText = (check: WorkflowFindRow['check']) =>
  !check ? '' : check.unavailable ? 'could not run' : check.passed ? 'passed' : 'failed'

const number = (value: number | null | undefined) =>
  value === null || value === undefined ? '' : String(Math.round(value * 100) / 100)

/**
 * Every option and every score, best first, as CSV. The byte-order mark makes Excel read UTF-8;
 * text that a spreadsheet would run as a formula is kept as text.
 */
export function findResultsCsv(trail: WorkflowFindTrail): string {
  const facts = (trail.rows ?? []).some((row) => row.facts)
  const checked = (trail.rows ?? []).some((row) => row.check)
  const header = [
    'rank',
    'option',
    'detail',
    'from',
    'jev_score',
    ...(trail.criteria ?? []),
    'final_place',
    'finalist',
    'kept',
    ...(checked ? ['check', 'check_score'] : []),
    ...(facts ? ['github'] : [])
  ]
  const rows = (trail.rows ?? []).map((row, index) =>
    [
      String(index + 1),
      csvField(row.title),
      csvField(row.detail),
      csvField(row.by),
      number(row.score),
      ...row.scores.map(number),
      number(row.finalPlace),
      row.finalist ? 'yes' : '',
      row.kept ? 'yes' : '',
      ...(checked ? [checkText(row.check), number(row.check?.score)] : []),
      ...(facts ? [csvField(row.facts ?? '')] : [])
    ].join(',')
  )
  return `\uFEFF${[header.map(csvField).join(','), ...rows].join('\r\n')}\r\n`
}

const quote = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n')

/** The results file: what was asked and judged by, the report, then every option best first. */
export function findResultsMarkdown(input: {
  task: string
  rubric: string
  report: string
  trail: WorkflowFindTrail
}): string {
  const criteria = input.trail.criteria ?? []
  const rows = input.trail.rows ?? []
  const options = rows.map((row, index) => {
    const facts = [
      row.score !== undefined ? `JEV ${row.score.toFixed(1)} of 4` : 'not scored by JEV',
      ...criteria.flatMap((label, at) => {
        const value = row.scores[at]
        return value === null || value === undefined ? [] : [`${label} ${value.toFixed(1)}`]
      }),
      ...(row.check
        ? [
            `check ${checkText(row.check)}${row.check.score !== undefined ? ` (score ${number(row.check.score)})` : ''}`
          ]
        : []),
      ...(row.finalPlace !== undefined ? [`final place ${row.finalPlace}`] : []),
      `from ${row.by}`
    ].join(' · ')
    const detail = row.detail.trim() ? `\n\n   ${row.detail.trim().replaceAll('\n', '\n   ')}` : ''
    const github = row.facts ? `\n   ${row.facts}` : ''
    return `${index + 1}. **${row.title.replaceAll('\n', ' ')}**\n   ${facts}${github}${detail}`
  })
  return `${[
    '# Find the best',
    `**Asked:**\n\n${quote(input.task)}`,
    ...(input.rubric.trim() ? [`**What good meant:**\n\n${quote(input.rubric)}`] : []),
    input.report.trim(),
    `## Every option, best first (${rows.length})`,
    options.join('\n\n')
  ].join('\n\n')}\n`
}

const pad = (value: number) => String(value).padStart(2, '0')

/**
 * The results files' shared name: when the run started (local time), a few words of the task,
 * and the run's id, so runs never share a name, e.g. 2026-09-23-0812-ad-hooks-for-spring-3f9a1c2e.
 */
export function findResultsStem(task: string, startedAt: number, executionId: string): string {
  const date = new Date(startedAt)
  const words = task
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '')
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}`,
    words || 'find',
    executionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)
  ].join('-')
}
