import { translate } from '@/i18n/i18n'
import type { WorkflowDecideStatus, WorkflowResultsKind } from './workflow-results-candidates'

/** A ready instruction for a session started from results; the person can edit it. */
export type WorkflowResultsStarter = { id: string; label: string; instruction: string }

/** The instructions offered for each kind of result, the usual one first. */
export function workflowResultsStarters(
  kind: WorkflowResultsKind,
  decision?: WorkflowDecideStatus
): WorkflowResultsStarter[] {
  switch (kind) {
    case 'find':
      return [
        {
          id: 'apply',
          label: translate('resultsLaunch.starter.apply', 'Put it to work'),
          instruction: translate(
            'resultsLaunch.starter.applyText',
            'Take the chosen results above forward on the request: do what they need in this workspace, then say what you changed and how you checked it.'
          )
        },
        {
          id: 'compare',
          label: translate('resultsLaunch.starter.compare', 'Compare'),
          instruction: translate(
            'resultsLaunch.starter.compareText',
            'Compare the chosen results above for the request: their strengths, weaknesses and risks. Recommend one and say why, before changing anything.'
          )
        },
        {
          id: 'research',
          label: translate('resultsLaunch.starter.research', 'Research'),
          instruction: translate(
            'resultsLaunch.starter.researchText',
            'Research the chosen results above: check their claims against the sources, find what could go wrong, and report before changing anything.'
          )
        }
      ]
    case 'discover':
      return [
        {
          id: 'fix',
          label: translate('resultsLaunch.starter.fix', 'Fix'),
          instruction: translate(
            'resultsLaunch.starter.fixText',
            'Fix the findings above. Re-check each one first; skip any that does not hold up and say why. Run the relevant tests.'
          )
        },
        {
          id: 'plan-fixes',
          label: translate('resultsLaunch.starter.planFixes', 'Plan the fixes'),
          instruction: translate(
            'resultsLaunch.starter.planFixesText',
            'Plan how to fix the findings above, most severe first, without changing any code yet.'
          )
        },
        {
          id: 'double-check',
          label: translate('resultsLaunch.starter.doubleCheck', 'Double-check'),
          instruction: translate(
            'resultsLaunch.starter.doubleCheckText',
            'Check whether each finding above is real: reproduce it, or explain why it does not hold. Change nothing.'
          )
        }
      ]
    case 'decide':
      return decideStarters(decision)
    case 'items':
      return [
        {
          id: 'work',
          label: translate('resultsLaunch.starter.work', 'Work through them'),
          instruction: translate(
            'resultsLaunch.starter.workText',
            'Work through the items above for the request, one at a time, and say what you did with each.'
          )
        },
        {
          id: 'plan',
          label: translate('resultsLaunch.starter.plan', 'Plan'),
          instruction: translate(
            'resultsLaunch.starter.planText',
            'Plan how to handle the items above, in order, without changing anything yet.'
          )
        }
      ]
  }
}

/**
 * Decide's starters, the default first: act only on a checked decision; check one that is not
 * fully checked before acting; and never act on a withheld one, only investigate.
 */
function decideStarters(decision: WorkflowDecideStatus | undefined): WorkflowResultsStarter[] {
  const acting: WorkflowResultsStarter[] = [
    {
      id: 'act',
      label: translate('resultsLaunch.starter.act', 'Act on it'),
      instruction: translate(
        'resultsLaunch.starter.actText',
        'Take the chosen decision forward: run its next test first if it names one, then plan and do the first steps here, and say what you did and how you checked it.'
      )
    },
    {
      id: 'test',
      label: translate('resultsLaunch.starter.test', 'Run the next test'),
      instruction: translate(
        'resultsLaunch.starter.testText',
        'Run the cheapest test the decision above names, or design one if it names none, and report what it shows before anything else changes.'
      )
    },
    {
      id: 'challenge',
      label: translate('resultsLaunch.starter.challenge', 'Challenge it'),
      instruction: translate(
        'resultsLaunch.starter.challengeText',
        'Make the strongest case for the runner-up against the decision above, check the key assumption, and say whether the recommendation still holds. Change nothing.'
      )
    }
  ]
  if (decision === 'withheld') {
    return [
      {
        id: 'investigate',
        label: translate('resultsLaunch.starter.investigate', 'Investigate the failed checks'),
        instruction: translate(
          'resultsLaunch.starter.investigateText',
          "Nothing above passed its checks. Read the skeptic's reasons and the warnings, find out why each option fails a hard limit, and look for an option that keeps every limit. Do not act on any option; report what you find."
        )
      },
      {
        id: 'compliant',
        label: translate('resultsLaunch.starter.compliant', 'Look for a compliant option'),
        instruction: translate(
          'resultsLaunch.starter.compliantText',
          'Using the frame and the finalists above, propose an option that keeps every hard limit, and show how you checked each limit. Change nothing.'
        )
      }
    ]
  }
  if (decision === 'checked' || decision === 'answer') {
    return acting
  }
  return [
    {
      id: 'verify',
      label: translate('resultsLaunch.starter.verify', 'Check it first'),
      instruction: translate(
        'resultsLaunch.starter.verifyText',
        'Before acting, check the decision above against every hard limit and each warning, and say whether it still holds. Change nothing yet.'
      )
    },
    ...acting
  ]
}
