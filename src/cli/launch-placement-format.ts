import type {
  LaunchPlacement,
  LaunchPlacementCandidateSummary,
  LaunchPlacementRoute
} from '../shared/agent-launch-placement-types'

const ROUTE_TEXT: Record<LaunchPlacementRoute['kind'], string> = {
  local: 'local',
  environment: 'paired',
  ssh: 'SSH'
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

/** The ranked table: the pick first, then every other computer looked at and why. */
export function launchPlacementCandidateLines(
  candidates: readonly LaunchPlacementCandidateSummary[]
): string[] {
  const width = Math.min(24, Math.max(8, ...candidates.map((c) => c.label.length)))
  let rank = 0
  return candidates.map((candidate) => {
    const mark = candidate.state === 'fresh' ? `${(rank += 1)}.` : '- '
    const route = ROUTE_TEXT[candidate.route.kind]
    return `    ${mark} ${pad(candidate.label, width)} ${pad(route, 13)} ${pad(candidate.state, 19)} ${candidate.reason}`
  })
}

function workspaceText(placement: LaunchPlacement): string {
  const plan = placement.workspacePlan
  if (plan.kind === 'folder') {
    return `the shared folder ${plan.path} (no fresh worktree: it is a folder project; other sessions there see the same files)`
  }
  const created = placement.createdWorktreeId
    ? `, created as id:${placement.createdWorktreeId}`
    : ''
  return `a fresh worktree ${plan.name} from ${plan.repoSelector}${created}`
}

function placementHeadLines(placement: LaunchPlacement): string[] {
  const { chosen, runnerUp } = placement
  return [
    `  placed    ${chosen.label} (${ROUTE_TEXT[chosen.route.kind]}) by rule ${placement.rule} for ${placement.project.identityKey}: ${chosen.why}`,
    `  workspace ${workspaceText(placement)}`,
    `  runner-up ${runnerUp ? `${runnerUp.label}: ${runnerUp.command}` : 'none'}`
  ]
}

/** Appended to a launch receipt for a --project launch; nothing otherwise. */
export function launchPlacementReceiptLines(placement: LaunchPlacement | undefined): string[] {
  if (!placement) {
    return []
  }
  return [
    ...placementHeadLines(placement),
    '  computers',
    ...launchPlacementCandidateLines(placement.candidates)
  ]
}

export type LaunchPlacementPreview = {
  launched: false
  operationId: null
  placement: LaunchPlacement | null
  candidates: LaunchPlacementCandidateSummary[]
  wouldRefuse: { code: string; message: string; data?: unknown } | null
  /** The operation this command already froze a pick for; a real run follows it, never re-ranks. */
  continues: { operationId: string; outcome: string } | null
}

export function formatLaunchPlacementPreview(
  preview: LaunchPlacementPreview,
  provider: string
): string {
  // Why: a pick can still refuse (its setup must finish first), so a refusal wins over the pick.
  if (!preview.placement || preview.wouldRefuse) {
    return `Would refuse: ${preview.wouldRefuse?.message ?? 'no computer can take it'}`
  }
  const { continues } = preview
  const label = preview.placement.chosen.label
  return [
    continues
      ? `Would continue operation ${continues.operationId} (${continues.outcome}) on ${label}`
      : `Would launch ${provider} on ${label}`,
    ...placementHeadLines(preview.placement),
    continues ? '  computers (as ranked when the pick was frozen)' : '  computers',
    ...launchPlacementCandidateLines(preview.candidates),
    continues
      ? `  Nothing launched or created. This command continues operation ${continues.operationId} on ${label} and will not re-rank; add --again to place afresh.`
      : '  Nothing launched or created. A preview is not a reservation: the launch reads every computer again, and its pick is then frozen for retries.'
  ].join('\n')
}
