import { isIndependentLineage, modelLineage } from '../../shared/model-lineage'
import {
  WORK_PLAN_ROLES,
  type WorkPlan,
  type WorkPlanActor,
  type WorkPlanContext,
  type WorkPlanNode,
  type WorkPlanRole
} from '../../shared/work-plan-types'

/**
 * Deterministic natural-language parsing for `session-outcome-propose.ts`, split out to keep
 * both files under the per-file line budget. See that module's file header for why this is a
 * heuristic rather than a live model call.
 */

const QUESTION_OPENER =
  /^(?:what|which|who|whom|whose|when|where|why|how|does|do|did|is|are|was|were|can|could|should|would|will|shall)\b/i

type RoleWord = { pattern: RegExp; role: WorkPlanRole }

/** Every WORK_PLAN_ROLES entry plus the "-er"/"-ers"/"-or"/"-ors" agent-noun a person says. */
const ROLE_NOUNS: Record<WorkPlanRole, string[]> = {
  research: ['research', 'researcher', 'researchers'],
  plan: ['plan', 'planner', 'planners'],
  analyze: ['analyze', 'analyse', 'analyst', 'analysts'],
  implement: ['implement', 'implementer', 'implementers', 'build', 'builder', 'builders'],
  improve: ['improve', 'improver', 'improvers'],
  critique: ['critique', 'critic', 'critics'],
  review: ['review', 'reviewer', 'reviewers'],
  verify: ['verify', 'verifier', 'verifiers'],
  compare: ['compare', 'comparer', 'comparers'],
  judge: ['judge', 'judges'],
  synthesize: ['synthesize', 'synthesise', 'synthesis', 'synthesizer'],
  summarize: ['summarize', 'summarise', 'summary'],
  test: ['test', 'tester', 'testers'],
  repair: ['repair', 'repairer', 'repairers', 'fix', 'fixer', 'fixers']
}

const ROLE_WORDS: RoleWord[] = WORK_PLAN_ROLES.flatMap((role) =>
  ROLE_NOUNS[role].map((word) => ({ role, pattern: new RegExp(`\\b${word}\\b`, 'i') }))
)

const JUDGE_WORD = /\bjudge(?:s)?\b/i

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10
}

/** A statement of a workflow to run, not a question or discussion about one. */
export function looksLikePursuit(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) {
    return false
  }
  if (/\?\s*$/.test(trimmed)) {
    return false
  }
  if (QUESTION_OPENER.test(trimmed)) {
    return false
  }
  return ROLE_WORDS.some((entry) => entry.pattern.test(trimmed)) || JUDGE_WORD.test(trimmed)
}

function countIn(clause: string): number | undefined {
  const digit = /\b(\d+)\b/.exec(clause)
  if (digit) {
    return Number(digit[1])
  }
  const word = /\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(clause)
  return word ? NUMBER_WORDS[word[1]!.toLowerCase()] : undefined
}

function roleIn(clause: string): WorkPlanRole | undefined {
  return ROLE_WORDS.find((entry) => entry.pattern.test(clause))?.role
}

function defaultActor(ctx: WorkPlanContext): WorkPlanActor {
  const first = ctx.usableAgents[0]
  return first ? { agent: first.agent, model: first.models[0]?.id } : { agent: 'claude' }
}

/** A judge from a family none of `candidates` belong to, so the plan never fails its own check. */
function judgeActor(ctx: WorkPlanContext, candidates: readonly WorkPlanActor[]): WorkPlanActor {
  const families = new Set(candidates.map((actor) => modelLineage(actor.agent, actor.model)))
  const independent = ctx.usableAgents.find((agent) =>
    agent.models.length > 0
      ? agent.models.some((model) =>
          [...families].every((family) =>
            isIndependentLineage(family, modelLineage(agent.agent, model.id))
          )
        )
      : [...families].every((family) => isIndependentLineage(family, modelLineage(agent.agent)))
  )
  if (independent) {
    return { agent: independent.agent, model: independent.models[0]?.id }
  }
  // No usable agent is independent of the candidates (including the unconstrained default
  // host, which offers no diversity at all); fall back to a fixed second family so the
  // validator's refusal -- not a silent same-family judge -- is what the person sees.
  return { agent: 'codex' }
}

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  return `${prefix}_${seq}`
}

/**
 * Deterministic heuristic parse of a comma/"then"-separated description into the WorkPlan
 * authoring model. Recognises: "<N> <role noun>[s]" worker stages, "judge picks"/"a judge"
 * (select-winner over the previous group), "the winner <role>s" (readsWinnerOf the judge), and
 * "then me"/"to me"/"back to me" (finish how:'my-review'); everything else finishes 'complete'.
 */
export function heuristicParse(
  text: string,
  ctx: WorkPlanContext,
  outcomeTitle: string
): WorkPlan | null {
  seq = 0
  const clauses = text
    .split(/(?:,| then | and then | and |;)/i)
    .map((clause) => clause.trim())
    .filter(Boolean)
  const nodes: WorkPlanNode[] = []
  let previousGroup: string | undefined
  let previousJudgeId: string | undefined
  let finishHow: 'complete' | 'my-review' = 'complete'

  for (const clause of clauses) {
    if (
      /^(?:me|myself|i)$/i.test(clause) ||
      /\b(?:to me|back to me|hand(?:s|ed)? to me|give(?:s)? it to me|i decide|i(?:'ll)? take it)\b/i.test(
        clause
      )
    ) {
      finishHow = 'my-review'
      continue
    }
    if (/\bwinner\b/i.test(clause) && previousJudgeId) {
      const role = roleIn(clause) ?? 'improve'
      const id = nextId(role)
      nodes.push({
        kind: 'worker',
        id,
        role,
        actor: defaultActor(ctx),
        instruction: '',
        readsWinnerOf: previousJudgeId
      })
      previousGroup = undefined
      continue
    }
    if (JUDGE_WORD.test(clause)) {
      const over = previousGroup
        ? nodes
            .filter((node) => node.kind === 'worker' && node.group === previousGroup)
            .map((node) => node.id)
        : nodes.length
          ? [nodes.at(-1)!.id]
          : []
      const candidateActors = nodes
        .filter((node) => over.includes(node.id))
        .flatMap((node) => (node.kind === 'worker' ? [node.actor] : []))
      const id = nextId('judge')
      nodes.push({
        kind: 'worker',
        id,
        role: 'judge',
        actor: judgeActor(ctx, candidateActors),
        instruction: '',
        readsFrom: over,
        verdict: { kind: 'judge', over, consumed: 'select-winner' }
      })
      previousJudgeId = id
      previousGroup = undefined
      continue
    }
    const role = roleIn(clause)
    if (!role) {
      continue
    }
    const count = countIn(clause) ?? 1
    const group = count > 1 ? nextId('group') : undefined
    if (count > 1) {
      for (let seat = 0; seat < count; seat += 1) {
        nodes.push({
          kind: 'worker',
          id: nextId(role),
          role,
          actor: defaultActor(ctx),
          instruction: '',
          group
        })
      }
    } else {
      nodes.push({
        kind: 'worker',
        id: nextId(role),
        role,
        actor: defaultActor(ctx),
        instruction: ''
      })
    }
    previousGroup = group
  }

  if (nodes.length === 0) {
    return null
  }
  nodes.push({ kind: 'finish', id: nextId('finish'), how: finishHow })

  return {
    outcome: {
      title: outcomeTitle,
      doneWhen: [],
      outputKind: 'work'
    },
    nodes
  }
}
