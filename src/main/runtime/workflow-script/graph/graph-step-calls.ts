import type { WorkflowStep } from '../../../../shared/workflow-graph'
import textAnswerSchema from '../presets/schemas/text-answer.schema.json'
import { councilMarkdown } from '../presets/council-ranking'
import { graphItemsProblem, graphListSchema, type GraphItem } from './graph-items'
import {
  GRAPH_VERDICT_PROBLEM,
  graphLabel,
  graphBallotProblem,
  parseGraphBallot,
  parseGraphVerdict
} from './graph-parse'
import {
  fitGraphPrompt,
  graphDoPrompt,
  graphRankPrompt,
  graphReviewPrompt,
  graphSynthesizePrompt,
  type GraphInputBudget,
  type GraphInputSection,
  type GraphReviewText
} from './graph-prompts'
import { graphImprovePrompt } from './graph-improve-prompts'
import {
  WORKFLOW_REPORT_RANKING_INSTRUCTION,
  WORKFLOW_REPORT_ESTIMATES_INSTRUCTION
} from '../../../../shared/workflow-report-ranking'
import { WORKFLOW_CLAIM_TABLE_INSTRUCTION } from '../../../../shared/workflow-claim-table'
import { graphKeyedSections, graphRankedTargets } from './graph-report-ranking'
import {
  GRAPH_JEV_SEAT_ID,
  GRAPH_TIMEOUTS,
  type GraphCall,
  type GraphCandidate,
  type GraphOkOutput,
  type GraphImproveBrief
} from './graph-plan-types'
import { graphUsesLegacyVerification, type GraphScope } from './graph-scope'
import type { GraphWebPage } from './graph-web-types'
import { graphWebFencer } from './graph-web-citations'
import {
  JEV_PAIR_RESPONSE_BYTES,
  JEV_RESPONSE_BYTES
} from '../../../structured-decisions/jev-rank-rubric'
import { graphContractKey } from './graph-decision-rules'
import { graphPreVerifiedList, graphPreVerifies } from './graph-pre-verify'

const requireText = (value: unknown): string | null =>
  councilMarkdown(value) === undefined ? 'The answer was empty.' : null

/**
 * `step[/r<round>][/<item>]/a<agent>`: stable, readable, and parsed by graph-supersede.ts. An
 * Improve improver on its frontier seat is `f<agent>`, so the call names the seat it ran on.
 */
export function graphCallId(
  step: WorkflowStep,
  round: number,
  inLoop: boolean,
  item: GraphItem | undefined,
  agentIndex: number,
  frontier = false
): string {
  const agent = `${frontier ? 'f' : 'a'}${agentIndex}`
  return [step.id, inLoop ? `r${round}` : '', item ? item.key : '', agent].filter(Boolean).join('/')
}

export type GraphCallInput = {
  step: WorkflowStep
  round: number
  inLoop: boolean
  item?: GraphItem
  agentIndex: number
  sections: GraphInputSection[]
  candidates: GraphCandidate[]
  dependencies: string[]
  revise?: { previous: string; reviews: GraphReviewText[] }
  known?: GraphItem[]
  improve?: GraphImproveBrief
  /** Rank in Improve: the task with what every version must follow. */
  judgeTask?: string
  /** Rank: show this judge its usual order reversed (a comparison's second order). */
  reverse?: true
  /** A Do step that reads pages: the pages its own agents see. */
  web?: readonly GraphWebPage[]
  /** Improve: the frontier seat this improver runs on instead of its own. */
  frontierSeat?: string
}

/** One agent call of a step: its prompt, output contract and answer check, by step kind. */
export function buildGraphCall(
  scope: GraphScope,
  input: GraphCallInput
): { call: GraphCall; cuts: string[] } {
  const { step, item, agentIndex } = input
  const agent = step.agents[agentIndex]
  // A ranked write-up sees each result's key and ends with its ranking of them.
  const ranks =
    step.kind === 'synthesize' && !!step.rankItems && graphRankedTargets(input.sections).length > 0
  // A table of claims names each fact-checked claim by its key.
  const keyed =
    ranks ||
    (step.kind === 'synthesize' &&
      !!step.claimTable &&
      graphRankedTargets(input.sections).length > 0)
  const promptInput = (budget: GraphInputBudget) => ({
    step,
    task: input.judgeTask ? { ...scope.task, prompt: input.judgeTask } : scope.task,
    access: scope.config.access,
    ...(graphUsesLegacyVerification(scope) ? { legacy: true } : {}),
    ...(scope.config.workspaceNote ? { workspaceNote: scope.config.workspaceNote } : {}),
    ...(agent.angle ? { angle: agent.angle } : {}),
    sections: keyed ? graphKeyedSections(input.sections) : input.sections,
    ...(item ? { item: { source: scope.title(step.forEach!.step), item } } : {}),
    ...(input.revise ? { revise: input.revise } : {}),
    ...(input.known ? { known: input.known } : {}),
    ...(scope.config.earlier?.step === step.id && step.kind === 'do'
      ? { earlier: scope.config.earlier.titles }
      : {}),
    ...(input.improve ? { improve: input.improve } : {}),
    ...(input.web ? { web: input.web } : {}),
    ...(step.list ? { listMax: step.list.maxItems } : {}),
    ...(graphPreVerifies(scope.config) && graphPreVerifiedList(scope.config.spec, step.id)
      ? { preVerify: true }
      : {}),
    budget
  })
  // Rotate presentation order per ranker to spread position bias; labels never move.
  const { candidates } = input
  const shift = candidates.length ? agentIndex % candidates.length : 0
  const rotated = [...candidates.slice(shift), ...candidates.slice(0, shift)]
  const shown = input.reverse ? rotated.toReversed() : rotated
  const fitted = fitGraphPrompt(
    step.title,
    (budget) =>
      step.kind === 'rank'
        ? graphRankPrompt(promptInput(budget), shown)
        : step.kind === 'review'
          ? graphReviewPrompt(promptInput(budget))
          : step.kind === 'synthesize'
            ? graphSynthesizePrompt(promptInput(budget))
            : input.improve
              ? graphImprovePrompt(promptInput(budget))
              : graphDoPrompt(promptInput(budget)),
    graphWebFencer(scope)
  )
  const { cuts } = fitted
  // A seat's own system prompt leads everything it is asked, whatever the step kind.
  const prompt = agent.system
    ? `Your role and how you work (follow this throughout):\n${agent.system}\n\n---\n\n${fitted.prompt}`
    : fitted.prompt
  const base = {
    id: graphCallId(step, input.round, input.inLoop, item, agentIndex, !!input.frontierSeat),
    seatId: input.frontierSeat ?? scope.seatFor(step, agentIndex),
    dependencies: input.dependencies,
    stepId: step.id,
    round: input.round,
    ...(item ? { itemKey: item.key } : {}),
    agentIndex,
    timeoutMs: GRAPH_TIMEOUTS[step.kind]
  }
  let call: GraphCall
  if (step.kind === 'rank') {
    const labels = candidates.map((candidate) => candidate.label)
    call = {
      ...base,
      prompt,
      schema: textAnswerSchema,
      output: 'text',
      validateSemantics: (value) => {
        const markdown = councilMarkdown(value)
        if (markdown === undefined) {
          return 'The answer was empty.'
        }
        return parseGraphBallot(markdown, labels) ? null : graphBallotProblem(labels)
      }
    }
  } else if (step.kind === 'review') {
    call = {
      ...base,
      prompt,
      schema: textAnswerSchema,
      output: 'text',
      validateSemantics: (value) => {
        const markdown = councilMarkdown(value)
        if (markdown === undefined) {
          return 'The answer was empty.'
        }
        return parseGraphVerdict(markdown) ? null : GRAPH_VERDICT_PROBLEM
      }
    }
  } else if (step.kind === 'synthesize') {
    call = {
      ...base,
      prompt: [
        prompt,
        ranks ? WORKFLOW_REPORT_RANKING_INSTRUCTION : '',
        ranks && step.rankEstimates ? WORKFLOW_REPORT_ESTIMATES_INSTRUCTION : '',
        step.claimTable ? WORKFLOW_CLAIM_TABLE_INSTRUCTION : ''
      ]
        .filter(Boolean)
        .join('\n\n'),
      schema: textAnswerSchema,
      output: 'text',
      validateSemantics: requireText
    }
  } else if (step.list) {
    const salvage = !graphUsesLegacyVerification(scope) && !!step.list.evidence
    call = {
      ...base,
      prompt,
      schema: graphListSchema(step.list.maxItems, !!step.list.evidence, salvage),
      validateSemantics: (value) => graphItemsProblem(value, salvage)
    }
  } else {
    call = {
      ...base,
      prompt,
      schema: textAnswerSchema,
      output: 'text',
      validateSemantics: requireText
    }
  }
  return { call, cuts }
}

/** `step[/r<round>]/jev`: a Rank step's JEV ballot, next to its agents' `a<n>` calls. */
export function graphJevCallId(step: WorkflowStep, round: number, inLoop: boolean): string {
  return [step.id, inLoop ? `r${round}` : '', 'jev'].filter(Boolean).join('/')
}

/**
 * A Rank step's JEV ballot: the same ballot contract as an agent's, answered by the JEV judge.
 * It sits after the step's agents (`agentIndex`), so their labels never move.
 */
export function buildGraphJevCall(
  scope: GraphScope,
  input: {
    step: WorkflowStep
    round: number
    inLoop: boolean
    candidates: GraphCandidate[]
    dependencies: string[]
    /** The task as the judges read it, when it differs from the run's. */
    task?: string
    incumbent?: string
    /** The decision point it judges when not the step's own ballot (a rubric line, the final check). */
    decisionPoint?: string
  }
): GraphCall {
  const { step, candidates } = input
  // JEV cuts what it reads; fitted first, the fence and the checks always survive the cut.
  const fence =
    graphWebFencer(
      scope,
      step.jev!.method === 'rubric' ? JEV_RESPONSE_BYTES : JEV_PAIR_RESPONSE_BYTES
    ) ?? ((text: string) => text)
  const labels = candidates.map((candidate) => candidate.label)
  return {
    id: graphJevCallId(step, input.round, input.inLoop),
    prompt: '',
    schema: textAnswerSchema,
    output: 'text',
    seatId: GRAPH_JEV_SEAT_ID,
    dependencies: input.dependencies,
    stepId: step.id,
    round: input.round,
    agentIndex: step.agents.length,
    jev: {
      method: step.jev!.method,
      task: input.task ?? scope.task.prompt,
      instruction: step.instruction,
      candidates: candidates.map((candidate) => ({
        label: candidate.label,
        markdown: fence(candidate.markdown)
      })),
      ...(input.incumbent ? { incumbent: input.incumbent } : {}),
      ...graphContractKey(scope.config, input.decisionPoint ?? `${step.id}/ballot`)
    },
    validateSemantics: (value) => {
      const markdown = councilMarkdown(value)
      if (markdown === undefined) {
        return 'The answer was empty.'
      }
      return parseGraphBallot(markdown, labels) ? null : graphBallotProblem(labels)
    }
  }
}

/** Rank's candidates: every answer its inputs produced, labelled in frozen agent order. */
export function graphRankCandidates(
  scope: GraphScope,
  inputs: { id: string; output: GraphOkOutput }[]
) {
  const candidates: GraphCandidate[] = []
  let index = 0
  for (const input of inputs) {
    const texts = input.output.run.texts ?? []
    for (let agent = 0; agent < scope.byId.get(input.id)!.agents.length; agent++) {
      const label = graphLabel(index++)
      const text = texts.find((entry) => entry.agentIndex === agent)
      if (text) {
        candidates.push({
          label,
          seatId: text.seatId,
          name: text.name,
          markdown: text.markdown,
          source: { stepId: input.id, agentIndex: agent }
        })
      }
    }
  }
  return candidates
}
