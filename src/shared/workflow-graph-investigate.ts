import { workflowRouteMayJudge, type WorkflowRoute } from './workflow-graph'
import { families } from './workflow-graph-improve'

export const INVESTIGATE_SPLIT_INSTRUCTION =
  'Before anyone investigates, split the question into three distinct angles, each a different way to find out what is true (for example what the code or documents actually do, what changed over time, and what the sources involved say). Do not answer the question yet. Answer under exactly these headings. ## Question: the question in one sentence, and what a good answer must settle. ## Angle 1, ## Angle 2, ## Angle 3: for each, what to look into, where to look (files, folders, documents or sources in this workspace) and what evidence would settle it; the angles must not overlap. ## Out of scope: what the investigation should leave alone.'

export const INVESTIGATE_FIND_INSTRUCTION =
  "Investigate the question alone, through the angle named below, following the split. Open the sources and read them yourself; for code, trace what it actually does. Report what you found as claims, each one statement that is either true or false, backed by evidence you opened: title = the claim in one sentence; detail = why it matters for the question and how the evidence supports it; location = where the evidence is (path:line for code or a document in this workspace, otherwise the source's name); severity 'none'; trigger = the one condition the claim depends on, or 'always'. Include claims that go against the obvious answer. Report nothing you cannot back with evidence."

export const INVESTIGATE_SYNTHESIS_INSTRUCTION =
  'Combine the three investigations into one answer tied to evidence. Answer under exactly these headings. ## Answer: the short answer to the question, and how sure it is. ## What holds: the claims the evidence supports, each with its evidence (path:line or source) and which investigators found it. ## What conflicts: claims that contradict each other, with the evidence on each side and which is stronger. ## What is open: what the evidence does not settle, and what would settle it. Use only the claims and evidence listed below; never add a claim no investigator made, and never present a claim as settled when its evidence is missing.'

export const INVESTIGATE_FACT_CHECK_INSTRUCTION =
  'You are the fact-checker. An investigator made the claim below, and the synthesis relies on it. Re-verify the evidence it cites: start from the evidence pack, open the source yourself and read around it. Say whether the evidence really says what the claim says, and whether the synthesis states the claim faithfully. VERDICT: PASS means you opened the cited evidence and it supports the claim; VERDICT: FAIL means the evidence contradicts the claim or does not say it (quote what does); VERDICT: UNSURE means you could not open or read the evidence, or it does not settle the claim. A claim without evidence you could open is never PASS.'

export const INVESTIGATE_SKEPTIC_INSTRUCTION =
  "You are the skeptic. Read the synthesis against the question, the three angles and the investigators' claims, and hunt for problems: conclusions that go further than their evidence, angles or sources nobody looked at, contradictions the synthesis glossed over, and claims treated as settled that are not. Name each problem specifically, with what would fix it. VERDICT: PASS means the synthesis claims no more than its evidence shows; VERDICT: FAIL means it overreaches or misses something that changes the answer; VERDICT: UNSURE means you cannot tell."

export const INVESTIGATE_ANSWER_INSTRUCTION =
  "Write the final answer to the question from the synthesis, corrected by the fact-check and the skeptic's review. Answer under exactly these headings. ## Answer: the answer and how sure it is. ## Key claims: what is confirmed, what is refuted and what is still open, in plain words. ## What to look at next: the cheapest checks that would settle what is open. Call a claim confirmed only when the fact-check confirmed it and you name its evidence; a claim the fact-check could not check is open, never confirmed. Do not add claims or evidence that are not listed below."

/** Each investigator reads its own angle from the split, as Discover's finders read the lenses. */
export const INVESTIGATE_ANGLES = [
  'angle 1 from the split',
  'angle 2 from the split',
  'angle 3 from the split'
] as const
/** Five claims each keeps every claim within the fact-check limit, so none goes unchecked. */
const INVESTIGATE_CLAIMS_PER_INVESTIGATOR = 5
const INVESTIGATE_FACT_CHECK_LIMIT = 15
const INVESTIGATE_ESCALATE_MAX = 3

/** What the answer must say about independence the roster could not give. */
function rosterNote(investigators: readonly WorkflowRoute[], checkers: readonly WorkflowRoute[]) {
  const count = new Set(investigators).size
  return [
    count < 3
      ? `Only ${count === 1 ? 'one model family' : `${count} model families`} investigated, so the three angles are less independent than they could be; say so in one line at the top of the answer.`
      : '',
    checkers.length < 2
      ? 'No second model family could check the work, so every check came from one family; say that too.'
      : ''
  ].filter(Boolean)
}

/** Different angles find different problems; checking the synthesis catches errors before people see them. */
export function investigateWorkflow(available: readonly WorkflowRoute[]) {
  const all = families(available)
  const judging = all.filter((route) => workflowRouteMayJudge(route))
  const checkers = judging.length ? judging : (['claude'] as WorkflowRoute[])
  const lead = checkers[0]!
  const investigators = INVESTIGATE_ANGLES.map((_, index) => all[index % all.length]!)
  // Checkers from families other than the synthesizer's; the writer's family only when needed.
  const others = checkers.filter((route) => route !== lead)
  const factCheckers =
    others.length >= 2 ? others.slice(0, 2) : others.length === 1 ? [others[0]!, lead] : [lead]
  const note = rosterNote(investigators, checkers)
  return {
    title: 'Investigate',
    template: 'investigate',
    steps: [
      {
        id: 'split',
        kind: 'do',
        title: 'Split',
        instruction: INVESTIGATE_SPLIT_INSTRUCTION,
        agents: [{ route: lead }],
        inputs: []
      },
      {
        id: 'investigate',
        kind: 'do',
        title: 'Investigate',
        instruction: INVESTIGATE_FIND_INSTRUCTION,
        agents: investigators.map((route, index) => ({ route, angle: INVESTIGATE_ANGLES[index] })),
        inputs: ['split'],
        list: { maxItems: INVESTIGATE_CLAIMS_PER_INVESTIGATOR, evidence: true }
      },
      {
        id: 'synthesis',
        kind: 'synthesize',
        title: 'Synthesis',
        instruction: INVESTIGATE_SYNTHESIS_INSTRUCTION,
        agents: [{ route: lead }],
        inputs: ['split', 'investigate']
      },
      {
        id: 'factcheck',
        kind: 'review',
        title: 'Fact-check',
        instruction: INVESTIGATE_FACT_CHECK_INSTRUCTION,
        agents: factCheckers.map((route) => ({ route, angle: 'fact-checker' })),
        inputs: ['synthesis', 'investigate'],
        forEach: { step: 'investigate', limit: INVESTIGATE_FACT_CHECK_LIMIT },
        // The first checker is from another family than the claim's investigator.
        ...(factCheckers.length > 1
          ? { escalate: { max: INVESTIGATE_ESCALATE_MAX, crossFamily: true, standIn: true } }
          : {})
      },
      {
        id: 'skeptic',
        kind: 'review',
        title: 'Skeptic',
        instruction: INVESTIGATE_SKEPTIC_INSTRUCTION,
        agents: [{ route: others.at(-1) ?? lead, angle: 'skeptic' }],
        inputs: ['split', 'investigate', 'synthesis']
      },
      {
        id: 'answer',
        kind: 'synthesize',
        title: 'Final answer',
        instruction: [INVESTIGATE_ANSWER_INSTRUCTION, ...note].join(' '),
        agents: [{ route: lead }],
        inputs: ['synthesis', 'factcheck', 'skeptic'],
        claimTable: true
      }
    ]
  }
}
