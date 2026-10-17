import { goldenChain } from '../../../../../shared/__fixtures__/work-plan/wp2/compiled-chain'
import { workPlanFixtureContext } from '../../../../../shared/__fixtures__/work-plan/work-plan-context'
import type { WorkPlanRole } from '../../../../../shared/work-plan-types'
import type { NextStepSubject } from '../next-step-subject'

export const subject: Extract<NextStepSubject, { kind: 'session' }> = {
  kind: 'session',
  session: {
    rowKey: 'row',
    sessionKey: 'session',
    worktreeId: 'folder:w1',
    hostId: 'local',
    tabId: 'tab',
    paneKey: 'pane',
    kind: 'terminal',
    label: 'Ship the page',
    workspaceLabel: 'Docs',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null
  }
}
export const context = workPlanFixtureContext({ source: null })
export function fixtureChain(role: WorkPlanRole = 'implement', count = 1) {
  return goldenChain({
    outcome: {
      title: 'Ship the page',
      outputKind: 'work',
      doneWhen: [
        { id: 'price', text: 'The page shows the price', evidence: 'file', path: 'page.html' }
      ]
    },
    nodes: [
      {
        kind: 'worker',
        id: 'work',
        role,
        actor: { agent: 'codex', model: 'gpt-5-codex', effort: 'high' },
        count,
        instruction: '',
        writes: 'own-output-dir'
      },
      { kind: 'finish', id: 'finish', how: 'my-review' }
    ]
  })
}
