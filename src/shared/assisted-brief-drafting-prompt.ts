import { BRIEF_SECTION_PROMPT_TITLES } from './assisted-brief-execution-prompt'
import { currentBriefRevision } from './assisted-brief-revisions'
import {
  ASSISTED_BRIEF_LIMITS,
  BRIEF_LIST_SECTIONS,
  type AssistedBriefRecord,
  type BriefAttachmentRef
} from './assisted-brief-types'

export type BriefDraftingInput = {
  request: string
  attachments: readonly BriefAttachmentRef[]
  namedModels: readonly string[]
  workspaceLabel: string
  workspaceKind: 'git' | 'folder'
}

const READ_ONLY_RULE =
  'Do not do the work. Do not create, edit, move or delete files, and do not run commands that change anything. You may read files in the workspace to understand the context.'

function namedModelLine(namedModels: readonly string[]): string {
  return namedModels.length > 0
    ? `Models named in the request (keep exactly as written): ${namedModels.join(', ')}`
    : 'Models named in the request: none'
}

function attachmentLines(attachments: readonly BriefAttachmentRef[]): string[] {
  return attachments.length > 0
    ? ['Attached files:', ...attachments.map((file) => `- ${file.name}: ${file.path}`)]
    : []
}

/**
 * The one-shot drafting request. It asks for a short brief in the person's terms: no work,
 * no added scope, named models untouched, and questions only when an answer changes the work.
 */
export function buildBriefDraftingPrompt(input: BriefDraftingInput): string {
  const sections = BRIEF_LIST_SECTIONS.join(', ')
  return [
    'You are helping a person shape a request before any work starts. Write a short brief and nothing else.',
    READ_ONLY_RULE,
    '',
    'Rules:',
    "- Keep the person's intent and wording. Do not add goals, features, deliverables or steps they did not ask for.",
    '- Keep every model the person named exactly as written, and do not propose other models.',
    '- The work may be software development, writing, research, operations or anything else. Do not assume it involves code unless the request does.',
    '- Mark where each line comes from: "request" when the person said it, "assumption" when you inferred it, "suggestion" when it is your own proposal. Keep assumptions and suggestions few.',
    `- Ask a question only when the answer would materially change the work and is not already in the request or the workspace. Ask at most ${ASSISTED_BRIEF_LIMITS.questions} questions together, each with 2 to ${ASSISTED_BRIEF_LIMITS.choicesPerQuestion} short answer choices. A simple request needs no questions.`,
    '- Keep it short: one outcome sentence and at most 5 lines per section. Leave a section empty rather than padding it.',
    '',
    `Workspace: ${input.workspaceLabel} (${input.workspaceKind === 'git' ? 'a Git repository' : 'a folder'})`,
    namedModelLine(input.namedModels),
    '',
    'Request:',
    '<<<',
    input.request,
    '>>>',
    ...attachmentLines(input.attachments),
    '',
    'Reply with one JSON object only, with no prose and no code fences, in this shape:',
    `{"outcome":{"text":"...","source":"request"},"scope":[{"text":"...","source":"request|assumption|suggestion"}],"constraints":[],"assumptions":[],"deliverables":[],"successChecks":[],"questions":[{"question":"...","choices":["...","..."],"section":"one of: ${sections}"}]}`
  ].join('\n')
}

/**
 * The independent review, run by a different model than the drafter. Findings stay
 * suggestions until the person accepts them; line ids map findings back to brief lines.
 */
export function buildBriefChallengePrompt(record: AssistedBriefRecord): {
  prompt: string
  lineIds: Record<string, string>
} {
  const { content } = currentBriefRevision(record)
  const lineIds: Record<string, string> = {}
  const briefLines: string[] = [`Outcome: ${content.outcome.text}`]
  let counter = 0
  for (const section of BRIEF_LIST_SECTIONS) {
    for (const item of content.sections[section]) {
      counter += 1
      const label = `L${counter}`
      lineIds[label] = item.id
      briefLines.push(`[${label}] ${BRIEF_SECTION_PROMPT_TITLES[section]}: ${item.text}`)
    }
  }
  const prompt = [
    "You are independently reviewing a brief that another AI drafted from a person's request. No work has started.",
    READ_ONLY_RULE,
    '',
    'Look only for:',
    '- missed requirements: something the request asks for that the brief leaves out;',
    '- unsupported assumptions: brief lines the request and the workspace do not support;',
    '- unnecessary work: brief lines that add work the request did not ask for;',
    '- regression risks: ways the planned work could break something that works today.',
    `Do not propose new goals. Keep every named model exactly as written. Report at most ${ASSISTED_BRIEF_LIMITS.findings} findings, or none when the brief is sound.`,
    '',
    namedModelLine(record.namedModels),
    '',
    'Request:',
    '<<<',
    record.original.text,
    '>>>',
    '',
    'Brief:',
    ...briefLines,
    '',
    'Reply with one JSON object only, with no prose and no code fences, in this shape:',
    `{"findings":[{"kind":"missed-requirement|unsupported-assumption|unnecessary-work|regression-risk","note":"...","change":{"action":"add","section":"one of: ${BRIEF_LIST_SECTIONS.join(', ')}","text":"..."}}]}`,
    'For a line to drop, use {"action":"remove","line":"L2"}; when nothing should change, use {"action":"none"}.'
  ].join('\n')
  return { prompt, lineIds }
}
