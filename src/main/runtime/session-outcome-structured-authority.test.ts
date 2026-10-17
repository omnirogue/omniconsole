import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { sessionOutcomeSource } from './session-outcome-source-authority'
import {
  assertSessionOutcomeUser,
  sessionOutcomeMutationAuthority
} from './session-outcome-authority'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  for (const f of fixtures.splice(0)) {
    await f.dispose()
  }
})

it('discovers the same editable outcome set from native source authority without a PTY', async () => {
  const f = outcomeRuntimeFixture(() => {
    throw new Error('No worker should launch')
  })
  fixtures.push(f)
  const evidence = { agentSessionId: 'native', paneKey: 'native-pane', launchToken: 'child-secret' }
  const authorizeOutcomeSource = vi.fn(() => ({
    sessionId: 'native',
    handle: 'agent-session:native',
    paneKey: 'native-pane',
    worktreeId: 'folder:outcome',
    prompt: 'Produce the approved report.',
    clientMessageId: 'send-1',
    fence: 1
  }))
  setStructuredAgentSessionHost({
    outcomeSource: { authorize: authorizeOutcomeSource }
  } as unknown as StructuredAgentSessionHost)
  const terminal = vi.mocked(f.runtime.resolveTerminalPane).mockImplementation(() => {
    throw new Error('Native source has no terminal')
  })
  const context = { runtime: f.runtime, orchestrationCompatibilityEvidence: evidence }
  const source = await sessionOutcomeSource(context, { paneKey: 'native-pane' })
  expect(source.prompt).toBe('Produce the approved report.')
  expect(source.chain.sourceRowKey).toBe(JSON.stringify(['local', 'folder:outcome', 'native-pane']))
  expect(source.expectedRevision).toBe(0)
  expect(terminal).not.toHaveBeenCalled()
  expect(authorizeOutcomeSource).toHaveBeenCalledWith(evidence)
  expect(sessionOutcomeMutationAuthority(context, source.chain, 'user')).toEqual({
    source: 'ai',
    instruction: source.prompt
  })
  expect(() => assertSessionOutcomeUser(context)).toThrow('authenticated user interface')

  await expect(sessionOutcomeSource(context, { paneKey: 'other-pane' })).rejects.toThrow(
    'native source'
  )
  await expect(
    sessionOutcomeSource(context, { paneKey: 'native-pane', worktreeId: 'other-workspace' })
  ).rejects.toThrow('native source')
  setStructuredAgentSessionHost(null)
  await expect(sessionOutcomeSource(context, { paneKey: 'native-pane' })).rejects.toThrow(
    'native source'
  )
})
