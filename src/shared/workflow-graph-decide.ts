import {
  workflowRouteMayJudge,
  type WorkflowRoute,
  type WorkflowSpec,
  type WorkflowStep
} from './workflow-graph'
import { families } from './workflow-graph-improve'
import { ONE_ANSWER_INSTRUCTION } from './workflow-one-answer'

export const DECIDE_FRAME_INSTRUCTION =
  "Frame the decision before anyone proposes options. Answer under exactly these headings. ## Decision: the decision in one sentence, whose it is, and by when. ## Hard limits: what any acceptable option must meet (budget, time, law, what must not change), one bullet each, or 'None stated.' when the question names none; never invent limits. ## Rubric: three to six bullet questions that together say what a good option is for this decision, most important first, each answerable 0-4 from one option's description alone. ## What would change the answer: the facts that, if they turned out differently, would change which option is best."

export const DECIDE_OPTIONS_INSTRUCTION =
  "Following the frame, come up with distinct options for the decision: as many as the list allows, each specific and different from the others, and at least three unconventional ones a careful expert might overlook. Leave out any option that breaks a hard limit in the frame. Each option gets a short title that names it and a detail of one to three sentences on what it is and why it could be the best choice. Leave location empty and severity 'none'."

export const DECIDE_DEVELOP_INSTRUCTION =
  "Develop this option for the decision in the frame, under exactly these headings. ## How it works: the concrete steps. ## Costs: money, time, effort and what it gives up. ## Risks: what could go wrong and how likely. ## Key assumption: the one thing that must be true for this to be the best choice. ## Test: the cheapest, fastest check that would prove that assumption wrong. Be specific, stay within the frame's hard limits, and argue only for this option, not against the others."

export const DECIDE_CRUX_INSTRUCTION =
  'The comparison left the top two options close. Name them, find the one assumption that decides between them (true, the first is better; false, the second), and name the cheapest, fastest test that would settle it. Answer under exactly these headings. ## The two. ## The deciding assumption. ## The cheapest test: what to do, how long it takes, and what each result would mean.'

export const DECIDE_MEMO_INSTRUCTION =
  "Write the decision memo. Recommend the option the comparison placed first overall, made stronger with the best parts of the other finalists where they lead on a rubric line, as long as it stays within every hard limit in the frame; never invent evidence no finalist contains. Answer under exactly these headings. ## Recommendation: the choice and its first steps. ## Why: how it meets each line of the rubric. ## What you give up: what the runner-up does better. ## When to switch: the evidence that would make the runner-up the better choice. ## Next test: the cheapest check to run first (the crux's test, if one is given)."

/** About twelve short options from each of two families, then four finalists developed. */
export const DECIDE_OPTIONS_PER_MODEL = 12
export const DECIDE_FINALISTS = 4

/** The strongest first; Gemini may propose options but never frames, develops or judges. */
function judging(available: readonly WorkflowRoute[]): WorkflowRoute[] {
  const list = families(available).filter((route) => workflowRouteMayJudge(route))
  return list.length ? list : ['claude']
}

/** The step that answers a one-answer question alone (off unless the person turns it on). */
function oneAnswerStepFor(route: WorkflowRoute, id = 'direct'): WorkflowStep {
  return {
    id,
    kind: 'do',
    title: 'One answer',
    instruction: ONE_ANSWER_INSTRUCTION,
    agents: [{ route }],
    inputs: []
  }
}

/**
 * Turns one-answer routing on or off: on adds the one-model step and the route, off removes both.
 * Only a sure JEV reading uses it; the full workflow stays the fallback either way.
 */
export function workflowSetOneAnswer(
  spec: WorkflowSpec,
  on: boolean,
  available: readonly WorkflowRoute[]
): WorkflowSpec {
  const { oneAnswer, ...rest } = spec
  const steps = spec.steps.filter((step) => step.id !== oneAnswer?.step)
  if (!on) {
    return { ...rest, steps }
  }
  const id = steps.some((step) => step.id === 'direct') ? 'one-answer' : 'direct'
  return {
    ...rest,
    oneAnswer: { step: id },
    steps: [oneAnswerStepFor(judging(available)[0]!, id), ...steps]
  }
}

/**
 * Decide: frame the decision (hard limits, a 3-6 line rubric), go wide with two families' options,
 * narrow to a varied shortlist by JEV against the frame, develop each finalist, compare them one
 * rubric line at a time, find the crux when the top two are close, and recommend. With
 * `oneAnswer`, a question JEV is sure has one right answer goes to one model alone.
 */
export function decideWorkflow(
  available: readonly WorkflowRoute[],
  options: { oneAnswer?: boolean } = {}
) {
  const lead = judging(available)[0]!
  const wide = families(available).slice(0, 2)
  // Judges from families other than the developer's, so every vote counts.
  const others = judging(available).filter((route) => route !== lead)
  const judges = (others.length ? others : [lead]).slice(0, 2)
  return {
    title: 'Decide',
    template: 'decide',
    // The guard: the memo against the best finalist, then a skeptic against the frame's limits.
    finalCheck: { rank: 'compare', chair: 'memo', skeptic: 'frame' },
    ...(options.oneAnswer ? { oneAnswer: { step: 'direct' } } : {}),
    steps: [
      ...(options.oneAnswer ? [oneAnswerStepFor(lead)] : []),
      {
        id: 'frame',
        kind: 'do',
        title: 'Frame',
        instruction: DECIDE_FRAME_INSTRUCTION,
        agents: [{ route: lead }],
        inputs: []
      },
      {
        id: 'options',
        kind: 'do',
        title: 'Options',
        instruction: DECIDE_OPTIONS_INSTRUCTION,
        agents: [0, 1].map((index) => ({ route: wide[index % wide.length]! })),
        inputs: ['frame'],
        list: { maxItems: DECIDE_OPTIONS_PER_MODEL }
      },
      {
        id: 'develop',
        kind: 'do',
        title: 'Develop',
        instruction: DECIDE_DEVELOP_INSTRUCTION,
        agents: [{ route: lead }],
        inputs: ['frame', 'options'],
        forEach: {
          step: 'options',
          limit: DECIDE_FINALISTS,
          screen: { rubricFrom: 'frame', shortlist: true }
        }
      },
      {
        id: 'compare',
        kind: 'rank',
        title: 'Compare',
        instruction: '',
        agents: judges.map((route) => ({ route })),
        inputs: ['frame', 'develop'],
        byCriterion: { rubricFrom: 'frame' }
      },
      {
        id: 'crux',
        kind: 'do',
        title: 'Crux',
        instruction: DECIDE_CRUX_INSTRUCTION,
        agents: [{ route: lead }],
        inputs: ['frame', 'develop', 'compare'],
        whenClose: 'compare'
      },
      {
        id: 'memo',
        kind: 'synthesize',
        title: 'Recommend',
        instruction: DECIDE_MEMO_INSTRUCTION,
        agents: [{ route: lead }],
        inputs: ['frame', 'develop', 'compare', 'crux']
      }
    ]
  }
}
