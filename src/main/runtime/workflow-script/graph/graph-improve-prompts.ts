import {
  graphPromptFooter,
  graphPromptHeader,
  graphRenderSection,
  type GraphPromptInput
} from './graph-prompts'
import { workflowImprovePrompt } from '../../../../shared/workflow-improve-prompts'
import type { GraphCheckResult, GraphImproveBrief } from './graph-plan-types'
import type { GraphImproveReflection, GraphImproveRejected } from './graph-improve-reflection'

// Not rewordable: it only says what the explorer is shown, whatever its instruction asks.
const DEVELOP_ALTERNATIVE =
  "A promising alternative that takes a different approach is below too: develop it into your version rather than merging back into the best version's approach."

// Not rewordable: with several versions to build on, the one shown may not be the best so far.
const PARENT_NOTE: Record<NonNullable<GraphImproveBrief['parent']>, string> = {
  cases:
    'The version below is not the best so far: it was kept because it passes practice cases the best version fails. Build on it as asked, keeping what makes those cases pass.',
  alternative:
    "The version below is not the best so far: it was kept because it takes a different approach. Build on it as asked, rather than moving back to the best version's approach."
}

// Not rewordable: the prediction is what makes a version a hypothesis the test can refute.
const PREDICT_INSTRUCTIONS =
  'Each version is a hypothesis: before it is tested, predict its result. End your version with one last line, exactly `PREDICTION: PASS`, `PREDICTION: FAIL` or `PREDICTION: SCORE >= <number>` (also <=, > or <). A version whose prediction turns out wrong, or that has no such last line, is dropped before any comparison, so predict what you expect, not what you hope.'

// Not rewordable: how a change to the code must be written for the private copy to test it.
const DIFF_INSTRUCTIONS =
  'Each version is a change to the code in this workspace: one unified diff (the format `git diff` prints) in a single ```diff block, made against the code as it is now in the workspace, never against another version. A version that builds on the best version repeats every part of its diff that it keeps. Here the finished work is that diff: it is applied to a private copy of the code, where the test runs, and text outside the block is only read as notes. A diff that does not apply fails, and so does one that touches a file Git ignores, a .gitignore file, a symbolic link, a submodule, binary content, anything inside .git, or a path outside the repository.'

// While "No change" holds no best version is shown, so these never point at one "below".
const AGAINST_UNCHANGED: Partial<Record<GraphImproveBrief['role'], string>> = {
  explore:
    'Change the code with a substantially different approach from the most obvious one. Make your change complete and able to beat the code as it is.',
  divergent:
    'The changes tried so far have not beaten the code as it is now. Challenge the assumptions behind them and change the code with a fundamentally different approach. Aim to beat the code as it is, not to vary what was tried.'
}

// Not rewordable: it is what the reflection under it is for (Improve rules 3).
const REFLECTION_DIRECTIVE =
  'Focus on fixing the weakest criterion and check failures first. Do not repeat mutations listed under Tried & Rejected.'

const JUDGE_CODE_CHANGES =
  'Every version is a change to the code, shown as a diff; "No change" keeps the code as it is. Prefer no change to a change that is not clearly better.'

/**
 * The task as Improve's judges (models and JEV) read it: what the improvers were told every
 * version must follow is part of the task, so a version that ignores it cannot win on polish.
 */
export function graphImproveJudgeTask(
  task: string,
  instruction: string,
  changesCode = false
): string {
  const own = instruction.trim()
  const judged = own ? `${task}\n\nEvery version must also follow this instruction: ${own}` : task
  return changesCode ? `${judged}\n\n${JUDGE_CODE_CHANGES}` : judged
}

/** For a change to the code: how to write it, and the files the person protected. */
function changeText(change: NonNullable<GraphImproveBrief['change']>): string {
  const protect = change.protect.map((pattern) => pattern.trim()).filter(Boolean)
  return protect.length
    ? `${DIFF_INSTRUCTIONS}\n\nNever change these files (a diff that touches one fails): ${protect.join(', ')}`
    : DIFF_INSTRUCTIONS
}

function roleInstruction(brief: GraphImproveBrief): string {
  const own = ownRoleInstruction(brief)
  return brief.parent && brief.best ? `${own}\n\n${PARENT_NOTE[brief.parent]}` : own
}

function ownRoleInstruction(brief: GraphImproveBrief): string {
  const unchanged = brief.change?.unchanged ? AGAINST_UNCHANGED[brief.role] : undefined
  // The person's own wording still wins; only the built-in one assumes a best version is shown.
  if (unchanged && !brief.prompts?.[brief.role]?.trim()) {
    return brief.alternative && brief.role === 'explore'
      ? `${unchanged}\n\n${DEVELOP_ALTERNATIVE}`
      : unchanged
  }
  switch (brief.role) {
    case 'first':
      return workflowImprovePrompt(brief.prompts, 'first')
    case 'improve':
      return workflowImprovePrompt(brief.prompts, 'improve')
    case 'explore':
      return brief.alternative
        ? `${workflowImprovePrompt(brief.prompts, 'explore')}\n\n${DEVELOP_ALTERNATIVE}`
        : workflowImprovePrompt(brief.prompts, 'explore')
    case 'divergent':
      return workflowImprovePrompt(brief.prompts, 'divergent')
  }
}

/** Why a rejected version lost, in words built from its codes and counts alone. */
function rejectedReasonText(entry: GraphImproveRejected): string {
  switch (entry.reason) {
    case 'prediction_missed':
      return 'its prediction did not match its test result'
    case 'check_failed':
      return entry.cases
        ? `failed the check (${entry.cases.passed} of ${entry.cases.total} cases pass)`
        : 'failed the check'
    case 'repeated_change':
      return `repeated the change ${entry.repeats?.name ?? 'another version'} made in round ${entry.repeats?.round ?? '?'}`
    case 'identical_to_best':
      return 'identical to the best version'
    case 'score_below_best':
      return `scored ${entry.score?.own} on the check, below the best version's ${entry.score?.best}`
    case 'lost_to_baseline':
    case 'lost_to_best':
    case 'lost_to_round_winner':
      return entry.preferred
        ? `the judges preferred ${entry.preferred.name} (round ${entry.preferred.round})`
        : 'not chosen'
  }
}

/** The codes behind a rejection: never the check's own output, which may quote any data. */
function rejectedCodes(entry: GraphImproveRejected): string {
  const cases = entry.cases
  return [
    `failure: ${entry.reason}`,
    entry.check ? `check: ${entry.check}` : '',
    cases
      ? `cases: ${cases.passed} of ${cases.total} passed${cases.unavailable ? `, ${cases.unavailable} could not run` : ''}`
      : '',
    entry.exits?.length ? `exits: ${entry.exits.join(', ')}` : '',
    entry.repeats ? `repeats: ${entry.repeats.name}, round ${entry.repeats.round}` : ''
  ]
    .filter(Boolean)
    .join('; ')
}

/** Rules 3: the best version's weakest criteria, what earlier rounds tried that lost, and why. */
function reflectionText(
  reflection: GraphImproveReflection | undefined,
  budget: GraphPromptInput['budget']
): string {
  if (!reflection || (!reflection.weakest?.length && !reflection.rejected.length)) {
    return ''
  }
  const weakest = reflection.weakest?.length
    ? `The best version's weakest criteria (JEV rubric score, 0 to 4):\n${reflection.weakest
        .map((criterion) => `- ${criterion.label}: ${criterion.score.toFixed(1)}`)
        .join('\n')}`
    : ''
  const tried = reflection.rejected.map(
    (entry) =>
      `- ${entry.name}, round ${entry.round}: ${entry.summary || '(no summary)'} (${rejectedReasonText(entry)}) [${rejectedCodes(entry)}]`
  )
  const rejected = tried.length
    ? `Tried & Rejected in Previous Rounds:\n${budget.fence(budget.take('Tried & Rejected', tried.join('\n')))}`
    : ''
  return [REFLECTION_DIRECTIVE, weakest, rejected].filter(Boolean).join('\n\n')
}

/**
 * How a version is tested under Improve rules 2: every practice case is listed, SCORE counts only
 * as the last line printed, and only a better test result is progress.
 */
function measuredCheckText(
  command: string,
  cases: string[],
  check: GraphCheckResult | undefined,
  budget: GraphPromptInput['budget'],
  change?: GraphImproveBrief['change'],
  parent?: GraphImproveBrief['parent'],
  predict?: boolean
): string {
  const on = cases.length ? ` on each of ${cases.length} practice cases, one run per case` : ''
  const where = change
    ? "in a private copy of the code with the version's diff applied"
    : 'in the workspace'
  const how = `Every version is tested by running \`${command}\` ${where}${on}. ${cases.length ? 'A case passes on exit 0 (the case replaces {case} in the command, and $OMNI_CASE_FILE names a file holding it); a version passes when every case passes, and passing more cases beats passing fewer.' : 'Exit 0 passes.'} When the last line printed is "SCORE: <number>", it ranks (higher wins).`
  const list = cases.length
    ? `The practice cases:\n${budget.take('The practice cases', cases.map((text, index) => `${index + 1}. ${text}`).join('\n'))}`
    : ''
  const counts = check?.cases ? ` (${check.cases.passed} of ${check.cases.total} cases pass)` : ''
  const subject = change?.unchanged
    ? 'The code as it is now, with no change,'
    : parent
      ? 'The version you build on'
      : 'The best version'
  const state = !check
    ? `Make yours pass${cases.length ? ' every case' : ''}.`
    : change && check.unavailable
      ? `The test could not run on ${change.unchanged ? 'the code as it is now' : parent ? 'the version you build on' : 'the best version'}:\n${budget.fence(budget.take('The check output', check.detail))}`
      : check.passed
        ? `${subject} passes${check.score === undefined ? '; only a version that tests better counts as progress' : ` with SCORE ${check.score}; a new version must pass and score higher`}.`
        : `${subject} FAILS it${counts}; the end of its output:\n${budget.fence(budget.take('The check output', check.detail))}\nFix what makes it fail: a version that passes beats every version that does not.`
  return [how, list, state, predict ? PREDICT_INSTRUCTIONS : ''].filter(Boolean).join('\n\n')
}

/** An improver's prompt: its role, the original task, the best version so far, the judges' notes. */
export function graphImprovePrompt(input: GraphPromptInput): string {
  const brief = input.improve!
  const own = input.step.instruction.trim()
  const best = brief.best
    ? `${brief.parent ? 'The version you build on' : 'The best version so far'} (by ${brief.best.name}, round ${brief.best.round}):\n${input.budget.fence(input.budget.take('The best version so far', brief.best.markdown, { whole: true }))}`
    : ''
  const alternative =
    brief.role === 'explore' && brief.alternative
      ? `A promising alternative approach (by ${brief.alternative.name}, round ${brief.alternative.round}):\n${input.budget.fence(input.budget.take('The alternative approach', brief.alternative.markdown))}`
      : ''
  const rubric = brief.rubric
    ? `What the judges count as better work:\n${input.budget.take('The judging rubric', brief.rubric)}`
    : ''
  const feedback = brief.feedback?.ballots.length
    ? `What the judges said last round${brief.feedback.bestLabel ? ` (the best version so far was ${brief.feedback.bestLabel})` : ''}:\n${brief.feedback.ballots
        .map(
          (ballot) =>
            `### ${ballot.label}\n${input.budget.fence(input.budget.take(`Judge notes: ${ballot.label}`, ballot.markdown))}`
        )
        .join('\n\n')}`
    : ''
  const command = brief.checkCommand
  const check = !command
    ? ''
    : brief.measuredCheck
      ? measuredCheckText(
          command,
          brief.measuredCheck.cases,
          brief.check,
          input.budget,
          brief.change,
          brief.parent,
          brief.measuredCheck.predict
        )
      : !brief.check
        ? `Every version is tested by running \`${command}\` in the workspace: exit 0 passes, and a printed "SCORE: <number>" ranks (higher wins). Make yours pass.`
        : brief.check.passed
          ? `Every version is tested by running \`${command}\`. The best version passes${brief.check.score === undefined ? '; a new version must pass too' : ` with SCORE ${brief.check.score}; a new version must pass and score higher`}.`
          : `Every version is tested by running \`${command}\`. The best version FAILS it; the end of its output:\n${input.budget.fence(input.budget.take('The check output', brief.check.detail))}\nFix what makes it fail: a version that passes beats every version that does not.`
  return [
    ...graphPromptHeader(input, roleInstruction(brief)),
    own ? `Also follow this instruction for every version: ${own}` : '',
    ...input.sections.map((section) => graphRenderSection(section, input.budget, true)),
    best,
    alternative,
    rubric,
    feedback,
    reflectionText(brief.reflection, input.budget),
    check,
    brief.change ? changeText(brief.change) : '',
    `Rules for every version:\n${workflowImprovePrompt(brief.prompts, 'rules')}`,
    ...graphPromptFooter(input)
  ]
    .filter((part) => part.trim())
    .join('\n\n')
}
