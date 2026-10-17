import { translate } from '@/i18n/i18n'
import type { WorkflowGuide } from './workflow-guide'

/** Quick Discover in plain words; timed on 2026-09-27 benchmark runs. */
export function quickDiscoverGuide(): WorkflowGuide {
  return {
    what: translate(
      'localWorkflow.guide.quickDiscover.what',
      'One AI reads all of your code at once and lists the problems it finds. Nobody checks its findings, so treat each one as a lead to confirm.'
    ),
    useWhen: [
      translate(
        'localWorkflow.guide.quickDiscover.when1',
        'For a fast first pass over code small enough to read in one go'
      ),
      translate(
        'localWorkflow.guide.quickDiscover.when2',
        'When the code is too large, or findings must be checked by other AIs, use Discover instead'
      )
    ],
    steps: [
      translate(
        'localWorkflow.guide.quickDiscover.step1',
        'The app gathers the source files, skipping ignored, vendored, build and binary files, and refuses if they are too large for one read.'
      ),
      translate(
        'localWorkflow.guide.quickDiscover.step2',
        'One AI reads everything and lists each problem with the file and line, what triggers it, what goes wrong and the fix.'
      ),
      translate(
        'localWorkflow.guide.quickDiscover.step3',
        'A short report ranks the problems, all marked unverified.'
      )
    ],
    youGet: translate(
      'localWorkflow.guide.quickDiscover.youGet',
      'A ranked list of unverified problems, each with where it is and how to fix it.'
    ),
    time: translate(
      'localWorkflow.guide.quickDiscover.time',
      'About one to two minutes in measured runs.'
    )
  }
}
