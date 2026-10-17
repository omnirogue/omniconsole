import { currentBriefRevision, isPersonOrigin } from './assisted-brief-revisions'
import {
  BRIEF_LIST_SECTIONS,
  type AssistedBriefRecord,
  type BriefItemOrigin,
  type BriefListSection
} from './assisted-brief-types'

export const BRIEF_SECTION_PROMPT_TITLES: Record<BriefListSection, string> = {
  scope: 'Scope',
  constraints: 'Constraints',
  assumptions: 'Assumptions',
  deliverables: 'Deliverables',
  successChecks: 'How success will be checked'
}

const PROPOSAL_KIND: Partial<Record<BriefItemOrigin, string>> = {
  'ai-assumption': 'AI assumption',
  'ai-suggestion': 'AI suggestion',
  challenge: 'reviewer suggestion'
}

/**
 * The exact text Start sends for the current revision. The person's requirements, the AI
 * proposals they kept, and their original words stay in separate, labelled blocks.
 */
export function buildBriefExecutionPrompt(record: AssistedBriefRecord): string {
  const revision = currentBriefRevision(record)
  const { content } = revision
  const outcomeNote = isPersonOrigin(content.outcome.origin) ? '' : ' (AI wording)'
  const lines = [
    `Work from this brief. The person approved revision ${revision.number} before starting.`,
    'Stay inside its scope. Routine steps need no further approval; stop and ask before any material change to the outcome, scope, deliverables or models.',
    '',
    `Outcome: ${content.outcome.text}${outcomeNote}`
  ]
  for (const section of BRIEF_LIST_SECTIONS) {
    const items = content.sections[section].filter((item) => isPersonOrigin(item.origin))
    if (items.length > 0) {
      lines.push(
        '',
        `${BRIEF_SECTION_PROMPT_TITLES[section]} (the person's requirements):`,
        ...items.map((item) => `- ${item.text}`)
      )
    }
  }
  const proposals = BRIEF_LIST_SECTIONS.flatMap((section) =>
    content.sections[section]
      .filter((item) => !isPersonOrigin(item.origin))
      .map(
        (item) =>
          `- ${BRIEF_SECTION_PROMPT_TITLES[section]}: ${item.text} (${PROPOSAL_KIND[item.origin]})`
      )
  )
  if (proposals.length > 0) {
    lines.push(
      '',
      "AI suggestions and assumptions the person kept in the approved brief. They are not the person's own requirements:",
      ...proposals
    )
  }
  if (content.questions.length > 0) {
    lines.push(
      '',
      'Open questions the person has not answered. Ask before relying on an answer:',
      ...content.questions.map((question) => `- ${question.prompt}`)
    )
  }
  if (record.namedModels.length > 0) {
    lines.push(
      '',
      'Models named in the request. Use them exactly as written:',
      ...record.namedModels.map((model) => `- ${model}`)
    )
  }
  lines.push('', "The person's original request, verbatim:", '<<<', record.original.text, '>>>')
  if (record.original.attachments.length > 0) {
    lines.push(
      '',
      "Files the person attached (read them on the workspace's computer):",
      ...record.original.attachments.map((file) => `- ${file.name}: ${file.path}`)
    )
  }
  return lines.join('\n')
}
