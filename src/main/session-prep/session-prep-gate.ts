import { z } from 'zod'
import { checkPreparedFields, renderSessionPrompt } from '../../shared/session-prep-prompt'
import type {
  GateFailure,
  GateVerdict,
  PlannedItem,
  PreparedFields,
  PrepJevAsk,
  PrepRunText
} from '../../shared/session-prep-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { parseModelJson } from './session-prep-model-json'
import { isSessionPrepAccountFailure } from './session-prep-ids'

export type SessionPrepGateDeps = {
  runText: PrepRunText
  jevAsk?: PrepJevAsk
  pathExists: (cwd: string, rel: string) => Promise<boolean>
  agent: TuiAgent
  model: string
  effort: string
  timeoutMs: number
}

const CONTRADICTION_DETAIL =
  'the prompt contains conflicting instructions or conflicts with the request'
const NOT_READY_DETAIL =
  'an independent check judged this prompt not ready: unclear outcome, missing checks, unfaithful to the request, or unresolved gaps'
const NEEDLESS_DETAIL = 'this question can be answered by research or a sensible default'

const CONSISTENT_Q =
  'Is the prepared prompt free of instructions that contradict each other or contradict the user request?'
const READY_Q =
  'Is this prepared prompt ready to hand to an autonomous agent: a clear outcome, checkable success criteria, faithful to the user request, no contradictions and no unresolved placeholders?'
const NEEDS_USER_Q =
  'Is a decision or fact missing that ONLY the user can provide (not something an agent could look up, infer from the conversation, or sensibly choose itself), without which the task cannot be done correctly?'

const modelJudgeSchema = z.object({
  consistent: z.boolean(),
  ready: z.boolean(),
  needs_user: z.boolean().optional()
})

const needsUserSchema = z.object({
  needs_user: z.boolean()
})

// Why only '..': absolute paths are checked by pathExists, which admits files in the home folder.
function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]/).includes('..')
}

async function missingReferenceFailures(
  references: PreparedFields['references'],
  cwd: string,
  pathExists: SessionPrepGateDeps['pathExists']
): Promise<GateFailure[]> {
  const failures: GateFailure[] = []
  for (const ref of references) {
    const path = ref.path.replace(/^\.\//, '')
    if (path === '' || hasParentSegment(path)) {
      failures.push({ code: 'missing-reference', detail: `"${path || ref.path}" does not exist` })
      continue
    }
    if (!(await pathExists(cwd, path))) {
      failures.push({ code: 'missing-reference', detail: `"${path}" does not exist` })
    }
  }
  return failures
}

function jevQuestions(askNeedsUser: boolean): Record<string, string> {
  const questions: Record<string, string> = {
    consistent: CONSISTENT_Q,
    ready: READY_Q
  }
  if (askNeedsUser) {
    questions.needs_user = NEEDS_USER_Q
  }
  return questions
}

// Why: the judge must see what the agent will see, including the question it asks first.
function previewPrompt(item: PlannedItem, fields: PreparedFields, request: string): string {
  return renderSessionPrompt({
    fields,
    item,
    index: 0,
    request,
    batchId: 'preview',
    ask: askFrom(fields),
    siblings: [],
    unresolved: []
  })
}

// Measured live: with the person's answer still pending, JEV reads the gap as "not ready" and a
// "contradiction", and the preparer may hold a placeholder for it. Repairing those only burns rounds.
// A contradiction JEV is confident about (P < 0.2, where its answers are reliable) is real either way;
// a model judge's yes/no carries no such confidence.
const PENDING_ANSWER_CODES = new Set(['not-ready', 'contradiction', 'placeholder'])
const CONFIDENT_CONTRADICTION = 0.2
function withAcceptedAsk(verdict: GateVerdict, jevScored: boolean): GateVerdict {
  if (!verdict.ask) {
    return verdict
  }
  const confidentContradiction =
    jevScored && (verdict.scores.consistent ?? 1) < CONFIDENT_CONTRADICTION
  const failures = verdict.failures.filter(
    (failure) =>
      !PENDING_ANSWER_CODES.has(failure.code) ||
      (failure.code === 'contradiction' && confidentContradiction)
  )
  return { ...verdict, failures, pass: failures.length === 0 }
}

function askFrom(fields: PreparedFields): GateVerdict['ask'] {
  if (!fields.blockingQuestion) {
    return null
  }
  return { question: fields.blockingQuestion.question, options: fields.blockingQuestion.options }
}

function applyScoreFailures(
  failures: GateFailure[],
  scores: Record<string, number>
): GateFailure[] {
  const next = [...failures]
  if ((scores.consistent ?? 0) < 0.5) {
    next.push({ code: 'contradiction', detail: CONTRADICTION_DETAIL })
  }
  if ((scores.ready ?? 0) < 0.5) {
    next.push({ code: 'not-ready', detail: NOT_READY_DETAIL })
  }
  return next
}

async function runModelJudge<T extends Record<string, boolean | undefined>>(
  input: {
    item: PlannedItem
    fields: PreparedFields
    request: string
    context: string
    cwd: string
  },
  deps: SessionPrepGateDeps,
  prompt: string,
  schema: z.ZodType<T>
): Promise<Record<string, number>> {
  const raw = await deps.runText({
    cwd: input.cwd,
    prompt,
    agent: deps.agent,
    model: deps.model,
    effort: deps.effort,
    timeoutMs: deps.timeoutMs
  })
  const parsed = parseModelJson(raw, schema)
  if (!parsed) {
    throw new Error('model judge returned no usable result')
  }
  const scores: Record<string, number> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'boolean') {
      scores[key] = value ? 1 : 0
    }
  }
  return scores
}

function fullJudgePrompt(state: Record<string, string>, includeNeedsUser: boolean): string {
  const schema = includeNeedsUser
    ? '{"consistent": true|false, "ready": true|false, "needs_user": true|false}'
    : '{"consistent": true|false, "ready": true|false}'
  const questions = [
    `consistent: ${CONSISTENT_Q}`,
    `ready: ${READY_Q}`,
    ...(includeNeedsUser ? [`needs_user: ${NEEDS_USER_Q}`] : [])
  ].join('\n')
  return `Judge this prepared agent prompt. Return ONLY JSON ${schema}.
user_request:
${state.user_request}
conversation_excerpt:
${state.conversation_excerpt}
prepared_prompt:
${state.prepared_prompt}
Questions (true = yes):
${questions}`
}

function needsUserJudgePrompt(state: Record<string, string>): string {
  return `Answer this single yes/no question about the prepared prompt. Return ONLY JSON {"needs_user": true|false}.
user_request:
${state.user_request}
conversation_excerpt:
${state.conversation_excerpt}
prepared_prompt:
${state.prepared_prompt}
Question: ${NEEDS_USER_Q}`
}

export async function gate(
  input: {
    item: PlannedItem
    fields: PreparedFields
    request: string
    context: string
    cwd: string
  },
  deps: SessionPrepGateDeps
): Promise<GateVerdict> {
  const failures = [
    ...checkPreparedFields(input.fields, input.request),
    ...(await missingReferenceFailures(input.fields.references, input.cwd, deps.pathExists))
  ]
  const hasDeterministic = failures.length > 0
  const includeNeedsUser = input.fields.blockingQuestion != null
  const state = {
    user_request: input.request,
    conversation_excerpt: input.context.slice(-4000),
    prepared_prompt: previewPrompt(input.item, input.fields, input.request)
  }
  const questions = jevQuestions(includeNeedsUser)

  let scores: Record<string, number> | null = null
  let jevError = deps.jevAsk ? undefined : 'JEV is not configured'
  if (deps.jevAsk) {
    try {
      scores = await deps.jevAsk(state, questions)
    } catch (error) {
      scores = null
      jevError = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)
    }
  }

  if (scores == null) {
    const noted = jevError ? { jevError } : {}
    if (hasDeterministic) {
      return { pass: false, failures, ask: null, scores: {}, judge: 'deterministic', ...noted }
    }
    try {
      const judged = await runModelJudge(
        input,
        deps,
        fullJudgePrompt(state, includeNeedsUser),
        modelJudgeSchema
      )
      return { ...finishVerdict(failures, judged, input.fields, false), ...noted }
    } catch (error) {
      if (isSessionPrepAccountFailure(error)) {
        throw error
      }
      return {
        pass: failures.length === 0,
        failures,
        ask: null,
        scores: {},
        judge: 'deterministic',
        ...noted
      }
    }
  }

  let judge: GateVerdict['judge'] = 'jev'
  let ask: GateVerdict['ask'] = null
  let next = applyScoreFailures(failures, scores)
  if (includeNeedsUser) {
    const probability = scores.needs_user ?? 0
    if (probability >= 0.8) {
      ask = askFrom(input.fields)
    } else if (probability < 0.5) {
      next.push({ code: 'needless-question', detail: NEEDLESS_DETAIL })
    } else {
      judge = 'model'
      try {
        const judged = await runModelJudge(
          input,
          deps,
          needsUserJudgePrompt(state),
          needsUserSchema
        )
        if ((judged.needs_user ?? 0) >= 0.8) {
          ask = askFrom(input.fields)
        } else {
          next.push({ code: 'needless-question', detail: NEEDLESS_DETAIL })
        }
      } catch (error) {
        if (isSessionPrepAccountFailure(error)) {
          throw error
        }
        // Why: JEV was unsure and the judge could not answer; asking costs one answer,
        // silently dropping a question only the person can answer costs the session.
        ask = askFrom(input.fields)
      }
    }
  }
  return withAcceptedAsk({ pass: next.length === 0, failures: next, ask, scores, judge }, true)
}

function finishVerdict(
  failures: GateFailure[],
  scores: Record<string, number>,
  fields: PreparedFields,
  fromJev: boolean
): GateVerdict {
  let next = applyScoreFailures(failures, scores)
  let ask: GateVerdict['ask'] = null
  if (fields.blockingQuestion) {
    if ((scores.needs_user ?? 0) >= 0.8) {
      ask = askFrom(fields)
    } else {
      next.push({ code: 'needless-question', detail: NEEDLESS_DETAIL })
    }
  }
  return withAcceptedAsk(
    {
      pass: next.length === 0,
      failures: next,
      ask,
      scores,
      judge: fromJev ? 'jev' : 'model'
    },
    fromJev
  )
}
