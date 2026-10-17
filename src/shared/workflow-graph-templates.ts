import { localWorkflowRouteNamesModel } from './local-workflow-seats'
import {
  WORKFLOW_FIND_DEFAULT_VERSIONS,
  WORKFLOW_ROUTES,
  workflowRouteMayJudge,
  type WorkflowRoute,
  type WorkflowSpec
} from './workflow-graph'
import { JEV_VERIFY_REJECT_AT } from './jev-confidence'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import { findWorkflow, workflowSetFind } from './workflow-graph-find'
import { improveWorkflow, JEV_FIRST } from './workflow-graph-improve'
import { decideWorkflow } from './workflow-graph-decide'
import { investigateWorkflow } from './workflow-graph-investigate'
import { quickDiscoverWorkflow } from './workflow-graph-quick-discover'

/**
 * The starting points ＋ → Workflows offers. Each is an ordinary spec built from the four step
 * kinds; nothing about them is special to the runtime, and each can be opened in the editor and
 * changed like any other workflow.
 */
export type WorkflowTemplateKey =
  | 'council'
  | 'discover'
  | 'quick-discover'
  | 'research-panel'
  | 'best-of-n'
  | 'improve'
  | 'find'
  | 'decide'
  | 'investigate'

/** Karpathy's llm-council chairman instruction (stage 3), minus the stage listing we add. */
export const COUNCIL_CHAIR_INSTRUCTION =
  "You are the Chairman of an LLM Council. Multiple AI models have provided responses to a user's question, and then ranked each other's responses. Synthesize all of this information into a single, comprehensive, accurate answer to the user's original question. Consider the individual responses and their insights, the peer rankings and what they reveal about response quality, and any patterns of agreement or disagreement. Provide a clear, well-reasoned final answer that represents the council's collective wisdom. When a JEV scorecard names the response that leads each criterion, build each part from its leader and keep the top-ranked response's structure where it already leads; never invent evidence no response contains."

export const DISCOVER_BRIEF_INSTRUCTION =
  "Before anyone searches, write the brief every later step works from. Read the goal; if it concerns a codebase, check that this workspace actually contains what the goal names. Answer under exactly these headings. ## Scope: SCOPE: OK, or SCOPE: MISMATCH and what is missing (for example the goal names a product or branch this workspace does not contain). ## What counts: what a valuable result is for this goal (a defect, an improvement, a hypothesis, an idea, an ad angle, an opportunity) and what is out of scope. ## Evidence: what a credible result must show (for code: path:line, the quoted code, the trigger and the wrong result it leads to; otherwise the mechanism and the facts behind it). ## Lenses: three numbered lenses the finders search through, each a different way to look; when the goal asks for improvements, opportunities or solutions, make at least one of them generative (first principles, an analogy from another field, or what becomes possible once a constraint is removed), so the finders propose new approaches as well as faults. ## Checks: three numbered ways a reviewer can confirm or refute one result, strongest first. ## Rubric: five bullet questions a fast scorer answers 0-4 from one result's text alone, together deciding whether it is valuable for this goal and credible. ## Severity: what critical, high, medium and low mean for this goal."

export const DISCOVER_SCOUT_INSTRUCTION =
  "Following the brief, map what matters for the goal (only the focus, if one is given) into as few areas as cover it: parts of the workspace for code, otherwise sub-questions, segments or sources (at most 6). Each area is searched separately through the brief's lenses, so do not split what one careful reader can hold. For each area: title = a short name; detail = why it matters for the goal; location = the files or folders it covers, or a short tag. If the brief says SCOPE: MISMATCH, return no areas. Do not report results yet."

export const DISCOVER_FIND_INSTRUCTION =
  "Find results in this area that fit the brief's \"What counts\", through the lens your angle names. Read the area's material completely; for code, trace the actual control flow. Report only results that meet the brief's Evidence standard, each with location (path:line for code, otherwise the source), a severity as the brief defines it, and detail = what it is, why it matters for the goal, the evidence (quote it) and what to do about it. For a code defect give the trigger, the concrete failure scenario (input or state → wrong result), the quoted code and the fix. For an improvement, opportunity or idea give the concrete proposal, why it would work here (the mechanism and the facts behind it), what is new about it compared with what exists, its expected effect and the smallest first step that would test it. Be adversarial and specific: report nothing rather than something you cannot back."

export const DISCOVER_VERIFY_INSTRUCTION =
  "A finder reported the result below. Your job is to REFUTE it if you can, using the check your angle names from the brief. Open the sources and trace them; for code, look for guards upstream, callers that make the trigger impossible, and tests that pin the behaviour. VERDICT: PASS means the result is real and meets the brief's Evidence standard; VERDICT: FAIL means it is refuted (quote what proves it wrong); VERDICT: UNSURE means the evidence does not settle it either way. Never guess."

export const DISCOVER_REPORT_INSTRUCTION =
  "Write the Discover report for the goal. If the brief's scope is not OK, say so first. Open with three plain sentences a busy person can act on: what was found, what to do first, and why. Rank the confirmed results by their value for the goal (for defects: blast radius — what breaks, for whom and how often). For each give the title, location, severity, the evidence, what to do, its effort (small, medium or large), and whether it can be acted on independently of the others. Where results combine into a stronger solution than any one alone, say so where you rank the strongest of them. Then list the unverified results briefly, marked as unverified, with their JEV scores where given. Mention refuted results, and any results a screen set aside, only as counts. Do not invent results that are not listed below."

const DISCOVER_FIND_ANGLES = [
  'lens 1 from the brief',
  'lens 2 from the brief',
  'lens 3 from the brief'
] as const
const DISCOVER_VERIFY_ANGLES = [
  'check 1 from the brief (the strongest)',
  'check 2 from the brief',
  'check 3 from the brief'
] as const
/** Measured on a real run: the first review matched the three-vote verdict 32 of 32 times. */
const DISCOVER_VERIFY_LIMIT = 40
const DISCOVER_ESCALATE_MAX = 8
/**
 * The model Discover's Find runs on by default. Sal, 2026-10-13: "haiku 5.5 is fine.
 * but its so much faster". The steps that judge or write for a person stay on each family's
 * default (frontier) seat: Scout, the Brief that sets the lenses, Verify (another family checks every
 * finding, and JEV sets aside what it can), and the Report. Its Claude CLI floor is 2.1.293.
 */
export const DISCOVER_FAST_MODEL = { route: 'claude', model: 'claude-haiku-5-5' } as const
export const DISCOVER_GEMINI_FAST_MODEL = { route: 'gemini', model: 'gemini-3.8-flash' } as const

function rotate<T>(values: readonly T[], offset: number): T[] {
  return values.map((_, index) => values[(index + offset) % values.length])
}

function available(routes: readonly WorkflowRoute[]): WorkflowRoute[] {
  const list = WORKFLOW_ROUTES.filter(
    (route) => !localWorkflowRouteNamesModel(route) && routes.includes(route)
  )
  return list.length ? list : ['claude']
}

function judges(routes: readonly WorkflowRoute[]): WorkflowRoute[] {
  const list = available(routes).filter((route) => workflowRouteMayJudge(route))
  return list.length ? list : ['claude']
}

/** Karpathy's llm-council: every model answers, the others rank them blind, a chairman decides. */
function council(routes: readonly WorkflowRoute[]) {
  const members = available(routes)
  const voters = members.filter((route) => workflowRouteMayJudge(route))
  return {
    title: 'Council',
    template: 'council',
    finalCheck: { rank: 'rank', chair: 'chair' },
    steps: [
      {
        id: 'answer',
        kind: 'do',
        title: 'First opinions',
        instruction: '',
        agents: members.map((route) => ({ route })),
        inputs: []
      },
      {
        id: 'rank',
        kind: 'rank',
        title: 'Peer rankings',
        instruction: '',
        agents: (voters.length ? voters : ['claude']).map((route) => ({ route })),
        inputs: ['answer'],
        jev: JEV_FIRST
      },
      {
        id: 'chair',
        kind: 'synthesize',
        title: "Chairman's answer",
        instruction: COUNCIL_CHAIR_INSTRUCTION,
        agents: [{ route: judges(routes)[0] }],
        inputs: ['answer', 'rank']
      }
    ]
  }
}

/**
 * Brief the search (scope, what counts, evidence, lenses, checks, rubric), scout the areas, find
 * results in each through the brief's three lenses, verify the highest-impact ones with one
 * refute-first review each and two more only on doubt (JEV setting aside what they leave
 * unverified), repeat until nothing new, report. Find runs on the fast model when Claude
 * is set up and another family can verify; Verify then leads with the other families, so a finding
 * is still checked by a family that did not write it.
 */
function discover(routes: readonly WorkflowRoute[], depth: 'quick' | 'thorough' = 'thorough') {
  const verifiers = judges(routes)
  const finders = available(routes).filter((route) => verifiers.some((judge) => judge !== route))
  const eligible = finders.length ? finders : available(routes)
  // Claude stays available to verify when Gemini is the only other finder family.
  const othersCheck = verifiers.some((route) => route !== DISCOVER_FAST_MODEL.route)
  const fast =
    eligible.includes(DISCOVER_FAST_MODEL.route) && othersCheck ? DISCOVER_FAST_MODEL : undefined
  const fastFinders =
    fast && eligible.includes(DISCOVER_GEMINI_FAST_MODEL.route) && verifiers.length >= 2
      ? [fast, DISCOVER_GEMINI_FAST_MODEL, fast]
      : fast
        ? [fast]
        : undefined
  return {
    title: 'Discover',
    template: 'discover',
    steps: [
      {
        id: 'brief',
        kind: 'do',
        title: 'Brief',
        instruction: DISCOVER_BRIEF_INSTRUCTION,
        agents: [{ route: verifiers[0] }],
        inputs: []
      },
      {
        id: 'scout',
        kind: 'do',
        title: 'Scout',
        instruction: DISCOVER_SCOUT_INSTRUCTION,
        agents: [fast ? { ...fast } : { route: verifiers[0] }],
        inputs: ['brief'],
        list: { maxItems: 6 }
      },
      {
        id: 'find',
        kind: 'do',
        title: 'Find',
        instruction: DISCOVER_FIND_INSTRUCTION,
        agents: DISCOVER_FIND_ANGLES.map((angle, index) =>
          fastFinders
            ? { ...fastFinders[index % fastFinders.length], angle }
            : { route: eligible[index % eligible.length], angle }
        ),
        inputs: ['brief', 'scout'],
        forEach: { step: 'scout', limit: 6 },
        list: { maxItems: 6, evidence: true }
      },
      {
        id: 'verify',
        kind: 'review',
        title: 'Verify',
        instruction: DISCOVER_VERIFY_INSTRUCTION,
        // Offset by one so a finding's votes lean towards families other than its finder's.
        agents: DISCOVER_VERIFY_ANGLES.map((angle, index) => ({
          route: rotate(verifiers, 1)[index % verifiers.length],
          angle
        })),
        inputs: ['brief', 'find'],
        forEach: {
          step: 'find',
          limit: DISCOVER_VERIFY_LIMIT,
          order: 'impact',
          merge: 'root-cause'
        },
        escalate: { max: DISCOVER_ESCALATE_MAX, crossFamily: true, standIn: true },
        // JEV sets aside what the reviewers left unverified at p <= 0.1 and never confirms
        // (JEV Lab, 2026-09-28); without JEV nothing changes. Set explicitly, so a copy of this
        // step discards on purpose.
        jevVerify: { mode: 'live', rejectAt: JEV_VERIFY_REJECT_AT }
      },
      {
        id: 'report',
        kind: 'synthesize',
        title: 'Report',
        instruction: DISCOVER_REPORT_INSTRUCTION,
        agents: [{ route: verifiers[0] }],
        inputs: ['brief', 'verify'],
        rankItems: true,
        rankEstimates: true
      }
    ],
    ...(depth === 'thorough'
      ? { repeat: { do: 'find', review: 'verify', until: 'nothing-new', maxRounds: 2 } }
      : {})
  }
}

/** Sal's example: four researchers, two critics, one synthesizer; Investigate supersedes it. */
function researchPanel(routes: readonly WorkflowRoute[]) {
  const all = available(routes)
  return {
    title: 'Research panel',
    template: 'custom',
    steps: [
      {
        id: 'research',
        kind: 'do',
        title: 'Research',
        instruction: 'Research the question independently and thoroughly. Show your evidence.',
        agents: [0, 1, 2, 3].map((index) => ({ route: all[index % all.length] })),
        inputs: []
      },
      {
        id: 'critics',
        kind: 'review',
        title: 'Critics',
        instruction:
          'Critique the research below: what is wrong, unsupported, missing or contradictory across the responses? Be specific.',
        agents: [0, 1].map((index) => {
          const critics = rotate(judges(routes), 1)
          return { route: critics[index % critics.length] }
        }),
        inputs: ['research']
      },
      {
        id: 'final',
        kind: 'synthesize',
        title: 'Final answer',
        instruction:
          'Write the single best final answer, using the strongest research and correcting everything the critics found.',
        agents: [{ route: judges(routes)[0] }],
        inputs: ['research', 'critics']
      }
    ]
  }
}

export function workflowTemplate(
  key: WorkflowTemplateKey,
  routes: readonly WorkflowRoute[] = WORKFLOW_ROUTES,
  options: { depth?: 'quick' | 'thorough'; count?: number } = {}
): WorkflowSpec {
  const raw =
    key === 'council'
      ? council(routes)
      : key === 'discover'
        ? discover(routes, options.depth)
        : key === 'improve'
          ? improveWorkflow(available(routes), options.count)
          : key === 'find' || key === 'best-of-n'
            ? findWorkflow(available(routes), key === 'find' ? options.count : undefined)
            : key === 'decide'
              ? decideWorkflow(available(routes))
              : key === 'investigate'
                ? investigateWorkflow(available(routes))
                : key === 'quick-discover'
                  ? quickDiscoverWorkflow(available(routes))
                  : researchPanel(routes)
  const spec = normalizeWorkflowSpec(raw, available(routes))
  // Runs through the Find engine (versions: true) but keeps its own tab identity and label.
  return key === 'best-of-n'
    ? {
        ...workflowSetFind(
          spec,
          { versions: true, count: options.count ?? WORKFLOW_FIND_DEFAULT_VERSIONS },
          available(routes)
        ),
        template: 'best-of-n' as const
      }
    : spec
}
