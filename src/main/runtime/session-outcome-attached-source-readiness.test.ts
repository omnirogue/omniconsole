import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { admitHubLinkedLaunch } from './orchestration/hub-linked-launch-admission'
import { installSessionOutcomeHandoffTransport } from './session-outcome-handoff'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
  setStructuredAgentSessionHost(null)
})

const sessionId = 'chat-1'
const paneKey = structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)

type Turn = {
  running: boolean
  hasTurn: boolean
  awaitingStart: boolean
  outcome: 'completed' | 'interrupted' | 'failed' | 'unknown'
  lastSequence: number
}

function installChatSource(turn: () => Turn) {
  setStructuredAgentSessionHost({
    listSessionTabs: () => [{ sessionId, workspaceId: 'folder:outcome', agent: 'codex' }],
    turnState: () => turn()
  } as never)
}

function reviewCommit(expectedRevision: number): SessionOutcomeCommit {
  return {
    expectedRevision,
    source: 'user',
    outcomes: [
      {
        id: 'reviewed',
        title: 'Review',
        finish: 'my-review',
        dependsOn: [],
        stepIds: ['review'],
        actions: [],
        conditions: [{ id: 'review', kind: 'review', target: 'reviewers' }]
      }
    ]
  } as SessionOutcomeCommit
}

function chatChain(fixture: ReturnType<typeof outcomeRuntimeFixture>) {
  return {
    id: 'chain',
    workspacePath: fixture.workspace,
    worktreeId: 'folder:outcome',
    hostId: 'local',
    sourcePaneKey: paneKey,
    sourceRowKey: 'source',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps: [
      {
        id: 'review',
        agent: 'codex',
        prompt: 'Review',
        review: {
          groupId: 'g',
          reviewerId: 'r',
          round: 1,
          maxRounds: 1,
          candidateVersion: 'v'
        },
        status: 'queued'
      }
    ]
  } as never
}

/** A card-attached chat source: planning provenance exists, the turn has not started. */
function attachedChatFixture(turn: () => Turn) {
  const fixture = outcomeRuntimeFixture(() => ({
    body: 'OMNI_REVIEW_RESULT:{"status":"pass","blockingFindings":[]}'
  }))
  fixtures.push(fixture)
  installSessionOutcomeHandoffTransport({ principal: async () => 'person', hub: {} as never })
  installChatSource(turn)
  vi.mocked(fixture.runtime.resolveTerminalPane).mockImplementation(() => {
    throw new Error('no PTY')
  })
  // The review step leaves its model to the host, and a card-attached save pins optional models
  // through the host's own discovery probe (#266, a9ef7579c). This fixture's runtime carries no
  // git store, so the probe is answered here instead of reaching real git target resolution.
  const model = { id: 'gpt-5.6-terra', label: 'Terra', isDefault: true }
  vi.spyOn(fixture.runtime, 'discoverRuntimeCommitMessageModels').mockResolvedValue({
    success: true,
    capability: {
      id: 'codex',
      label: 'Codex',
      modelSource: 'dynamic',
      models: [model],
      defaultModelId: model.id
    },
    models: [model],
    defaultModelId: model.id,
    catalogOrigin: 'probe'
  })
  const source = fixture.runtime.resolveSessionOutcomePlanningCoordinator(paneKey, 'folder:outcome')
  admitHubLinkedLaunch(fixture.db, {
    linkedItem: { title: 'Card', hubTaskId: 'btk_card' },
    launchHubTaskId: 'btk_card',
    coordinatorHandle: source.handle,
    coordinatorPaneKey: source.paneKey,
    coordinatorProcessIncarnation: source.processIncarnation
  })
  return fixture
}

it('does not mark an attached source ready before its provider turn starts', async () => {
  const fixture = attachedChatFixture(() => ({
    running: false,
    hasTurn: true,
    awaitingStart: true,
    outcome: 'unknown',
    lastSequence: 1
  }))
  const saved = await fixture.service.commit(chatChain(fixture), reviewCommit(0))
  expect(saved.outcomeSet?.continuation.planningSource).toBeDefined()
  expect(saved.outcomeSet?.continuation.sourceReady).not.toBe(true)
})

it('repairs a stored ready flag when the source is observed running again', async () => {
  let turn: Turn = {
    running: false,
    hasTurn: true,
    awaitingStart: false,
    outcome: 'completed',
    lastSequence: 4
  }
  const fixture = attachedChatFixture(() => turn)
  const first = await fixture.service.commit(chatChain(fixture), reviewCommit(0))
  expect(first.outcomeSet?.continuation.sourceReady).toBe(true)
  turn = {
    running: true,
    hasTurn: true,
    awaitingStart: false,
    outcome: 'unknown',
    lastSequence: 6
  }
  const second = await fixture.service.commit(
    chatChain(fixture),
    reviewCommit(first.outcomeSet!.revision)
  )
  expect(second.outcomeSet?.continuation.sourceReady).not.toBe(true)
})
