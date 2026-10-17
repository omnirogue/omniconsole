import type { WorkflowStep } from '../../../../shared/workflow-graph'
import { councilRankingPrompt } from '../presets/council-v6-prompts'
import { formatGraphItem, graphItemTitles, type GraphItem } from './graph-items'
import type { GraphTally } from './graph-parse'
import type { GraphImproveBrief } from './graph-plan-types'
import { graphJevVerdictNote, renderGraphReportEvidence } from './graph-report-evidence'
import { graphEvidenceListInstruction, graphEvidencePack } from './graph-evidence-pack'
import { graphWebSourcesBlock } from './graph-web-prompt'
import type { GraphWebPage } from './graph-web-types'
import { EARLIER_RUNS_LABEL } from '../workflow-earlier-findings'

/**
 * Prompt text for each step kind. Everything here is a pure function of the frozen spec and of
 * results already accepted, so a replayed run rebuilds byte-identical prompts and the journal
 * returns the same answers.
 */
export const GRAPH_WORKSPACE_NOTE =
  "You are running inside the user's workspace (the current directory) and may read files (read-only) to ground your work. Cite files as path:line when you rely on them."

export const GRAPH_DEFAULT_INSTRUCTIONS: Record<WorkflowStep['kind'], string> = {
  do: '',
  review:
    'Critically review the work below against the task. Point out errors, gaps and unsupported claims, and say specifically how to fix each.',
  rank: '',
  synthesize:
    'Write the single best final answer to the task from the work below: keep what is strongest, resolve disagreements, and correct everything the reviews found.'
}

const VERDICT_TAIL =
  'End your answer with one line: VERDICT: PASS if the work is correct and complete, VERDICT: FAIL if something must be fixed, or VERDICT: UNSURE if you cannot tell.'
/** A step that defines PASS itself (Discover: PASS = the defect is real) keeps its own meaning. */
const DEFINED_VERDICT_TAIL =
  'End your answer with one line: VERDICT: PASS, VERDICT: FAIL or VERDICT: UNSURE, meaning exactly what the instruction above says they mean.'

export type {
  GraphInputSection,
  GraphReviewText,
  GraphTargetView,
  GraphText
} from './graph-input-section'
import type { GraphInputSection, GraphReviewText, GraphText } from './graph-input-section'
export {
  fitGraphPrompt,
  GraphInputBudget,
  GRAPH_MAX_INPUT_CHARS,
  GRAPH_MAX_PROMPT_INPUT_CHARS
} from './graph-prompt-budget'
import type { GraphInputBudget } from './graph-prompt-budget'

export function graphRenderSection(
  section: GraphInputSection,
  budget: GraphInputBudget,
  named: boolean
): string {
  const who = (text: GraphText) => (named ? `${text.label} — ${text.name}` : text.label)
  switch (section.kind) {
    case 'texts':
      return [
        `## ${section.title}`,
        ...(section.web ? [section.web] : []),
        ...section.texts.map(
          (text) =>
            `### ${who(text)}\n${budget.fence(budget.take(`${section.title}, ${text.label} (${text.name})`, text.markdown))}`
        )
      ].join('\n\n')
    case 'items':
      return [
        `## ${section.title} (${section.items.length} ${section.items.length === 1 ? 'item' : 'items'})`,
        ...(section.web ? [section.web] : []),
        ...section.items.map(
          (item, index) =>
            `${index + 1}. ${budget.fence(budget.take(`${section.title}, item ${item.key}`, formatGraphItem(item, section.legacy)))}`
        )
      ].join('\n\n')
    case 'reviews':
      return [
        `## ${section.title}${section.approved === undefined ? '' : section.approved ? ' (approved)' : ' (not approved)'}`,
        ...section.reviews.map(
          (review) =>
            `### ${named ? review.name : review.label} — VERDICT: ${(review.verdict ?? 'none').toUpperCase()}\n${budget.fence(budget.take(`${section.title}, ${review.label} (${review.name})`, review.markdown))}`
        )
      ].join('\n\n')
    case 'targets': {
      if (section.compact) {
        return renderGraphReportEvidence(section.title, section.targets, budget, {
          oneReview: !!section.oneReview,
          keyed: !!section.keyed,
          legacy: !!section.legacy
        })
      }
      const group = (tally: GraphTally, heading: string) => {
        const targets = section.targets.filter((target) => target.tally === tally)
        return targets.length
          ? [
              `### ${heading} (${targets.length})`,
              ...targets.map((target, index) => {
                const votes = target.item.evidence?.preVerify?.dropped
                  ? 'not checked (dropped before review: no file it cites exists)'
                  : target.unchecked
                    ? 'not checked (over the limit of items to verify)'
                    : target.votes
                        .map(
                          (vote) => `${vote.name}: ${(vote.verdict ?? 'no answer').toUpperCase()}`
                        )
                        .join('; ')
                const reasons = target.votes
                  .map((vote, reviewer) =>
                    vote.markdown
                      ? `> ${vote.name}: ${budget
                          .take(
                            `${section.title}, item ${target.item.key}, reviewer ${reviewer + 1} (${vote.name})`,
                            vote.markdown
                          )
                          .replace(/\s+/g, ' ')}`
                      : ''
                  )
                  .filter(Boolean)
                  .join('\n')
                const item = budget.take(
                  `${section.title}, item ${target.item.key}`,
                  formatGraphItem(target.item, section.legacy)
                )
                return `${index + 1}. ${section.keyed ? `[${target.item.key}] ` : ''}${budget.fence(item)}\nVotes: ${votes}${graphJevVerdictNote(target)}${reasons ? `\n${budget.fence(reasons)}` : ''}`
              })
            ].join('\n\n')
          : ''
      }
      return [
        `## ${section.title}`,
        group('confirmed', 'Confirmed'),
        group('unverified', 'Unverified'),
        group('refuted', 'Refuted')
      ]
        .filter(Boolean)
        .join('\n\n')
    }
    case 'ranking': {
      const rows = section.standings.map((standing) =>
        standing.votes
          ? `| ${standing.place} | ${standing.name} | ${standing.label} | ${standing.averageRank.toFixed(2)} | ${standing.votes} |`
          : `| - | ${standing.name} | ${standing.label} | not ranked | 0 |`
      )
      return [
        `## ${section.title}`,
        'Average rank (lower is better; a model’s vote for its own answer is not counted):',
        [
          '| Place | Model | Response | Average rank | Votes |',
          '| --- | --- | --- | --- | --- |',
          ...rows
        ].join('\n'),
        ...section.ballots.map(
          (ballot) =>
            `### ${ballot.name}\n${budget.fence(budget.take(`${section.title}, ${ballot.label} (${ballot.name})`, ballot.markdown))}`
        )
      ].join('\n\n')
    }
  }
}

/** GraphConfig's cross-run known list (host.earlierFindings): shown to one step's Do prompts only. */
export type GraphEarlierConfig = {
  earlier?: { step: string; titles: readonly string[] }
  /** Exact repeats of these lines are held after that step (graphEarlierHold). */
  earlierHold?: { step: string; lines: readonly string[] }
}

export type GraphPromptInput = {
  step: WorkflowStep
  task: { prompt: string; evidence: string }
  access: 'workspace-read' | 'frozen'
  /** Appended to GRAPH_WORKSPACE_NOTE for a run that reads a context folder. */
  workspaceNote?: string
  angle?: string
  sections: GraphInputSection[]
  /** For each: the item this call works on. */
  item?: { source: string; item: GraphItem }
  /** Repeat until approved, round ≥2: the previous version and its reviews. */
  revise?: { previous: string; reviews: GraphReviewText[] }
  /** Repeat until nothing new, round ≥2: what earlier rounds already reported. */
  known?: GraphItem[]
  /** The cross-run known list (host.earlierFindings): earlier runs' titles, one line each. */
  earlier?: readonly string[]
  /** Improve: this improver's role, the best version so far and the judges' notes. */
  improve?: GraphImproveBrief
  /** A Do step that reads pages: its own, fenced; no other step's prompt ever holds page text. */
  web?: readonly GraphWebPage[]
  listMax?: number
  /** Evidence rules 2: finders give the search behind any absence they claim. */
  preVerify?: boolean
  legacy?: boolean
  budget: GraphInputBudget
}

export function graphPromptHeader(input: GraphPromptInput, instruction: string): string[] {
  return [
    instruction,
    instruction || input.sections.length || input.item
      ? `The task:\n${input.task.prompt}`
      : input.task.prompt,
    input.angle ? `Take this angle: ${input.angle}.` : '',
    input.item
      ? `Work on this item from ${input.item.source}:\n${input.budget.fence(input.budget.take(`Item ${input.item.item.key} from ${input.item.source}`, formatGraphItem(input.item.item, input.legacy)))}`
      : '',
    !input.legacy && input.item?.item.alsoReported?.length
      ? `Judge EVERY report separately: report 1 is the primary claim; reports 2 through ${input.item.item.alsoReported.length + 1} are the merged reports in listed order. For each, write REPORT <n>: PASS, FAIL or UNSURE using this step's verdict meanings. A group passes only if all pass, is refuted only if all fail, and otherwise stays UNSURE. Do not let one claim's evidence stand for another.`
      : '',
    input.item?.item.evidence
      ? input.budget.fencing
        ? graphEvidencePack(input.item.item, (written) =>
            input.budget.fence(
              input.budget.take(`Evidence pack for item ${input.item!.item.key}`, written)
            )
          )
        : input.budget.take(
            `Evidence pack for item ${input.item.item.key}`,
            graphEvidencePack(input.item.item)
          )
      : ''
  ]
}

export function graphPromptFooter(input: GraphPromptInput): string[] {
  return [
    !input.step.inputs.length && input.task.evidence.trim()
      ? `Attached files:\n${input.task.evidence}`
      : '',
    input.access === 'workspace-read'
      ? input.workspaceNote
        ? `${GRAPH_WORKSPACE_NOTE} ${input.workspaceNote}`
        : GRAPH_WORKSPACE_NOTE
      : ''
  ]
}

const join = (parts: string[]) => parts.filter((part) => part.trim()).join('\n\n')

export function graphDoPrompt(input: GraphPromptInput): string {
  const instruction = input.step.instruction || GRAPH_DEFAULT_INSTRUCTIONS.do
  const known = input.known?.length
    ? `Already reported in earlier rounds (do not report these again; find what they missed):\n${input.budget.fence(
        input.budget.take(
          'The list of items already reported',
          input.known.map(graphItemTitles).join('\n')
        )
      )}`
    : ''
  const earlier = input.earlier?.length
    ? `${EARLIER_RUNS_LABEL}:\n${input.budget.fence(
        input.budget.take(
          'The list of items reported in earlier runs',
          input.earlier.map((title) => `- ${title}`).join('\n')
        )
      )}`
    : ''
  const revise = input.revise
    ? join([
        `Your previous version:\n${input.budget.fence(input.budget.take('The previous version', input.revise.previous, { whole: true }))}`,
        `Reviewer feedback on it:\n${input.revise.reviews
          .map(
            (review) =>
              `### ${review.label} — VERDICT: ${(review.verdict ?? 'none').toUpperCase()}\n${input.budget.fence(input.budget.take(review.label, review.markdown))}`
          )
          .join('\n\n')}`,
        'Write a complete revised version that addresses every point the reviewers raised. Return the whole revised work, not a list of changes.'
      ])
    : ''
  return join([
    ...graphPromptHeader(input, instruction),
    ...input.sections.map((section) => graphRenderSection(section, input.budget, true)),
    input.web ? graphWebSourcesBlock(input.web, input.budget) : '',
    revise,
    known,
    earlier,
    input.listMax !== undefined && input.step.list?.evidence
      ? graphEvidenceListInstruction(input.listMax, input.preVerify, !input.legacy)
      : input.listMax !== undefined
        ? `Return your results as a list of at most ${input.listMax} items: title, detail, location (path:line, or "" when there is none) and severity ("none" when it does not apply). Return an empty list if there is nothing real to report.`
        : '',
    ...graphPromptFooter(input)
  ])
}

export function graphReviewPrompt(input: GraphPromptInput): string {
  const instruction = input.step.instruction || GRAPH_DEFAULT_INSTRUCTIONS.review
  return join([
    ...graphPromptHeader(input, instruction),
    // Reviewers judge the work, not the brand that wrote it.
    ...input.sections.map((section) => graphRenderSection(section, input.budget, false)),
    ...graphPromptFooter(input),
    /VERDICT: PASS/.test(instruction) ? DEFINED_VERDICT_TAIL : VERDICT_TAIL
  ])
}

/** Karpathy's stage 2 prompt, byte for byte, with the step's own instruction first if it has one. */
export function graphRankPrompt(
  input: Pick<GraphPromptInput, 'step' | 'task' | 'budget'>,
  shown: readonly { label: string; markdown: string }[]
): string {
  const ranked = councilRankingPrompt(
    input.task.prompt,
    shown.map((entry) => ({
      label: entry.label,
      markdown: input.budget.fence(
        input.budget.take(`${input.step.title} ${entry.label}`, entry.markdown)
      )
    }))
  )
  return input.step.instruction ? `${input.step.instruction}\n\n${ranked}` : ranked
}

export function graphSynthesizePrompt(input: GraphPromptInput): string {
  const instruction = input.step.instruction || GRAPH_DEFAULT_INSTRUCTIONS.synthesize
  return join([
    instruction,
    `Original task:\n${input.task.prompt}`,
    ...input.sections.map((section) => graphRenderSection(section, input.budget, true)),
    'Refer to contributors by model name, never by response letter.',
    input.access === 'workspace-read'
      ? 'You may read files in the workspace to check disputed claims.'
      : '',
    'Provide a clear, well-reasoned final answer.'
  ])
}
