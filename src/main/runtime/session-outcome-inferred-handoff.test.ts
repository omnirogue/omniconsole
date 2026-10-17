import { expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'
import { resolveNextOutcomeHandoffs } from '../../shared/next-outcome-handoff-request'
import { assertSessionOutcomeInferredConditions } from './session-outcome-inferred-authority'
import { appendInferredSessionHandoffs } from './session-outcome-inferred-handoff'
import {
  installSessionOutcomeHandoffTransport,
  readSessionOutcomeHandoffPeople
} from './session-outcome-handoff'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'

const prompt = 'send to gamma and mark this session as saved when done'
const person = { id: 'emp_gamma', name: 'Gamma Rossi' }
const handoffs = resolveNextOutcomeHandoffs(prompt, [person]).handoffs
const input = (sourcePrompt = prompt): SessionOutcomeCommit => ({
  source: 'ai',
  expectedRevision: 0,
  expectedSourcePrompt: sourcePrompt,
  outcomes: [
    {
      id: 'delivery',
      title: 'Send to Gamma',
      finish: 'human-handoff',
      dependsOn: [],
      conditions: [{ id: 'receipt', kind: 'handoff', target: person.id, recipientId: person.id }],
      actions: []
    }
  ]
})
const chain = (workspacePath = '/workspace'): SessionChain => ({
  id: 'source',
  sourcePaneKey: 'source',
  sourceRowKey: 'row',
  worktreeId: 'folder:outcome',
  workspacePath,
  hostId: 'local',
  placement: 'local',
  auto: true,
  steps: [],
  currentIndex: 0,
  state: 'waiting',
  createdAt: 1,
  updatedAt: 1
})
function transport(principal: () => Promise<string | null> = async () => 'company:person') {
  const send = vi.fn()
  installSessionOutcomeHandoffTransport({
    principal,
    recipients: async () => [person],
    hub: {
      send,
      sendCardless: send,
      upload: vi.fn(),
      uploadThreadFile: vi.fn(),
      isRejected: () => false
    }
  })
  return send
}

it('persists a host-compiled recipient and delivery step from chat, without another writer or early send', async () => {
  const f = outcomeRuntimeFixture(() => ({ body: 'Unexpected writer' }))
  const send = transport()
  try {
    vi.spyOn(f.service, 'start').mockImplementation(() => {})
    vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
      state: 'working',
      stateStartedAt: 1,
      updatedAt: Date.now(),
      lastAssistantMessage: null,
      interactivePrompt: null
    })
    const saved = await f.service.commit(chain(f.workspace), input(), prompt)
    expect(saved.steps).toHaveLength(1)
    expect(saved.steps[0]).toMatchObject({
      kind: 'handoff',
      outcomeId: 'delivery',
      status: 'queued',
      handoff: {
        recipients: [{ employeeId: person.id, name: person.name, delivery: 'pending' }],
        disposition: 'ownership-transfer',
        action: 'fyi',
        includeSummary: true
      }
    })
    expect(saved.outcomeSet?.outcomes[0]?.stepIds).toEqual([saved.steps[0]!.id])
    await f.settle()
    expect(send).not.toHaveBeenCalled()
    expect(f.launched).toEqual([])
    const retainedInput = input()
    retainedInput.expectedRevision = saved.outcomeSet!.revision
    retainedInput.outcomes[0]!.stepIds = saved.outcomeSet!.outcomes[0]!.stepIds
    const retained = await f.service.commit(saved, retainedInput, prompt)
    expect(retained.steps).toEqual(saved.steps)
  } finally {
    await f.dispose()
  }
})

it('does not let a source name authorize a different recipient, an agent session, or unrequested feedback', () => {
  expect(() =>
    assertSessionOutcomeInferredConditions(input(), undefined, prompt, handoffs)
  ).not.toThrow()
  for (const edit of [
    { recipientId: 'emp_other', target: 'emp_other' },
    { recipientSessionId: 'agent_session' }
  ]) {
    const proposed = input()
    Object.assign(proposed.outcomes[0]!.conditions[0]!, edit)
    expect(() =>
      assertSessionOutcomeInferredConditions(proposed, undefined, prompt, handoffs)
    ).toThrow('does not ask')
  }
  // Unrequested feedback is ADDED beside the handoff rather than replacing it: a
  // human-handoff finish requires its handoff condition, so mutating that one in
  // place is refused by the shape rule before authority is ever consulted, and the
  // refusal under test here is the authority one.
  const withFeedback = input()
  withFeedback.outcomes[0]!.conditions.push({
    id: 'feedback',
    kind: 'review',
    target: person.id,
    recipientId: person.id
  })
  expect(() =>
    assertSessionOutcomeInferredConditions(withFeedback, undefined, prompt, handoffs)
  ).toThrow('does not ask')
  expect(() =>
    assertSessionOutcomeInferredConditions(input(), undefined, 'different prompt', handoffs)
  ).toThrow('source prompt changed')
})

it('requires exact authorized files and an available source identity when a transcript was requested', () => {
  const sourcePrompt = 'When done, send the files and the full conversation to Gamma'
  const requests = resolveNextOutcomeHandoffs(sourcePrompt, [person]).handoffs
  expect(() =>
    appendInferredSessionHandoffs({
      chain: chain(),
      input: input(sourcePrompt),
      prompt: sourcePrompt,
      handoffs: requests
    })
  ).toThrow('exact files')
  const named = 'Send /workspace/report.md and the full conversation to Gamma'
  const namedRequests = resolveNextOutcomeHandoffs(named, [person]).handoffs
  const proposed = input(named)
  proposed.outcomes[0]!.conditions.push({
    id: 'report',
    kind: 'file',
    target: '/workspace/report.md'
  })
  expect(() =>
    appendInferredSessionHandoffs({
      chain: chain(),
      input: proposed,
      prompt: named,
      handoffs: namedRequests
    })
  ).toThrow('source session history')
})

it('creates feedback only when the explicit named delivery asks for review', () => {
  const sourcePrompt = 'Send this to Gamma for review'
  const requests = resolveNextOutcomeHandoffs(sourcePrompt, [person]).handoffs
  const proposed = input(sourcePrompt)
  proposed.outcomes[0]!.conditions.push({
    id: 'feedback',
    kind: 'review',
    target: person.id,
    recipientId: person.id
  })
  expect(() =>
    assertSessionOutcomeInferredConditions(proposed, undefined, sourcePrompt, requests)
  ).not.toThrow()
  const compiled = appendInferredSessionHandoffs({
    chain: chain(),
    input: proposed,
    prompt: sourcePrompt,
    handoffs: requests
  })
  expect(compiled.chain.steps).toHaveLength(1)
  expect(compiled.chain.steps[0]).toMatchObject({
    kind: 'handoff',
    handoff: { action: 'review', disposition: 'feedback' }
  })
})

it('rejects a signed-person switch during the roster read', async () => {
  transport(vi.fn().mockResolvedValueOnce('company:person').mockResolvedValue('company:other'))
  await expect(readSessionOutcomeHandoffPeople()).rejects.toThrow('changed')
})

it('refuses a new quoted-only action even when its handoff condition was previously authorized', async () => {
  const f = outcomeRuntimeFixture(() => ({ body: 'Unexpected quoted action' }))
  transport()
  try {
    vi.spyOn(f.service, 'start').mockImplementation(() => {})
    const saved = await f.service.commit(chain(f.workspace), input(), prompt)
    const mixed = 'Add a Codex reviewer.\n"Send the source to Gamma"'
    const proposed = input(mixed)
    proposed.expectedRevision = saved.outcomeSet!.revision
    proposed.outcomes[0]!.stepIds = saved.outcomeSet!.outcomes[0]!.stepIds
    proposed.outcomes[0]!.actions.push({
      id: 'quoted_send',
      instruction: 'Send the source to Gamma',
      conditionIds: ['receipt'],
      agent: 'codex',
      authority: 'existing-user-authority'
    })
    await expect(f.service.commit(saved, proposed, mixed)).rejects.toThrow(
      'existing user-authorized chain instructions'
    )
    expect(f.runtime.listSessionChains()[0]?.outcomeSet?.outcomes[0]?.actions).toEqual([])
    expect(f.launched).toEqual([])
  } finally {
    await f.dispose()
  }
})
