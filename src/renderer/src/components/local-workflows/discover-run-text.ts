import type {
  LocalWorkflowCallView,
  LocalWorkflowDiscoverFinding,
  LocalWorkflowDiscoverRun
} from '../../../../shared/local-workflow-view'
import { translate } from '@/i18n/i18n'
import { discoverLensLabel, verifyLensLabel } from './local-workflow-labels'

export type DiscoverFindingFilter = 'confirmed' | 'unverified' | 'refuted' | 'all'
export type DiscoverReportItem = NonNullable<LocalWorkflowDiscoverRun['report']>['items'][number]

/** Repeats of an earlier finding are merged, never verified or listed twice. */
export function discoverFindingsFor(
  findings: readonly LocalWorkflowDiscoverFinding[],
  filter: DiscoverFindingFilter
): LocalWorkflowDiscoverFinding[] {
  const fresh = findings.filter((finding) => !finding.duplicateOf)
  return filter === 'all' ? fresh : fresh.filter((finding) => finding.status === filter)
}

export function discoverFilterCounts(
  findings: readonly LocalWorkflowDiscoverFinding[]
): Record<DiscoverFindingFilter, number> {
  const fresh = findings.filter((finding) => !finding.duplicateOf)
  const count = (status: LocalWorkflowDiscoverFinding['status']) =>
    fresh.filter((finding) => finding.status === status).length
  return {
    confirmed: count('confirmed'),
    unverified: count('unverified'),
    refuted: count('refuted'),
    all: fresh.length
  }
}

function joinParts(parts: readonly (string | undefined)[]): string | undefined {
  return parts.filter((part): part is string => Boolean(part)).join(' · ') || undefined
}

/**
 * What one Discover agent is working on, read from its call id: find/r<round>/<area>/<lens>,
 * find/r<round>/repeats (the round's repeat check) or verify/<findingId>/<lens>. Unknown shapes
 * (older runs) get no description.
 */
export function discoverCallTask(
  call: Pick<LocalWorkflowCallView, 'id'>,
  run: Pick<LocalWorkflowDiscoverRun, 'areas' | 'findings'>
): string | undefined {
  const [kind, ...rest] = call.id.split('/')
  if (kind === 'find' && rest.length === 2 && rest[1] === 'repeats') {
    return translate('localWorkflow.discoverRun.repeatCheck', 'Checking new findings for repeats')
  }
  if (kind === 'find' && rest.length === 3) {
    const [, area, lensId] = rest
    return joinParts([
      lensId ? discoverLensLabel(lensId) : undefined,
      run.areas[Number(area)]?.name
    ])
  }
  const lens = rest.at(-1)
  if (kind === 'verify' && rest.length >= 2 && lens) {
    const findingId = rest.slice(0, -1).join('/')
    const finding = run.findings.find((entry) => entry.id === findingId)
    return joinParts([finding?.title, verifyLensLabel(lens)])
  }
  return undefined
}

/** "src/a.ts:12" or "src/a.ts:12-20" → path and first line; anything else is a bare path. */
export function parseWorkflowLocation(location: string): { path: string; line: number | null } {
  const match = /^(.+?):(\d+)(?:-\d+)?$/.exec(location.trim())
  return match ? { path: match[1], line: Number(match[2]) } : { path: location.trim(), line: null }
}

/**
 * A model-reported location confined to the workspace: a relative path, or an absolute one under
 * the workspace root, with no empty, "." or ".." segments. Anything else is refused, because the
 * text comes from agent output and must never reach files outside the workspace.
 */
export function workspaceLocation(
  location: string,
  worktreePath: string
): { relativePath: string; line: number | null } | undefined {
  const root = worktreePath.replace(/[\\/]+$/, '')
  const { path, line } = parseWorkflowLocation(location)
  if (!root || !path) {
    return undefined
  }
  const relativePath = path.startsWith(`${root}/`)
    ? path.slice(root.length + 1)
    : path.replace(/^\.\//, '')
  const unsafe =
    relativePath.startsWith('/') ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    relativePath.split('/').some((part) => !part || part === '.' || part === '..')
  return unsafe ? undefined : { relativePath, line }
}

/**
 * The objective handed to Build + Review. Plain English on purpose: it is agent input, and the
 * builder should see exactly what Discover reported and where.
 */
export function discoverFixBrief(item: DiscoverReportItem, goal?: string): string {
  return [
    `Fix: ${item.title}`,
    `Location: ${item.location}`,
    `Severity: ${item.severity}`,
    '',
    'What goes wrong:',
    item.scenario.trim(),
    '',
    'Suggested fix:',
    item.fix.trim(),
    '',
    goal?.trim() ? `Found by Discover while looking for: ${goal.trim()}` : 'Found by Discover.',
    'Keep the change focused on this defect and add a test that reproduces it.'
  ].join('\n')
}
