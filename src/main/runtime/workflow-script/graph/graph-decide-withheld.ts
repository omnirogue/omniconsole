import type { GraphCandidate } from './graph-plan-types'

/**
 * What a Decide run shows when no recommendation passed its checks: the skeptic's reasons, then
 * every finalist as developed, for the person to judge. It never reads as a recommendation.
 */
export function graphWithheldDecision(
  reasons: readonly string[],
  finalists: readonly GraphCandidate[]
): string {
  const demote = (markdown: string) => markdown.replace(/^(#{1,5}) /gm, '#$1 ')
  return [
    '## No recommendation passed the checks',
    '### What the skeptic found',
    ...reasons.map(demote),
    '### The finalists, unrecommended',
    ...(finalists.length ? finalists.map((entry) => demote(entry.markdown)) : ['None came back.'])
  ].join('\n\n')
}
