import type {
  SessionFindOwnerResult,
  SessionOwnerCandidate,
  SessionOwnerPastCandidate
} from '../shared/session-owner-types'

const PAST_WHERE: Record<SessionOwnerPastCandidate['kind'], string> = {
  archived: 'archived',
  exited: 'exited',
  closed: 'tab closed'
}

function formatPast(candidate: SessionOwnerPastCandidate): string {
  const where =
    candidate.kind === 'archived' && candidate.archiveKind === 'automatic'
      ? 'archived automatically, verified complete'
      : PAST_WHERE[candidate.kind]
  const scores = [
    candidate.related === null ? 'not judged' : `related ${candidate.related.toFixed(2)}`,
    candidate.duplicate !== null ? `duplicate ${candidate.duplicate.toFixed(2)}` : null
  ]
    .filter(Boolean)
    .join(', ')
  return [
    `  ${where} · ${scores} · ${candidate.title}  ref ${candidate.ref}`,
    ...(candidate.links.length ? [`    outputs: ${candidate.links.slice(0, 5).join(' ')}`] : []),
    ...(candidate.goal ? [`    goal: ${candidate.goal}`] : [])
  ].join('\n')
}

function formatCandidate(candidate: SessionOwnerCandidate): string {
  const related =
    candidate.related === null ? 'not judged' : `related ${candidate.related.toFixed(2)}`
  return [
    `  ${candidate.light ? 'free' : 'busy'} · ${related} · ${candidate.title}  pane ${candidate.paneKey}`,
    `    ${candidate.load}; ${candidate.signals.join(', ')}${candidate.duplicate !== null ? `; duplicate ${candidate.duplicate.toFixed(2)}` : ''}`,
    ...(candidate.conflictFiles.length
      ? [`    editing: ${candidate.conflictFiles.slice(0, 10).join(', ')}`]
      : []),
    ...(candidate.goal ? [`    goal: ${candidate.goal}`] : [])
  ].join('\n')
}

export function formatSessionFindOwner(result: SessionFindOwnerResult): string {
  const lines = [
    `${result.disposition}: ${result.reason}`,
    result.launchNew ? 'Launch a new session.' : 'Do not launch a new session.'
  ]
  if (result.owner) {
    lines.push(`owner: “${result.owner.title}”  pane ${result.owner.paneKey}`)
  }
  if (result.pastOwner) {
    lines.push(`past conversation: “${result.pastOwner.title}”  ref ${result.pastOwner.ref}`)
  }
  if (result.taskFiles.length) {
    lines.push(`task files: ${result.taskFiles.join(', ')}`)
  }
  if (result.candidates.length) {
    lines.push('', 'Considered:', ...result.candidates.map(formatCandidate))
  }
  if (result.past?.length) {
    lines.push('', 'Past work considered:', ...result.past.map(formatPast))
  }
  if (result.unchecked.length) {
    lines.push(
      '',
      'Not checked:',
      ...result.unchecked.map((entry) => `  ${entry.title}: ${entry.reason}`)
    )
  }
  if (result.jevError) {
    lines.push('', `JEV: ${result.jevError}`)
  }
  if (result.recommend) {
    lines.push('', `Next: ${result.recommend}`)
  }
  return lines.join('\n')
}
