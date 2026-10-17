import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'
import type { OrchestrationCompatibilityTerminalAuthority } from '../runtime/omni-runtime'
import { parseAutomationFinalTurn, type readAutomationFinalTurn } from './automation-final-turn'
import type { AutomationOutputBinding } from './automation-output-binding'
import { createAutomationFinalOutputResolver } from './automation-output-provenance'

const stopReceivedAt = 1_789_956_434_803
const firstFinalAt = 1_789_956_434_806
const startedAt = stopReceivedAt - 10_000
const nativePath = '/fixture/native-codex-rollout.jsonl'
const nativeSessionId = 'native-session-1'
const launchToken = 'immutable-native-launch'
const report = '  Confirmed current-run report.\nEvidence: complete.\n'

function event(type: string, time: number, fields: Record<string, unknown> = {}) {
  return {
    type: 'event_msg',
    timestamp: new Date(time).toISOString(),
    payload: { type, ...fields }
  }
}

function user(time: number, content: string) {
  return {
    type: 'response_item',
    timestamp: new Date(time).toISOString(),
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: content }]
    }
  }
}

function taskStart(time = startedAt, turnId = 'original-turn') {
  return event('task_started', time, { turn_id: turnId })
}

function taskComplete(time = firstFinalAt, content = report, turnId = 'original-turn') {
  return event('task_complete', time, { turn_id: turnId, last_agent_message: content })
}

function originalTurn() {
  return [
    {
      type: 'session_meta',
      timestamp: new Date(startedAt - 1).toISOString(),
      payload: { id: nativeSessionId }
    },
    taskStart(),
    user(startedAt, '# AGENTS.md context\n'.padEnd(25_487, '.')),
    user(startedAt + 1, 'Produce the automation report.'.padEnd(290, '.'))
  ]
}

function transcript(...rows: unknown[]) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
}

function run(): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'routine-1',
    title: 'Routine report',
    scheduledFor: startedAt,
    status: 'dispatched',
    trigger: 'manual',
    workspaceId: 'workspace-1',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'terminal-1',
    terminalPaneKey: 'pane-1',
    terminalPtyId: 'pty-1',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt,
    dispatchedAt: startedAt - 1,
    createdAt: startedAt - 2,
    providerSessionAgent: 'codex',
    providerSessionId: 'saved-earlier-session',
    providerSessionTranscriptPath: '/fixture/saved-earlier-rollout.jsonl'
  }
}

function fixture() {
  const binding: AutomationOutputBinding = Object.freeze({
    automationId: 'routine-1',
    runId: 'run-1',
    agent: 'codex',
    workspaceId: 'workspace-1',
    paneKey: 'pane-1',
    terminalHandle: 'terminal-1',
    ptyId: 'pty-1',
    processIncarnation: 'process-1',
    launchTokenHash: createHash('sha256').update(launchToken).digest('hex'),
    startedAt
  })
  const row: AgentStatusIpcPayload = {
    paneKey: binding.paneKey,
    worktreeId: binding.workspaceId,
    terminalHandle: binding.terminalHandle,
    launchToken,
    connectionId: null,
    state: 'done',
    prompt: 'Routine prompt',
    agentType: 'codex',
    stateStartedAt: stopReceivedAt,
    receivedAt: stopReceivedAt,
    providerSession: {
      key: 'session_id',
      id: nativeSessionId,
      transcriptPath: nativePath
    },
    observation: {
      origin: 'hook',
      kind: 'transition',
      authorityId: 'main-fixture',
      incarnation: 1,
      revision: 2,
      observedAt: stopReceivedAt
    }
  }
  const authority: OrchestrationCompatibilityTerminalAuthority = {
    runtimeId: 'runtime-1',
    terminalHandle: binding.terminalHandle,
    ptyId: binding.ptyId,
    processIncarnation: binding.processIncarnation,
    paneKey: binding.paneKey,
    launchTokenHash: binding.launchTokenHash,
    worktreeId: binding.workspaceId,
    hostScope: { kind: 'local', hostId: 'local' }
  }
  const state = {
    text: transcript(...originalTurn(), taskComplete()),
    now: firstFinalAt,
    authority: authority as OrchestrationCompatibilityTerminalAuthority | null,
    afterParse: undefined as (() => void) | undefined
  }
  const readNativeStatus = vi.fn(() => [row])
  const readBinding = vi.fn(() => binding)
  const readAuthority = vi.fn(() => state.authority)
  const readFinalTurn = vi.fn<typeof readAutomationFinalTurn>((input) => {
    const parsed = parseAutomationFinalTurn(state.text, input)
    state.afterParse?.()
    return parsed
  })
  const now = vi.fn(() => state.now)
  const resolve = createAutomationFinalOutputResolver(
    readNativeStatus,
    readFinalTurn,
    readBinding,
    readAuthority,
    now
  )
  const currentRun = run()
  const claimedResult: AutomationDispatchResult = {
    runId: currentRun.id,
    status: 'completed',
    providerSession: {
      providerSessionAgent: 'codex',
      providerSessionId: 'renderer-session',
      providerSessionTranscriptPath: '/fixture/renderer-rollout.jsonl'
    },
    outputSnapshot: {
      format: 'plain_text',
      content: 'Renderer claims success',
      capturedAt: firstFinalAt + 60_000,
      truncated: false,
      provenance: 'assistant_message'
    }
  }
  return {
    state,
    binding,
    row,
    authority,
    readNativeStatus,
    readBinding,
    readAuthority,
    readFinalTurn,
    now,
    currentRun,
    claimedResult,
    resolve: () => resolve(currentRun, claimedResult)
  }
}

describe('native automation final proof Stop/transcript ordering', () => {
  it.each([firstFinalAt, firstFinalAt + 1, firstFinalAt + 60_000])(
    'accepts the same first turn completed 3 ms after Stop when host time is %s',
    (observedAt) => {
      const f = fixture()
      f.state.now = observedAt

      expect(f.resolve()).toEqual({
        format: 'plain_text',
        content: report,
        capturedAt: firstFinalAt,
        truncated: false,
        provenance: 'assistant_message'
      })
      expect(f.row.receivedAt).toBe(stopReceivedAt)
      expect(f.readFinalTurn).toHaveBeenCalledExactlyOnceWith({
        agent: 'codex',
        sessionId: nativeSessionId,
        transcriptPath: nativePath,
        startedAt,
        completedAt: observedAt
      })
      expect(f.readNativeStatus).toHaveBeenCalledWith(f.binding.paneKey)
      expect(f.readAuthority).toHaveBeenCalledWith(f.binding.terminalHandle)
      expect(JSON.stringify(f.readFinalTurn.mock.calls)).not.toMatch(/renderer|saved-earlier/)
    }
  )

  it('rejects the future final at 4805 and accepts it on a retry at exactly 4806', () => {
    const f = fixture()
    f.state.now = 1_789_956_434_805

    expect(f.resolve()).toBeNull()
    expect(f.readFinalTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        completedAt: 1_789_956_434_805
      })
    )

    f.state.now = 1_789_956_434_806
    expect(f.resolve()).toMatchObject({ content: report, capturedAt: firstFinalAt })
    expect(f.readFinalTurn).toHaveBeenCalledTimes(2)
  })

  it.each([1, 3, 4_999, 5_000, 60_000])(
    'does not grant a future-completion grace period of %s ms',
    (futureMs) => {
      const f = fixture()
      f.state.text = transcript(...originalTurn(), taskComplete(f.state.now + futureMs))
      expect(f.resolve()).toBeNull()
    }
  )

  it.each(['unfinished', 'error'] as const)(
    'does not replace an %s original turn with a later successful task',
    (originalState) => {
      const f = fixture()
      const original = originalTurn()
      const failure =
        originalState === 'error'
          ? [
              event('error', stopReceivedAt, {
                turn_id: 'original-turn',
                message: 'Provider failed'
              })
            ]
          : []
      f.state.now = firstFinalAt + 20
      f.state.text = transcript(
        ...original,
        ...failure,
        taskStart(firstFinalAt + 10, 'unrelated-turn'),
        user(firstFinalAt + 11, 'A later unrelated prompt'),
        taskComplete(firstFinalAt + 20, 'Unrelated successful report', 'unrelated-turn')
      )

      expect(f.resolve()).toBeNull()
    }
  )

  it('preserves the original final after a subsequent unrelated task completes', () => {
    const f = fixture()
    f.state.now = firstFinalAt + 20
    f.state.text = transcript(
      ...originalTurn(),
      taskComplete(),
      taskStart(firstFinalAt + 10, 'unrelated-turn'),
      user(firstFinalAt + 11, 'A later unrelated prompt'),
      taskComplete(firstFinalAt + 20, 'Unrelated successful report', 'unrelated-turn')
    )

    expect(f.resolve()).toMatchObject({ content: report, capturedAt: firstFinalAt })
  })
})

describe('native automation final proof authority during retries', () => {
  it.each(['ptyId', 'processIncarnation', 'launchTokenHash'] as const)(
    'rejects a retained original hook after %s replacement before retry',
    (field) => {
      const f = fixture()
      f.state.now = firstFinalAt - 1
      expect(f.resolve()).toBeNull()

      f.state.now = firstFinalAt
      f.state.authority = { ...f.authority, [field]: 'replacement-identity' }
      expect(f.resolve()).toBeNull()
      expect(f.readFinalTurn).toHaveBeenCalledTimes(1)
    }
  )

  it('rejects a retry if current native authority has disappeared', () => {
    const f = fixture()
    f.state.now = firstFinalAt - 1
    expect(f.resolve()).toBeNull()

    f.state.now = firstFinalAt
    f.state.authority = null
    expect(f.resolve()).toBeNull()
    expect(f.readFinalTurn).toHaveBeenCalledTimes(1)
  })

  it('rejects a real parsed final if current authority changes during the transcript read', () => {
    const f = fixture()
    f.state.afterParse = () => {
      f.state.authority = { ...f.authority, processIncarnation: 'replacement-process' }
    }

    expect(f.resolve()).toBeNull()
    expect(f.readFinalTurn).toHaveReturnedWith({ content: report, completedAt: firstFinalAt })
  })

  it('rechecks authority fields even when the reader retains the same mutable object', () => {
    const f = fixture()
    f.state.afterParse = () => {
      f.authority.ptyId = 'replacement-pty'
    }

    expect(f.resolve()).toBeNull()
    expect(f.readFinalTurn).toHaveReturnedWith({ content: report, completedAt: firstFinalAt })
  })
})
