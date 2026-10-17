import type { SessionRelocationResult } from '../shared/session-relocation-types'

export function formatSessionRelocation(result: SessionRelocationResult): string {
  const lines = [result.summary]
  if (result.relocation && result.outcome !== 'relocated' && result.outcome !== 'planned') {
    lines.push(`Move ${result.relocation}.`)
  }
  for (const step of result.steps) {
    lines.push(`  ${step.step}: ${step.state}${step.detail ? ` (${step.detail})` : ''}`)
  }
  return lines.join('\n')
}
