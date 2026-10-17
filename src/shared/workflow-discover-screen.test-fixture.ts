/** Discover as its template stood before 2026-09-27: JEV screened every finding by the brief's rubric. */

import { localWorkflowRouteNamesModel } from './local-workflow-seats'
import { WORKFLOW_ROUTES, type WorkflowRoute, type WorkflowSpec } from './workflow-graph'
import { workflowTemplate } from './workflow-graph-templates'

const SCREENED_REPORT_INSTRUCTION =
  "Write the Discover report for the goal. If the brief's scope is not OK, say so first. Rank the confirmed results by their value for the goal (for defects: blast radius — what breaks, for whom and how often). For each give the title, location, severity, the evidence, what to do, and whether it can be acted on independently of the others. Then list the unverified results briefly, marked as unverified, with their JEV scores where given. Mention refuted results and results set aside by the screen only as counts. Do not invent results that are not listed below."

/** That era's Brief and Find, before the generative lens and proposal wording of 2026-10-13. */
const SCREENED_BRIEF_INSTRUCTION =
  "Before anyone searches, write the brief every later step works from. Read the goal; if it concerns a codebase, check that this workspace actually contains what the goal names. Answer under exactly these headings. ## Scope: SCOPE: OK, or SCOPE: MISMATCH and what is missing (for example the goal names a product or branch this workspace does not contain). ## What counts: what a valuable result is for this goal (a defect, an improvement, a hypothesis, an idea, an ad angle, an opportunity) and what is out of scope. ## Evidence: what a credible result must show (for code: path:line, the quoted code, the trigger and the wrong result it leads to; otherwise the mechanism and the facts behind it). ## Lenses: three numbered lenses the finders search through, each a different way to look. ## Checks: three numbered ways a reviewer can confirm or refute one result, strongest first. ## Rubric: five bullet questions a fast scorer answers 0-4 from one result's text alone, together deciding whether it is valuable for this goal and credible. ## Severity: what critical, high, medium and low mean for this goal."
const SCREENED_FIND_INSTRUCTION =
  "Find results in this area that fit the brief's \"What counts\", through the lens your angle names. Read the area's material completely; for code, trace the actual control flow. Report only results that meet the brief's Evidence standard, each with location (path:line for code, otherwise the source), a severity as the brief defines it, and detail = what it is, why it matters for the goal, the evidence (quote it) and what to do about it. For a code defect give the trigger, the concrete failure scenario (input or state → wrong result), the quoted code and the fix. Be adversarial and specific: report nothing rather than something you cannot back."

const SCREEN_ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']

/** That era's finders: each family's default seat in turn, before Scout and Find ran on Haiku. */
function screenedFinders(routes: readonly WorkflowRoute[]): WorkflowRoute[] {
  const list = WORKFLOW_ROUTES.filter(
    (route) => !localWorkflowRouteNamesModel(route) && routes.includes(route)
  )
  return list.length ? list : ['claude']
}

/** The screen a saved spec or a spec-file overlay can still put on Verify, with that era's report text. */
export function withDiscoverScreen(
  spec: WorkflowSpec,
  routes: readonly WorkflowRoute[] = SCREEN_ROUTES
): WorkflowSpec {
  const finders = screenedFinders(routes)
  const brief = spec.steps.find((step) => step.id === 'brief')
  return {
    ...spec,
    steps: spec.steps.map((step) => {
      if (step.id === 'brief') {
        return { ...step, instruction: SCREENED_BRIEF_INSTRUCTION }
      }
      if (step.id === 'scout' && brief) {
        // Scout ran on the brief's seat.
        return { ...step, agents: brief.agents.map(({ route }) => ({ route })) }
      }
      if (step.id === 'find') {
        return {
          ...step,
          instruction: SCREENED_FIND_INSTRUCTION,
          agents: step.agents.map(({ angle }, index) => ({
            route: finders[index % finders.length],
            ...(angle ? { angle } : {})
          }))
        }
      }
      if (step.id === 'report') {
        const { rankEstimates: _rankEstimates, ...report } = step
        return { ...report, instruction: SCREENED_REPORT_INSTRUCTION }
      }
      if (step.id !== 'verify' || !step.forEach) {
        return step
      }
      const { step: source, limit, ...rest } = step.forEach
      // That era's Verify had no JEV verify (live since 2026-09-27), nor a stand-in reviewer.
      const { jevVerify: _jevVerify, ...verify } = step
      const { standIn: _standIn, ...escalate } = verify.escalate!
      // Same key order as the old template, so request digests replay byte for byte.
      return {
        ...verify,
        escalate,
        forEach: { step: source, limit, screen: { rubricFrom: 'brief' }, ...rest }
      }
    })
  }
}

export function screenedDiscover(
  routes?: Parameters<typeof workflowTemplate>[1],
  options?: Parameters<typeof workflowTemplate>[2]
): WorkflowSpec {
  return withDiscoverScreen(
    workflowTemplate('discover', routes, options),
    routes ?? WORKFLOW_ROUTES
  )
}
