import { sessionChainStepOutputDir, type SessionChain } from './session-chain-types'
import { WORK_PLAN_ARTIFACT_SCHEMA } from './work-plan-artifact-schema'
import type { WorkPlanOutputKind } from './work-plan-types'

/** The two files a Plan Mode step delivers: the machine one and the one a person reads. */
export const WORK_PLAN_ARTIFACT_FILE = 'plan.json'
export const WORK_PLAN_DOCUMENT_FILE = 'plan.md'

/** Where this step's output lives. Same convention as every other step: `.omni/runs/<chain>/<step>`. */
export function workPlanOutputDirFor(chain: SessionChain, stepId: string): string {
  return sessionChainStepOutputDir(chain.workspacePath, chain.id, stepId)
}

/**
 * The absolute path of the plan document this step must deliver. Pure, so the row, the View Plan
 * report and the publisher all name the same file without asking the host (WP-7 reads this).
 */
export function planArtifactPathFor(chain: SessionChain, stepId: string): string {
  const dir = workPlanOutputDirFor(chain, stepId)
  return `${dir}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}${WORK_PLAN_ARTIFACT_FILE}`
}

export type WorkPlanPlanOutputContract = {
  outputDir: string
  outputKind: Extract<WorkPlanOutputKind, 'plan' | 'mockup'>
  /** The Done When statements this plan must take the workspace towards, in the person's words. */
  doneWhen?: string[]
}

const SHAPE = [
  '{',
  `  "schema": "${WORK_PLAN_ARTIFACT_SCHEMA}",`,
  '  "title": "one line",',
  '  "summary": "what you propose and why, in prose",',
  '  "assumptions": ["what you assumed because it was not stated"],',
  '  "steps": [',
  '    {',
  '      "n": 1,',
  '      "title": "one line",',
  '      "detail": "what is done, precisely enough to execute",',
  '      "files": ["workspace/relative/path"],',
  '      "owner": "who does it",',
  '      "dependsOn": []',
  '    }',
  '  ],',
  '  "risks": ["what could go wrong and how it shows"],',
  '  "openQuestions": ["what a decision still needs"],',
  '  "mockups": [{ "file": "mockup-name.html", "title": "what it shows" }],',
  '  "estimate": "what it is expected to cost"',
  '}'
].join('\n')

/**
 * The planner's contract: PLAN, do not implement.
 *
 * Why the workspace rule is stated to the agent and ALSO checked by the host: the check
 * (`session-outcome-evidence`, `plan step changed N workspace files`) is what makes the promise
 * true, but an agent that is never told will trip it honestly and lose its whole run. `dependsOn`
 * may only name earlier steps — the schema refuses the rest, so the instruction says so first.
 */
export function workPlanPlanOutputContract(input: WorkPlanPlanOutputContract): string {
  const mockups = input.outputKind === 'mockup'
  return [
    mockups
      ? 'Produce a MOCKUP and the plan behind it. Do not implement the product itself.'
      : 'PLAN this work. Do not implement it.',
    ...(input.doneWhen?.length
      ? [
          'The plan must take the current state to each of these, and say which step reaches which:',
          ...input.doneWhen.map((entry) => `- ${entry}`)
        ]
      : []),
    `Write exactly two files into ${input.outputDir}, and nothing anywhere else:`,
    `1. ${WORK_PLAN_ARTIFACT_FILE} — JSON matching the ${WORK_PLAN_ARTIFACT_SCHEMA} schema:`,
    SHAPE,
    `   \`dependsOn\` may only name an earlier \`n\`. \`files\` are workspace-relative paths you PROPOSE to change, not files you change now.`,
    `2. ${WORK_PLAN_DOCUMENT_FILE} — the same plan as prose, for a person to read.`,
    ...(mockups
      ? [
          `Also write one self-contained HTML mockup per screen into ${input.outputDir}, and list every one of them in \`mockups\` with the file name and what it shows. A mockup is one HTML file with its own styles inline and no network requests.`
        ]
      : []),
    'Change NO other file in the workspace: no source edits, no installs, no commits, no branches. The execution host compares the workspace before and after this step and refuses a plan that changed it.',
    'End your reply with one line stating that you verified both files exist, that plan.json parses as JSON, and that you changed nothing else in the workspace.'
  ].join('\n')
}
