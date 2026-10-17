import { reviseSessionOutcomeSet } from '../../../shared/session-outcome-state'
import type { SessionChain } from '../../../shared/session-chain-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  addSessionTestTab,
  SESSION_TEST_LEAF,
  sessionTestSource
} from './sidebar-session-test-fixtures'

export function savedOutcomeSourceFixture() {
  const source = sessionTestSource()
  const tab = addSessionTestTab(source)
  const paneKey = makePaneKey(tab.id, SESSION_TEST_LEAF)
  const chain: SessionChain = {
    id: 'saved',
    workspacePath: '/project-a',
    worktreeId: tab.worktreeId,
    hostId: 'local',
    sourcePaneKey: paneKey,
    sourceRowKey: JSON.stringify(['local', tab.worktreeId, paneKey]),
    state: 'waiting',
    steps: [],
    currentIndex: 0,
    auto: true,
    createdAt: 1,
    updatedAt: 1,
    outcomeSet: reviseSessionOutcomeSet(
      undefined,
      {
        source: 'user',
        expectedRevision: 0,
        outcomes: [
          {
            id: 'result',
            title: 'Saved recovery result',
            finish: 'complete',
            dependsOn: [],
            conditions: [{ id: 'file', kind: 'file', target: '/project-a/result.txt' }],
            actions: []
          }
        ]
      },
      {
        owner: 'execution-host',
        state: 'owned',
        hostId: 'local',
        epoch: 'epoch',
        sourceReady: true
      },
      1
    )
  }
  return { source, tab, paneKey, chain }
}
