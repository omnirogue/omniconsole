import { resolveRosterName, type TeamRosterPerson } from './team-roster-search'
import { sourceInstructionEvidenceRanges } from './source-instruction-evidence'

export type NextOutcomeHandoffRequest = {
  instruction: string
  recipientQuery: string
  review: boolean
  includeTranscript: boolean
  requestedFiles: boolean
}

export type ResolvedNextOutcomeHandoff = NextOutcomeHandoffRequest & {
  person: TeamRosterPerson
}

// A quoted, conditional, negated or permission-seeking mention cannot authorize a delivery.
const NON_DIRECT =
  /\b(?:not|never|without|unless|if|before|ask|confirm|whether|should|maybe|consider|imagine|example|hypothetical|quoted?|says?|said)\b|\b(?:don['’]t|can['’]t|won['’]t|wouldn['’]t)\b/i
const COMPLETION =
  "(?:(?:when|once|after) (?:(?:you(?: are|['’]re)|it(?: is|['’]s)|this is|everything is) )?(?:all )?(?:done|finished|complete)[, ]+)?"
const OBJECT =
  '(?:it|this|that|them|everything|(?:the |my )?(?:(?:final|finished|full|complete) )?(?:files?|work|results?|deliverables?|reports?|summary|conversation|transcript)|`[^`\\n]+`|"[^"\\n]+"|(?:[A-Za-z]:[\\\\/]|/|\\./|\\.\\./)[^\\s;,]+)(?: and (?:the )?(?:full |complete )?(?:conversation|transcript))?'
const DIRECT_HANDOFF = new RegExp(
  `(?:^(?:then\\s+)?|,\\s*(?:and\\s+)?then\\s+|\\s+(?:and|then)\\s+)(?:(?:please|can you|could you|would you)\\s+)?${COMPLETION}(?:send(?: ${OBJECT})?|hand(?:off|over)(?: ${OBJECT})?|hand off(?: ${OBJECT})?|hand(?: ${OBJECT})? off|give ${OBJECT}) to ([\\p{L}\\p{N}][\\p{L}\\p{N} .’'-]{0,199}?)(?=\\s+(?:and|then|when|once|after|for)\\b|[.!?;]|$)`,
  'giu'
)

/** Admission parses explicit delivery clauses; the source agent still defines the outcome set. */
export function nextOutcomeHandoffRequests(prompt: string): NextOutcomeHandoffRequest[] {
  const requests: NextOutcomeHandoffRequest[] = []
  const visible = prompt
    .slice(0, 32_000)
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, '')
  const quoted = sourceInstructionEvidenceRanges(visible)
  let offset = 0
  for (const sentence of visible.split(/(\n+|(?<=[.!?;])\s+)/)) {
    const sentenceOffset = offset
    offset += sentence.length
    if (NON_DIRECT.test(sentence) || /^\s*(?:>|```|["“])/.test(sentence)) {
      continue
    }
    for (const match of sentence.matchAll(DIRECT_HANDOFF)) {
      const actionOffset =
        sentenceOffset + match.index + match[0].search(/\b(?:send|hand(?:off|over)?|give)\b/i)
      if (quoted.some(([start, end]) => actionOffset >= start && actionOffset < end)) {
        continue
      }
      const tail = sentence.slice((match.index ?? 0) + match[0].length)
      const reviewSuffix = /^\s+for (?:a )?review\b/i.exec(tail)?.[0] ?? ''
      const instruction = `${match[0]}${reviewSuffix}`
        .replace(/^(?:,\s*)?(?:and|then)\s+/i, '')
        .trim()
      requests.push({
        instruction,
        recipientQuery: match[1]!.trim(),
        review: Boolean(reviewSuffix),
        includeTranscript: /\b(?:conversation|transcript)\b/i.test(instruction),
        requestedFiles:
          /\b(?:files?|deliverables?|reports?)\b|[`"]|(?:^|\s)(?:\/|\.\.?\/|[A-Za-z]:[\\/])/i.test(
            instruction
          )
      })
    }
  }
  return requests
}

export function resolveNextOutcomeHandoffs(
  prompt: string,
  people: readonly TeamRosterPerson[]
): { handoffs: ResolvedNextOutcomeHandoff[]; unresolvedRecipients: string[] } {
  const handoffs: ResolvedNextOutcomeHandoff[] = []
  const unresolvedRecipients: string[] = []
  for (const request of nextOutcomeHandoffRequests(prompt)) {
    const result = resolveRosterName(request.recipientQuery, people)
    if (result.kind !== 'match' || !/^emp_[A-Za-z0-9_-]{1,120}$/.test(result.person.id)) {
      unresolvedRecipients.push(request.recipientQuery)
    } else {
      handoffs.push({ ...request, person: result.person })
    }
  }
  return { handoffs, unresolvedRecipients }
}
