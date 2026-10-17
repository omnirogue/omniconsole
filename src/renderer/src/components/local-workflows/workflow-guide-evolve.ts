import { translate } from '@/i18n/i18n'
import type { WorkflowGuide } from './workflow-guide'

/** Evolve in plain words. Runs vary with the spec, so it gives no time. */
export function evolveGuide(): WorkflowGuide {
  return {
    what: translate(
      'localWorkflow.guide.evolve.what',
      "Improves a prompt or policy by trying many variations and keeping the ones that score best. It runs jev-lab's OpenEvolve on a fleet computer; every candidate and score stays in the central ledger."
    ),
    useWhen: [
      translate(
        'localWorkflow.guide.evolve.when1',
        'When a prompt or policy has a spec with scored examples, such as email replies or ads'
      ),
      translate(
        'localWorkflow.guide.evolve.when2',
        'To build on an earlier run: seed this one with its best and promoted candidates'
      )
    ],
    steps: [
      translate(
        'localWorkflow.guide.evolve.step1',
        'It picks a fleet computer (or the one you name) and submits the spec to the ledger.'
      ),
      translate(
        'localWorkflow.guide.evolve.step2',
        'One worker there proposes variations, scores each on the spec’s data and keeps the best.'
      ),
      translate(
        'localWorkflow.guide.evolve.step3',
        'This tab follows the ledger until the run is done, failed or stopped.'
      )
    ],
    youGet: translate(
      'localWorkflow.guide.evolve.youGet',
      'The best candidate and its score, what the run was seeded from, and any promotion records. Nothing is deployed.'
    )
  }
}
