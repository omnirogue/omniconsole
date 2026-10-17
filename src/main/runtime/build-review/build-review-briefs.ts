import type { BuildReviewAgentChoice } from '../../../shared/build-review-pipeline'
import { REVIEW_FINDINGS_MARKER } from '../../../shared/review-findings'
import type { ReviewRubric } from '../../../shared/review-rubrics'

const FINDINGS_EXAMPLE = `${REVIEW_FINDINGS_MARKER} ${JSON.stringify({
  findings: [
    {
      id: 'F1',
      severity: 'blocker',
      claim: 'what is wrong',
      location: 'path/to/file:line',
      evidence: { kind: 'quote', text: 'the exact code line', file: 'path/to/file' },
      fix: 'suggested fix'
    }
  ]
})}`

/** The findings contract: a blocker with evidence always blocks; only one without evidence does not. */
const EVIDENCE_RULES = [
  '- Rank every finding: blocker, major, minor or nit. Only a blocker can block; majors, minors and nits are suggestions.',
  '- Every blocker that carries evidence blocks. Give evidence by naming the file and line and quoting the code exactly: {"kind":"quote","text":"exact code","file":"path"}. A quote the app finds shows as located; a quote it cannot find shows as not found; evidence it cannot check (a remote workspace or an unreadable file) shows as not verified.',
  '- A repro command ({"kind":"command",...}) or a named test ({"kind":"test","file":"...","name":"..."}) is also shown as located and blocks; the app does not run either.',
  '- Never add or change files in the workspace. A blocker without evidence does not block.',
  '- The worker_done --body must end with exactly these two lines, in this order, each on its own line:',
  `  ${FINDINGS_EXAMPLE}`,
  '  VERDICT: APPROVE   (or VERDICT: REQUEST_CHANGES)',
  '- Put all findings on that one JSON line ({"findings":[]} when there are none). Use REQUEST_CHANGES only when you report at least one blocker with evidence; otherwise APPROVE and list suggestions as major, minor or nit.'
]

export function describeAgentChoice(choice: BuildReviewAgentChoice): string {
  const parts = [choice.agent]
  if (choice.model) {
    parts.push(choice.model)
  }
  if (choice.effort) {
    parts.push(choice.effort)
  }
  return parts.join(' / ')
}

export function buildBuilderSpec(args: { objective: string }): string {
  return [
    'BUILD TASK (Build + Review pipeline, builder role).',
    '',
    'Objective:',
    args.objective.trim(),
    '',
    'Rules:',
    // Why (2026-09-10): "current worktree only" was untrue for a builder the
    // runner placed in its own child worktree or its own workspace subfolder, and
    // it names a git concept in work that often has no repository at all.
    '- Work in the workspace you were started in. Do not create workspaces, worktrees or branches unless the objective says so.',
    '- Implement the objective completely, then run the relevant tests/typecheck yourself and fix what you broke.',
    '- Do not commit unless the objective asks for it; leave the changes in the working tree for review.',
    '- When done, send worker_done exactly once with --outcome succeeded or failed, --files-modified listing every file you touched, and a body with: what you changed, how you verified it (commands + tail of output), and anything left undone.',
    // Why (2026-09-07): a builder finished and verified its change, then reported
    // `failed` because two backend problems outside this repo remained — the
    // pipeline skipped review and the operator saw a dead end. The outcome is
    // about THIS objective's scope, nothing else.
    '- Outcome semantics: succeeded = you produced and verified a change for this objective in this worktree. Anything outside this repo or this objective (other services, infrastructure, someone else\'s system) is a FOLLOW-UP: list it under "Follow-ups" in the body and still report succeeded. failed = you could not produce a verified change (no files changed, tests red, blocked).',
    '- If you need an answer from the coordinator, send ask and WAIT for the reply. Never send worker_done while your own question is still open.'
  ].join('\n')
}

export function buildReviewerSpec(args: {
  objective: string
  builderReportBody: string | null
  filesModified: string[]
  reviewFocus: string | null
  rubric?: ReviewRubric
  evidenceRequired?: boolean
  /** This seat's findings from the previous round, as the host checked them. */
  previousFindings?: string | null
}): string {
  const files =
    args.filesModified.length > 0
      ? args.filesModified.map((file) => `- ${file}`).join('\n')
      : '- (the builder listed no files; inspect the working tree diff)'
  return [
    'REVIEW TASK (Build + Review pipeline, reviewer role). Review independently from the builder; be adversarial and concrete.',
    '',
    'Original objective:',
    args.objective.trim(),
    '',
    'Files the builder reported as modified:',
    files,
    '',
    'Builder report:',
    args.builderReportBody?.trim() || '(no report body)',
    '',
    ...(args.rubric ? [`Rubric: ${args.rubric.name}`, args.rubric.instructions.trim(), ''] : []),
    ...(args.reviewFocus ? ['Review focus from the operator:', args.reviewFocus.trim(), ''] : []),
    ...(args.previousFindings ? [args.previousFindings, ''] : []),
    'Rules:',
    '- Read the actual diff in the working tree (git diff / git status). Do not trust the report.',
    '- Run the relevant tests and typecheck yourself. Try to break the change with edge cases.',
    ...(args.evidenceRequired
      ? ['- Do NOT edit files. Findings only.', ...EVIDENCE_RULES]
      : [
          '- Do NOT edit files. Findings only. Rank them: BLOCKER, MAJOR, MINOR, NIT. Each finding: file:line, what is wrong, how to reproduce or why it matters, suggested fix.',
          '- The worker_done --body must end with exactly one verdict on its own final line: VERDICT: APPROVE or VERDICT: REQUEST_CHANGES. Separate it from the preceding review summary with a newline. A verdict appended to a prose sentence is invalid.',
          '- APPROVE only when you found no remaining issues and all required checks passed; any unresolved finding requires REQUEST_CHANGES.'
        ]),
    '- Send worker_done exactly once with --outcome succeeded (review completed, whatever the verdict) or failed (you could not review), and the full findings in the body.'
  ].join('\n')
}
