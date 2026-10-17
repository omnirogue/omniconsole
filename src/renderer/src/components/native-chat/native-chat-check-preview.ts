import type { PRCheckDetail } from '../../../../shared/github/check-types'

const MAX_CHECK_OUTPUT_LENGTH = 64 * 1024
const MAX_CHECK_ROWS = 100
const CONCLUSIONS = new Set([
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'neutral',
  'skipped',
  'action_required'
])
const ACTIONS_LINK =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*(?:\/job\/[1-9][0-9]*)?$/

/** Recognize only the observed `gh pr checks --json name,state,link` shape. */
export function parseNativeChatCheckPreview(output: string): PRCheckDetail[] | null {
  if (output.length > MAX_CHECK_OUTPUT_LENGTH || !output.trimStart().startsWith('[')) {
    return null
  }
  let rows: unknown
  try {
    rows = JSON.parse(output)
  } catch {
    return null
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_CHECK_ROWS) {
    return null
  }

  const checks: PRCheckDetail[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).length !== 3 ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      row.name.length > 300 ||
      typeof row.state !== 'string' ||
      row.state !== row.state.toUpperCase() ||
      typeof row.link !== 'string' ||
      !ACTIONS_LINK.test(row.link)
    ) {
      return null
    }
    const state = row.state.toLowerCase()
    if (state !== 'queued' && state !== 'in_progress' && !CONCLUSIONS.has(state)) {
      return null
    }
    const key = JSON.stringify([row.link, row.name])
    if (seen.has(key)) {
      return null
    }
    seen.add(key)
    checks.push({
      name: row.name,
      url: row.link,
      status: state === 'queued' || state === 'in_progress' ? state : 'completed',
      conclusion: CONCLUSIONS.has(state) ? (state as PRCheckDetail['conclusion']) : null
    })
  }
  return checks
}
