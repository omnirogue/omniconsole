import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationTerminalInput } from '../automations/terminal-input-authority'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityTerminalAuthority
} from './omni-runtime'

const { assertAuthority, assertReadiness, bindLaunch, bindWorkspace, events } = vi.hoisted(() => ({
  assertAuthority: vi.fn(),
  assertReadiness: vi.fn(),
  bindLaunch: vi.fn(),
  bindWorkspace: vi.fn(),
  events: [] as string[]
}))

vi.mock('../automations/terminal-input-authority', () => ({
  assertAutomationTerminalInputAuthority: assertAuthority
}))
vi.mock('../automations/reused-pane-readiness', () => ({
  assertAutomationPaneAcceptsInput: assertReadiness
}))
vi.mock('../automations/automation-output-binding', () => ({
  bindAutomationOutputLaunch: bindLaunch,
  bindAutomationOutputWorkspace: bindWorkspace
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const request: AutomationTerminalInput = {
  workspaceId: 'workspace-1',
  paneKey: 'pane-1',
  ptyId: 'pty-1',
  text: 'Draft a note'
}
const outputBinding: NonNullable<AutomationTerminalInput['automationOutputBinding']> = {
  automationId: 'automation-1',
  runId: 'run-1',
  token: 'host-issued-token'
}

function harness() {
  const authority: OrchestrationCompatibilityTerminalAuthority = {
    runtimeId: 'runtime-1',
    terminalHandle: 'terminal-1',
    ptyId: request.ptyId,
    worktreeId: request.workspaceId,
    processIncarnation: 'incarnation-1',
    paneKey: request.paneKey,
    launchTokenHash: null,
    hostScope: { kind: 'local', hostId: 'local' }
  }
  const beforeReservation = deferred()
  const allowReservation = deferred()
  const writes: string[] = []
  const store = { getWorktreeMeta: vi.fn() }
  const sendTerminal = vi.fn<OrcaRuntimeService['sendTerminal']>(
    async (handle, _action, options) => {
      for (const chunk of ['first', 'second']) {
        await options?.beforeWrite?.(request.ptyId)
        beforeReservation.resolve()
        await allowReservation.promise
        options?.reserveWrite?.(request.ptyId)
        events.push(`write:${chunk}`)
        writes.push(chunk)
      }
      return { handle, accepted: true, bytesWritten: 11 }
    }
  )
  const runtime = {
    store,
    getTerminalHandleForPaneKey: vi.fn(() => authority.terminalHandle),
    getOrchestrationDb: vi.fn(() => ({})),
    getTerminalProcessIncarnation: vi.fn(() => authority.processIncarnation),
    getOrchestrationDispatchAuthority: vi.fn(() => authority),
    ptysById: new Map(),
    sendTerminal
  }
  return {
    authority,
    store,
    writes,
    sendTerminal,
    beforeReservation,
    allowReservation,
    send: (input: AutomationTerminalInput = request) =>
      OrcaRuntimeService.prototype.sendAutomationInput.call(
        runtime as unknown as OrcaRuntimeService,
        input
      )
  }
}

beforeEach(() => {
  events.length = 0
  bindWorkspace.mockReset()
  assertAuthority.mockReset().mockImplementation(() => {
    events.push('authority')
  })
  assertReadiness.mockReset().mockImplementation(async () => {
    events.push('readiness')
  })
  bindLaunch.mockReset().mockImplementation(() => {
    events.push('bind')
    return true
  })
})

describe('reused automation output launch binding', () => {
  it('binds newly created workspaces through the runtime-owned store only', () => {
    const store = { getWorktreeMeta: vi.fn() }
    const provenance = {
      automationId: 'automation-1',
      automationRunId: 'run-1',
      dispatchToken: 'dispatch-token',
      createRequestId: 'request-1'
    }
    OrcaRuntimeService.prototype.bindAutomationOutputWorkspace.call(
      { store } as unknown as OrcaRuntimeService,
      provenance,
      'workspace-1'
    )
    expect(bindWorkspace).toHaveBeenCalledExactlyOnceWith(store, provenance, 'workspace-1')
    OrcaRuntimeService.prototype.bindAutomationOutputWorkspace.call(
      { store: undefined } as unknown as OrcaRuntimeService,
      provenance,
      'workspace-2'
    )
    expect(bindWorkspace).toHaveBeenCalledTimes(1)
  })

  it('binds only at the synchronous write reservation after revalidating authority', async () => {
    const fixture = harness()
    const pending = fixture.send({ ...request, automationOutputBinding: outputBinding })
    await fixture.beforeReservation.promise
    expect(events).toEqual(['authority', 'readiness', 'authority'])
    expect(bindLaunch).not.toHaveBeenCalled()
    expect(fixture.writes).toEqual([])

    fixture.allowReservation.resolve()
    await expect(pending).resolves.toMatchObject({ accepted: true })
    expect(events).toEqual([
      'authority',
      'readiness',
      'authority',
      'authority',
      'bind',
      'write:first',
      'authority',
      'authority',
      'bind',
      'write:second'
    ])
    expect(bindLaunch).toHaveBeenCalledTimes(2)
    for (const [input] of bindLaunch.mock.calls) {
      expect(input).toEqual({
        request: outputBinding,
        authority: fixture.authority,
        store: fixture.store,
        reused: true
      })
    }
  })

  it('does not bind or write when authority becomes invalid after beforeWrite yields', async () => {
    const fixture = harness()
    const pending = fixture.send()
    await fixture.beforeReservation.promise
    assertAuthority.mockImplementation(() => {
      throw new Error('automation_terminal_authority_changed')
    })
    fixture.allowReservation.resolve()
    await expect(pending).rejects.toThrow('automation_terminal_authority_changed')
    expect(bindLaunch).not.toHaveBeenCalled()
    expect(fixture.writes).toEqual([])
  })

  it.each([
    ['absent', undefined],
    ['unrecognized', outputBinding]
  ] as const)(
    'preserves ordinary input when an %s structured binding cannot be established',
    async (_label, automationOutputBinding) => {
      bindLaunch.mockReturnValue(false)
      const fixture = harness()
      const pending = fixture.send({ ...request, automationOutputBinding })
      await fixture.beforeReservation.promise
      fixture.allowReservation.resolve()
      await expect(pending).resolves.toMatchObject({ accepted: true })
      expect(fixture.writes).toEqual(['first', 'second'])
      if (!automationOutputBinding) {
        expect(bindLaunch).not.toHaveBeenCalled()
      }
    }
  )

  it('never attempts a binding when initial input admission refuses', async () => {
    assertAuthority.mockImplementation(() => {
      throw new Error('automation_terminal_authority_changed')
    })
    const fixture = harness()
    await expect(fixture.send()).rejects.toThrow('automation_terminal_authority_changed')
    expect(assertReadiness).not.toHaveBeenCalled()
    expect(fixture.sendTerminal).not.toHaveBeenCalled()
    expect(bindLaunch).not.toHaveBeenCalled()
  })
})
