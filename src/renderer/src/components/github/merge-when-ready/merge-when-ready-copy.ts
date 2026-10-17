import { getIntlLocale, translate } from '@/i18n/i18n'
import type { GitHubPRMergeStatePresentation } from '@/components/github-pr-merge-state'
import type {
  AttributedMergeHold,
  MergeWhenReadyBlocker
} from '../../../../../shared/github/merge-when-ready-facts'
import type {
  MergeWhenReadyArmOutcome,
  MergeWhenReadyArmWarning,
  MergeWhenReadyDisarmOutcome
} from './merge-when-ready-actions'

function shortDate(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime())
    ? at
    : date.toLocaleDateString(getIntlLocale(), { day: 'numeric', month: 'short' })
}

/** One hold in a sentence, naming who set it when GitHub's history shows it. */
export function describeMergeHold(hold: AttributedMergeHold): string {
  const what =
    hold.kind === 'label'
      ? translate('mergeWhenReady.hold.label', '"{{label}}" label', { label: hold.label })
      : translate('mergeWhenReady.hold.title', 'Title says "{{phrase}}"', { phrase: hold.phrase })
  if (!hold.by || !hold.at) {
    return what
  }
  return translate('mergeWhenReady.hold.by', '{{what}}, set by {{by}} on {{date}}', {
    what,
    by: hold.by,
    date: shortDate(hold.at)
  })
}

function describeBlocker(blocker: MergeWhenReadyBlocker): string {
  switch (blocker.kind) {
    case 'draft':
      return translate('mergeWhenReady.blocker.draft', 'draft (the job marks it ready)')
    case 'conflicts':
      return translate('mergeWhenReady.blocker.conflicts', 'conflicts with {{base}}', {
        base: blocker.base
      })
    case 'checks-failing':
      return translate('mergeWhenReady.blocker.failing', 'failing: {{names}}', {
        names: blocker.names.join(', ')
      })
    case 'checks-running':
      return translate('mergeWhenReady.blocker.running', 'running: {{names}}', {
        names: blocker.names.join(', ')
      })
    case 'behind':
      return translate('mergeWhenReady.blocker.behind', 'behind {{base}} (the job updates it)', {
        base: blocker.base
      })
    case 'blocked':
      return translate('mergeWhenReady.blocker.blocked', 'blocked by a GitHub rule')
  }
}

/** "Waiting on: …" for a PR's blockers, or null when GitHub shows nothing in the way. */
export function describeMergeWhenReadyBlockers(blockers: MergeWhenReadyBlocker[]): string | null {
  if (blockers.length === 0) {
    return null
  }
  return translate('mergeWhenReady.waitingOn', 'Waiting on: {{items}}', {
    items: blockers.map(describeBlocker).join(' · ')
  })
}

/**
 * GitHub names its merge-queue action "Merge when ready" too. Where the PR has the box, that
 * name belongs to the box button, so the merge menu's queue action gets its plain name.
 */
export function mergeMenuPresentation(
  presentation: GitHubPRMergeStatePresentation,
  boxPresent: boolean
): GitHubPRMergeStatePresentation {
  const action = presentation.autoMergeAction
  if (!boxPresent || action?.kind !== 'enable') {
    return presentation
  }
  const queueLabel = translate(
    'auto.components.github.pr.merge.state.b169f943e1',
    'Merge when ready'
  )
  if (action.label !== queueLabel) {
    return presentation
  }
  return {
    ...presentation,
    autoMergeAction: {
      ...action,
      label: translate('mergeWhenReady.queueNow', 'Add to merge queue now')
    }
  }
}

export type MergeWhenReadyNotice = {
  tone: 'success' | 'info' | 'warning' | 'error'
  message: string
}

function describeArmWarning(warning: MergeWhenReadyArmWarning): string {
  return warning.kind === 'labels-kept'
    ? translate('mergeWhenReady.warning.labelsKept', "Couldn't remove {{labels}}: {{message}}", {
        labels: warning.labels.join(', '),
        message: warning.message
      })
    : translate(
        'mergeWhenReady.warning.titleKept',
        'The title is only "{{phrase}}", so it was left as it is.',
        { phrase: warning.phrase }
      )
}

/** What to tell the person after "Merge when ready", for each thing GitHub showed. */
export function armOutcomeNotice(
  outcome: MergeWhenReadyArmOutcome,
  number: number
): MergeWhenReadyNotice {
  switch (outcome.kind) {
    case 'armed': {
      const on = translate('mergeWhenReady.armed', 'Merge when ready is on for PR #{{number}}.', {
        number
      })
      return outcome.warnings.length === 0
        ? { tone: 'success', message: on }
        : { tone: 'warning', message: [on, ...outcome.warnings.map(describeArmWarning)].join(' ') }
    }
    case 'held':
      return {
        tone: 'warning',
        message: translate(
          'mergeWhenReady.heldSince',
          'PR #{{number}} was put on hold after this view loaded. Check the hold, then click again.',
          { number }
        )
      }
    case 'already-armed':
      return {
        tone: 'info',
        message: translate(
          'mergeWhenReady.alreadyArmed',
          'Merge when ready was already on for PR #{{number}}.',
          { number }
        )
      }
    case 'no-box':
      return {
        tone: 'error',
        message: translate(
          'mergeWhenReady.noBox',
          'PR #{{number}} no longer has the Merge when ready box.',
          { number }
        )
      }
    case 'not-open':
      return {
        tone: 'info',
        message: translate('mergeWhenReady.notOpen', 'PR #{{number}} is no longer open.', {
          number
        })
      }
    case 'missing':
      return {
        tone: 'error',
        message: translate('mergeWhenReady.missing', "Couldn't find PR #{{number}} on GitHub.", {
          number
        })
      }
    case 'unverified':
      return {
        tone: 'warning',
        message: translate(
          'mergeWhenReady.unverified',
          "The change was sent, but GitHub doesn't show it on PR #{{number}} yet. Check again in a moment.",
          { number }
        )
      }
  }
}

/** What to tell the person after "Stop". */
export function disarmOutcomeNotice(
  outcome: MergeWhenReadyDisarmOutcome,
  number: number
): MergeWhenReadyNotice {
  switch (outcome.kind) {
    case 'disarmed':
      return {
        tone: 'success',
        message: translate(
          'mergeWhenReady.disarmed',
          'Merge when ready is off for PR #{{number}}.',
          { number }
        )
      }
    case 'already-disarmed':
      return {
        tone: 'info',
        message: translate(
          'mergeWhenReady.alreadyDisarmed',
          'Merge when ready was already off for PR #{{number}}.',
          { number }
        )
      }
    case 'not-open':
      return {
        tone: 'warning',
        message: translate(
          'mergeWhenReady.closedBeforeStop',
          'PR #{{number}} is no longer open. It may have merged before the stop landed.',
          { number }
        )
      }
    case 'no-box':
    case 'missing':
    case 'unverified':
      return armOutcomeNotice(outcome, number)
  }
}
