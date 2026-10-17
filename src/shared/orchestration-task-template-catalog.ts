/**
 * The production task templates themselves: one brief shape per stage. A template only shapes the
 * brief a worker receives: it never dispatches, approves, accepts or releases.
 */
export const ORCHESTRATION_TASK_TEMPLATE_IDS = [
  'implement',
  'verify',
  'independent-review',
  'deterministic-qa',
  'release',
  'live-verification'
] as const
export type OrchestrationTaskTemplateId = (typeof ORCHESTRATION_TASK_TEMPLATE_IDS)[number]

/** Bumped when a template's rendered wording changes, so a stored spec names what produced it. */
export const ORCHESTRATION_TASK_TEMPLATE_VERSION = 2

export type OrchestrationTaskTemplateField = {
  key: string
  /** The section heading in the rendered spec. */
  label: string
  description: string
  required: boolean
}

export type OrchestrationTaskTemplate = {
  id: OrchestrationTaskTemplateId
  title: string
  summary: string
  fields: readonly OrchestrationTaskTemplateField[]
  /** What this stage must and must not do, beyond the shared boundaries. */
  rules: readonly string[]
}

function field(
  key: string,
  label: string,
  description: string,
  required = true
): OrchestrationTaskTemplateField {
  return { key, label, description, required }
}

const OBJECTIVE = field(
  'objective',
  'Objective',
  'What this stage must achieve, in one or two sentences.'
)
const OWNER = field(
  'owner',
  'Owner',
  'Who owns this stage and answers its questions (a person, or the Run coordinator acting for one).'
)
const HOST = field('host', 'Host', 'The computer the work runs on, as `omni host list` names it.')
const BRANCH = field(
  'branch',
  'Branch',
  'The branch and its base ref, or "none" for a folder workspace.'
)
const SCOPE = field(
  'scope',
  'Allowed scope',
  'The files, folders or systems this stage may change or read.'
)
const ACCEPTANCE = field(
  'acceptance',
  'Acceptance',
  'Checks that decide done, one per line, each one verifiable by running something. They are numbered A1, A2, … in the brief.'
)
const EVIDENCE = field('evidence', 'Evidence', 'What proof to return and where to save it.')
const OUT_OF_SCOPE = field(
  'outOfScope',
  'Out of scope',
  'What must be left alone even if it looks related.',
  false
)
const CONTEXT = field('context', 'Context', 'Links, prior decisions or files to read first.', false)

function stageFields(
  ...extra: OrchestrationTaskTemplateField[]
): readonly OrchestrationTaskTemplateField[] {
  return [
    OBJECTIVE,
    OWNER,
    HOST,
    BRANCH,
    SCOPE,
    OUT_OF_SCOPE,
    CONTEXT,
    ...extra,
    ACCEPTANCE,
    EVIDENCE
  ]
}

export const ORCHESTRATION_TASK_TEMPLATES: Record<
  OrchestrationTaskTemplateId,
  OrchestrationTaskTemplate
> = {
  implement: {
    id: 'implement',
    title: 'Implement',
    summary: 'Make one scoped change and prove it with the stated checks.',
    fields: stageFields(),
    rules: [
      'Read the existing code first and extend it; do not build a parallel version.',
      'Run every Acceptance check yourself before reporting, and report the command, host, exit code and outcome of each.',
      'Commit on the named branch only. Do not merge, release or deploy.'
    ]
  },
  verify: {
    id: 'verify',
    title: 'Verify',
    summary:
      "Re-run every Acceptance line of another worker's task, read-only, and report each one PASS or FAIL.",
    fields: stageFields(
      field(
        'verifyOf',
        'Under verification',
        'The task, commit or Dispatch whose work this checks.'
      )
    ),
    rules: [
      "You did not write this work. Its worker's report is a claim, not evidence: re-run every Acceptance line yourself on the named host.",
      'Read-only: change no files, and do not fix what fails.',
      'Report every line, in order, as "A1 PASS — <command, host, exit code> → <output tail>" or "A1 FAIL — <what you saw>". A line you could not check is FAIL with the reason.',
      'Use --outcome succeeded only when every line passed. Your FAIL lines go back to the worker exactly as you wrote them, so write what you observed, not a fix.'
    ]
  },
  'independent-review': {
    id: 'independent-review',
    title: 'Independent review',
    summary:
      'A read-only verdict on work you did not write, used only when a stated reason justifies it.',
    fields: stageFields(
      field('reviewOf', 'Under review', 'The exact commit, diff, PR or Dispatch being reviewed.'),
      field(
        'justification',
        'Why a review is justified',
        'The reason this work needs an independent review (a guard, auth, permissions, cross-host, money, a migration, or a failed check).'
      ),
      field(
        'authorModel',
        'Author',
        'The agent and model family that wrote the work; the reviewer must be a different family.'
      )
    ),
    rules: [
      'You wrote none of this work. If your model family matches Author, stop and report that instead of reviewing.',
      'Read-only: change no files, and do not fix what you find.',
      'Report each finding with file:line, why it is wrong and how to reproduce it. Separate blocking findings from suggestions.',
      'End with exactly one line: "VERDICT: pass" or "VERDICT: block".'
    ]
  },
  'deterministic-qa': {
    id: 'deterministic-qa',
    title: 'Deterministic QA',
    summary: 'Run the exact commands and report what they returned; no judgment calls.',
    fields: stageFields(
      field(
        'commands',
        'Commands',
        'The exact commands to run, one per line, with the expected result of each.'
      )
    ),
    rules: [
      'Run exactly the listed commands on the named host, in order. Do not edit source files to make one pass.',
      'For every command report the host, the exit code and the tail of its output.',
      'A command that fails may be rerun once; report both runs. PASS only when every command passes.'
    ]
  },
  release: {
    id: 'release',
    title: 'Release',
    summary: 'Ship through the normal authorized path, for an approval that names this release.',
    fields: stageFields(
      field(
        'releasePath',
        'Release path',
        'The normal workflow or command that ships this, and the exact commit or tag it ships.'
      ),
      field(
        'approval',
        'Approval',
        'Who approved this release and their words. A general or earlier go-ahead does not count.'
      ),
      field(
        'rollback',
        'Rollback',
        'How to return to the previous version, and what was kept to do it.'
      )
    ),
    rules: [
      'Ship only the commit or tag named in Release path, from a tree that contains the published target branch.',
      'No check bypass, no force push, no release from a stale tree, and no parallel release.',
      'Before restarting or updating a shared app or host, claim the single deployment slot through the Run and wait for the answer.',
      'Stop at any missing credential or approval and ask; never widen access to get past it.'
    ]
  },
  'live-verification': {
    id: 'live-verification',
    title: 'Live verification',
    summary:
      'Exercise the released change on the real running system and report what was observed.',
    fields: stageFields(
      field(
        'target',
        'Target',
        'The running system to check, and the version or commit it must be serving.'
      ),
      field(
        'checks',
        'Checks',
        'The behaviors to exercise on the live system, each with what success looks like.'
      )
    ),
    rules: [
      'First confirm the Target serves the expected version or commit; if it does not, stop and report that.',
      'Verify by using the real thing. A launch receipt, exit 0, HTTP 200, an idle provider or a merged PR is not verified success.',
      'Read-only unless Allowed scope says otherwise. Create only disposable test data and remove what you created.',
      'Report each check as observed pass, observed fail or unknown, with the evidence.'
    ]
  }
}

/** Every template carries these: the boundaries a template must never loosen. */
export const ORCHESTRATION_TASK_BOUNDARIES: readonly string[] = [
  'This task grants no approval. Stop and ask through the Run before a production deploy or restart, a merge to a protected branch, money movement, a customer-facing send, a destructive operation or wider credential access, unless an Approval section above names this exact instance.',
  'Stay inside Allowed scope. Anything else you find is a follow-up to report, not to do.',
  'Do not stop, restart or close other sessions. A quiet session is not a dead one.'
]

export const ORCHESTRATION_TASK_REPORT_RULES: readonly string[] = [
  'Finish with worker_done. Use --outcome succeeded only when every Acceptance check passed by execution; otherwise --outcome failed, naming what failed.',
  'Body: one line per Acceptance item, in order: "A1 PASS — <command, host, exit code> → <output tail>" or "A1 FAIL — <what you saw>", then one sentence on anything left. Save the evidence where Evidence says and pass it as --report-path.',
  'Anything you could not measure or observe is "unknown": never zero, never assumed.'
]
