import {
  WORKFLOW_ROUTES,
  workflowRouteMayJudge,
  type WorkflowRoute
} from '../../../../../shared/workflow-graph'
import { BEST_OF_N_ANGLES, BEST_OF_N_GENERATE_INSTRUCTION } from '../../../../../shared/workflow-graph-find'
import { JEV_FIRST } from '../../../../../shared/workflow-graph-improve'

/** Test fixture only: no production code builds this shape any more (see workflowTemplate). */
const BEST_OF_N_DEFAULT_COUNT = 4

function available(routes: readonly WorkflowRoute[]): WorkflowRoute[] {
  const list = WORKFLOW_ROUTES.filter((route) => route !== 'openrouter' && routes.includes(route))
  return list.length ? list : ['claude']
}

function judges(routes: readonly WorkflowRoute[]): WorkflowRoute[] {
  const list = available(routes).filter((route) => workflowRouteMayJudge(route))
  return list.length ? list : ['claude']
}

/**
 * Best of N, the pre-merge shape: several models each make a finished version from a different
 * angle, judges rank them blind, and the result is the winning version itself (with the rankings
 * under it). Superseded by the 'find' template with `versions: true` (see workflowTemplate); kept
 * here, used only by tests, so a saved spec built this way is proven to still replay unchanged.
 */
export function bestOfN(routes: readonly WorkflowRoute[], count = BEST_OF_N_DEFAULT_COUNT) {
  const makers = available(routes)
  const total = Math.min(Math.max(count, 2), BEST_OF_N_ANGLES.length)
  return {
    title: 'Best of N',
    template: 'best-of-n',
    steps: [
      {
        id: 'generate',
        kind: 'do',
        title: 'Candidates',
        instruction: BEST_OF_N_GENERATE_INSTRUCTION,
        agents: Array.from({ length: total }, (_, index) => ({
          route: makers[index % makers.length],
          angle: BEST_OF_N_ANGLES[index]
        })),
        inputs: []
      },
      {
        id: 'judge',
        kind: 'rank',
        title: 'Judges pick the best',
        instruction: '',
        agents: judges(routes).map((route) => ({ route })),
        inputs: ['generate'],
        jev: JEV_FIRST
      }
    ]
  }
}
