import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Automation,
  AutomationOutputBindingRequest,
  AutomationRun
} from '../../shared/automations-types'
import type { AutomationWorkspaceProvenanceRequest } from '../../shared/worktree/types'
import type { OrchestrationCompatibilityTerminalAuthority } from '../runtime/omni-runtime'
import {
  bindAutomationOutputLaunch,
  bindAutomationOutputWorkspace,
  bindHeadlessAutomationOutputLaunch,
  createAutomationDispatchRequest,
  createAutomationOutputBindingRequest,
  nativeLaunchMatchesAutomationBinding,
  readAutomationOutputBinding
} from './automation-output-binding'
import {
  beginAutomationDispatchTokenUse,
  clearAutomationDispatchTokens,
  createAutomationDispatchToken,
  finishAutomationDispatchTokenUse,
  releaseAutomationDispatchTokenUse
} from './dispatch-tokens'

const ISSUED_AT = Date.parse('2026-09-20T12:00:00Z')
const DISPATCH_TTL = 30 * 60_000
const BOUND_TTL = 24 * 60 * 60_000
const LAUNCH_TOKEN = 'native-launch-token'
const LAUNCH_HASH = createHash('sha256').update(LAUNCH_TOKEN).digest('hex')
const issuedRuns: { automationId: string; runId: string }[] = []

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'automation-1',
    agentId: 'codex',
    executionTargetType: 'local',
    workspaceMode: 'existing',
    workspaceId: 'workspace-1',
    structuredOutput: { provider: 'typesafe', contract: 'classification.v1' },
    ...overrides
  } as Automation
}

function authority(
  overrides: Partial<OrchestrationCompatibilityTerminalAuthority> = {}
): OrchestrationCompatibilityTerminalAuthority {
  return {
    runtimeId: 'runtime-1',
    terminalHandle: 'terminal-1',
    ptyId: 'pty-1',
    worktreeId: 'workspace-1',
    processIncarnation: 'process-1',
    paneKey: 'pane-1',
    launchTokenHash: LAUNCH_HASH,
    hostScope: { kind: 'local', hostId: 'local' },
    ...overrides
  }
}

function issue(store: object, definition: Automation, run: AutomationRun) {
  issuedRuns.push({ automationId: definition.id, runId: run.id })
  return createAutomationOutputBindingRequest(store, definition, run)
}

function fixture(overrides: Partial<Automation> = {}, store: object = {}) {
  const definition = automation(overrides)
  const run = { id: 'run-1', automationId: definition.id } as AutomationRun
  const request = issue(store, definition, run)
  if (!request) {
    throw new Error('Fixture requires an admitted output binding grant')
  }
  const actual = authority()
  return {
    store,
    definition,
    run,
    request,
    actual,
    bind: (options: Partial<Parameters<typeof bindAutomationOutputLaunch>[0]> = {}) =>
      bindAutomationOutputLaunch({ store, request, authority: actual, agent: 'codex', ...options }),
    read: () => readAutomationOutputBinding(store, run)
  }
}

function workspaceRequest(
  request: AutomationOutputBindingRequest
): AutomationWorkspaceProvenanceRequest {
  return {
    automationId: request.automationId,
    automationRunId: request.runId,
    dispatchToken: createAutomationDispatchToken(request.automationId, request.runId),
    createRequestId: 'create-1'
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ISSUED_AT)
})

afterEach(() => {
  for (const { automationId, runId } of issuedRuns) {
    clearAutomationDispatchTokens(automationId, runId)
  }
  issuedRuns.length = 0
  vi.useRealTimers()
})

describe('automation output binding grants', () => {
  it('issues independent launch provenance without an Off output binding', () => {
    const definition = automation({ structuredOutput: undefined })
    const run = { id: 'run-1', automationId: definition.id } as AutomationRun
    issuedRuns.push({ automationId: definition.id, runId: run.id })

    const request = createAutomationDispatchRequest({}, definition, run)

    expect(request).toEqual({
      automation: definition,
      run,
      dispatchToken: expect.any(String),
      launchProvenance: { automationId: definition.id, runId: run.id, token: expect.any(String) }
    })
    expect(request).not.toHaveProperty('outputBinding')
    expect(request).not.toHaveProperty('automationOutputBinding')
    expect(
      beginAutomationDispatchTokenUse({
        automationId: definition.id,
        runId: run.id,
        token: request.dispatchToken,
        reservationId: 'ordinary-dispatch'
      })
    ).toBe(true)
  })

  it.each([
    ['Off local', { structuredOutput: undefined }],
    ['opted-in SSH', { executionTargetType: 'ssh' }],
    ['Off SSH', { structuredOutput: undefined, executionTargetType: 'ssh' }]
  ] satisfies [string, Partial<Automation>][])(
    'does not issue a grant for %s routines',
    (_label, overrides) => {
      const definition = automation(overrides)
      const store = {}
      const run = { id: 'run-1', automationId: definition.id } as AutomationRun

      expect(issue(store, definition, run)).toBeUndefined()
      expect(readAutomationOutputBinding(store, run)).toBeNull()
    }
  )

  it('returns independent copies of one scoped grant without granting a colliding automation', () => {
    const f = fixture()
    const repeated = issue(f.store, f.definition, f.run)
    expect(repeated).toEqual(f.request)
    expect(repeated).not.toBe(f.request)
    expect(issue(f.store, automation({ id: 'other-automation' }), f.run)).toBeUndefined()
    f.request.token = 'mutated-client-copy'
    expect(f.bind()).toBe(false)
    expect(f.bind({ request: repeated })).toBe(true)
  })

  it('captures the actual terminal identity and keeps the admitted agent and workspace pinned', () => {
    const f = fixture()
    f.definition.agentId = 'claude'
    f.definition.workspaceId = 'changed-workspace'
    f.run.workspaceId = 'untrusted-run-workspace'
    f.run.terminalPaneKey = 'untrusted-run-pane'

    expect(f.bind()).toBe(true)
    expect(f.read()).toEqual({
      automationId: f.definition.id,
      runId: f.run.id,
      agent: 'codex',
      workspaceId: 'workspace-1',
      paneKey: 'pane-1',
      terminalHandle: 'terminal-1',
      ptyId: 'pty-1',
      processIncarnation: 'process-1',
      launchTokenHash: LAUNCH_HASH,
      startedAt: ISSUED_AT
    })
    expect(Object.isFrozen(f.read())).toBe(true)
    expect(readAutomationOutputBinding(f.store, { ...f.run, automationId: 'other' })).toBeNull()
  })

  it.each(['automationId', 'runId', 'token'] as const)(
    'rejects a mismatched %s without consuming the valid grant',
    (field) => {
      const f = fixture()
      expect(f.bind({ request: { ...f.request, [field]: 'wrong-value' } })).toBe(false)
      expect(f.read()).toBeNull()
      expect(f.bind()).toBe(true)
    }
  )

  it.each([
    ['missing authority', null],
    ['SSH authority', authority({ hostScope: { kind: 'ssh', targetId: 'ssh-1' } })],
    ['WSL authority', authority({ hostScope: { kind: 'wsl', hostId: 'local', distro: 'Ubuntu' } })],
    ['different workspace', authority({ worktreeId: 'workspace-2' })],
    ['missing pane', authority({ paneKey: null })],
    ['missing process incarnation', authority({ processIncarnation: null })],
    ['missing launch hash', authority({ launchTokenHash: null })]
  ] as const)('rejects %s before binding', (_label, actual) => {
    const f = fixture()
    expect(f.bind({ authority: actual })).toBe(false)
    expect(f.read()).toBeNull()
    expect(f.bind()).toBe(true)
  })

  it('rejects absent requests and different agents without consuming the grant', () => {
    const f = fixture()
    expect(f.bind({ request: undefined })).toBe(false)
    expect(f.bind({ agent: 'claude' })).toBe(false)
    expect(f.bind()).toBe(true)
  })

  it('consumes the scoped dispatch token and permits identical binding retries only', () => {
    const f = fixture()
    expect(f.bind()).toBe(true)
    const binding = f.read()
    expect(beginAutomationDispatchTokenUse({ ...f.request, reservationId: f.actual.ptyId })).toBe(
      false
    )
    vi.setSystemTime(ISSUED_AT + 5_000)
    expect(f.bind({ reused: true })).toBe(true)
    expect(f.read()).toBe(binding)
    expect(f.read()?.startedAt).toBe(ISSUED_AT)
  })

  it.each([
    ['workspace', { worktreeId: 'workspace-2' }],
    ['pane', { paneKey: 'pane-2' }],
    ['terminal handle', { terminalHandle: 'terminal-2' }],
    ['PTY', { ptyId: 'pty-2' }],
    ['process incarnation', { processIncarnation: 'process-2' }],
    ['launch token hash', { launchTokenHash: 'different-hash' }]
  ] satisfies [string, Partial<OrchestrationCompatibilityTerminalAuthority>][])(
    'cannot replace an established binding with a different %s',
    (_label, change) => {
      const f = fixture()
      expect(f.bind()).toBe(true)
      const binding = f.read()
      expect(f.bind({ authority: authority(change) })).toBe(false)
      expect(f.read()).toBe(binding)
      expect(f.bind()).toBe(true)
    }
  )

  it('honors dispatch-token reservation ownership and refuses consumed tokens', () => {
    const f = fixture()
    const reservation = { ...f.request, reservationId: 'other-pty' }
    expect(beginAutomationDispatchTokenUse(reservation)).toBe(true)
    expect(f.bind()).toBe(false)
    releaseAutomationDispatchTokenUse(reservation)
    expect(f.bind()).toBe(false)
    finishAutomationDispatchTokenUse(reservation)
    expect(f.bind()).toBe(false)
    expect(f.read()).toBeNull()
  })

  it('isolates grants and bound records by Store even for identical routine and run IDs', () => {
    const first = fixture()
    const second = fixture()
    expect(first.request.token).not.toBe(second.request.token)
    expect(second.bind({ request: first.request })).toBe(false)
    expect(readAutomationOutputBinding({}, first.run)).toBeNull()
    expect(first.bind()).toBe(true)
    expect(second.read()).toBeNull()
    expect(second.bind({ authority: authority({ paneKey: 'second-store-pane' }) })).toBe(true)
    expect(first.read()?.paneKey).toBe('pane-1')
    expect(second.read()?.paneKey).toBe('second-store-pane')
  })

  it('captures a reused run start at write admission instead of grant issuance', () => {
    const f = fixture()
    expect(f.read()).toBeNull()
    vi.setSystemTime(ISSUED_AT + 25_000)
    expect(f.bind({ reused: true, agent: undefined })).toBe(true)
    expect(f.read()?.startedAt).toBe(ISSUED_AT + 25_000)
    vi.setSystemTime(ISSUED_AT + 40_000)
    expect(f.bind({ reused: true, agent: undefined })).toBe(true)
    expect(f.read()?.startedAt).toBe(ISSUED_AT + 25_000)
  })

  it('keeps the issuance time for a fresh launch admitted later', () => {
    const f = fixture()
    vi.setSystemTime(ISSUED_AT + 25_000)
    expect(f.bind()).toBe(true)
    expect(f.read()?.startedAt).toBe(ISSUED_AT)
  })
})

describe('automation output binding lifetime', () => {
  it('admits an unbound grant immediately before the 30-minute deadline', () => {
    const f = fixture()
    vi.setSystemTime(ISSUED_AT + DISPATCH_TTL - 1)
    expect(f.bind()).toBe(true)
  })

  it('expires an unbound grant at 30 minutes without extending it on repeated issuance', () => {
    const f = fixture()
    vi.setSystemTime(ISSUED_AT + DISPATCH_TTL - 1)
    expect(issue(f.store, f.definition, f.run)).toEqual(f.request)
    vi.setSystemTime(ISSUED_AT + DISPATCH_TTL)
    expect(f.bind()).toBe(false)
    const replacement = issue(f.store, f.definition, f.run)
    expect(replacement?.token).not.toBe(f.request.token)
    expect(f.bind({ request: replacement })).toBe(true)
  })

  it('keeps a binding for 24 hours from admission without extending it on rebind', () => {
    const f = fixture()
    const boundAt = ISSUED_AT + 10_000
    vi.setSystemTime(boundAt)
    expect(f.bind()).toBe(true)
    const binding = f.read()
    vi.setSystemTime(boundAt + BOUND_TTL - 1)
    expect(f.read()).toBe(binding)
    expect(f.bind()).toBe(true)
    vi.setSystemTime(boundAt + BOUND_TTL)
    expect(f.read()).toBeNull()
    expect(f.bind()).toBe(false)
  })

  it.each([false, true])('caps grants at 512 including bound=%s records', (bound) => {
    const f = fixture()
    if (bound) {
      expect(f.bind()).toBe(true)
    }
    const moreRuns = Array.from({ length: 511 }, (_, index) => ({
      ...f.run,
      id: `run-${index + 2}`
    }))
    for (const run of moreRuns) {
      expect(issue(f.store, f.definition, run)).toBeDefined()
    }
    expect(issue(f.store, f.definition, f.run)).toEqual(f.request)
    expect(issue(f.store, f.definition, { ...f.run, id: 'run-513' })).toBeDefined()
    expect(f.read()).toBeNull()
    expect(f.bind()).toBe(false)
    const retainedRun = moreRuns[0]!
    const retainedRequest = issue(f.store, f.definition, retainedRun)
    expect(f.bind({ request: retainedRequest })).toBe(true)
    expect(readAutomationOutputBinding(f.store, retainedRun)?.runId).toBe(retainedRun.id)
  })
})

describe('automation output native launch matching', () => {
  it('matches the exact native launch token using its SHA-256 digest', () => {
    const f = fixture()
    expect(f.bind()).toBe(true)
    const binding = f.read()!
    expect(binding.launchTokenHash).toBe(LAUNCH_HASH)
    expect(nativeLaunchMatchesAutomationBinding(binding, LAUNCH_TOKEN)).toBe(true)
    for (const token of [undefined, '', 'another-token', LAUNCH_HASH]) {
      expect(nativeLaunchMatchesAutomationBinding(binding, token)).toBe(false)
    }
  })
})

describe('headless automation output binding', () => {
  it('associates the trusted newly created workspace before binding its actual launch', () => {
    const f = fixture({ workspaceMode: 'new_per_run', workspaceId: null })
    const actual = authority({ worktreeId: 'new-workspace' })
    expect(f.bind({ authority: actual })).toBe(false)
    expect(
      bindHeadlessAutomationOutputLaunch({
        store: f.store,
        request: f.request,
        authority: actual,
        agent: 'codex'
      })
    ).toBe(true)
    expect(f.read()?.workspaceId).toBe('new-workspace')
  })

  it.each(['automation', 'agent', 'native launch hash'] as const)(
    'a rejected headless %s claim cannot pin the workspace before a valid launch',
    (mismatch) => {
      const f = fixture({ workspaceMode: 'new_per_run', workspaceId: null })
      const input = {
        store: f.store,
        request: f.request,
        authority: authority({ worktreeId: 'rejected-workspace' }),
        agent: 'codex'
      }
      if (mismatch === 'automation') {
        input.request = { ...f.request, automationId: 'wrong-automation' }
      } else if (mismatch === 'agent') {
        input.agent = 'claude'
      } else {
        input.authority.launchTokenHash = null
      }
      expect(bindHeadlessAutomationOutputLaunch(input)).toBe(false)
      expect(f.read()).toBeNull()
      expect(
        bindHeadlessAutomationOutputLaunch({
          store: f.store,
          request: f.request,
          authority: authority({ worktreeId: 'accepted-workspace' }),
          agent: 'codex'
        })
      ).toBe(true)
      expect(f.read()?.workspaceId).toBe('accepted-workspace')
    }
  )

  it('cannot replace an existing configured workspace through the headless helper', () => {
    const f = fixture()
    expect(
      bindHeadlessAutomationOutputLaunch({
        store: f.store,
        request: f.request,
        authority: authority({ worktreeId: 'another-workspace' }),
        agent: 'codex'
      })
    ).toBe(false)
    expect(f.bind()).toBe(true)
  })
})

describe('trusted new-per-run workspace binding', () => {
  it('binds a successfully created workspace without consuming the separate output token', () => {
    const f = fixture({ workspaceMode: 'new_per_run', workspaceId: 'old-workspace' })
    const request = workspaceRequest(f.request)
    const reservation = {
      automationId: request.automationId,
      runId: request.automationRunId,
      token: request.dispatchToken,
      reservationId: request.createRequestId
    }
    expect(request.dispatchToken).not.toBe(f.request.token)
    expect(beginAutomationDispatchTokenUse(reservation)).toBe(true)
    bindAutomationOutputWorkspace(f.store, request, 'created-workspace')
    finishAutomationDispatchTokenUse(reservation)
    expect(beginAutomationDispatchTokenUse(reservation)).toBe(false)
    expect(f.bind({ authority: authority({ worktreeId: 'old-workspace' }) })).toBe(false)
    expect(f.bind({ authority: authority({ worktreeId: 'created-workspace' }) })).toBe(true)
    expect(f.read()?.workspaceId).toBe('created-workspace')
  })

  it.each(['automation', 'run', 'store', 'absent request', 'empty workspace'] as const)(
    'ignores a workspace association with %s mismatch without poisoning the grant',
    (mismatch) => {
      const f = fixture({ workspaceMode: 'new_per_run', workspaceId: null })
      const valid = workspaceRequest(f.request)
      let request: AutomationWorkspaceProvenanceRequest | undefined = valid
      if (mismatch === 'automation') {
        request = { ...valid, automationId: 'other-automation' }
      } else if (mismatch === 'run') {
        request = { ...valid, automationRunId: 'other-run' }
      } else if (mismatch === 'absent request') {
        request = undefined
      }
      bindAutomationOutputWorkspace(
        mismatch === 'store' ? {} : f.store,
        request,
        mismatch === 'empty workspace' ? '' : 'rejected-workspace'
      )
      expect(f.bind({ authority: authority({ worktreeId: 'rejected-workspace' }) })).toBe(false)
      bindAutomationOutputWorkspace(f.store, valid, 'created-workspace')
      expect(f.bind({ authority: authority({ worktreeId: 'created-workspace' }) })).toBe(true)
    }
  )

  it('keeps the first trusted workspace association before and after launch binding', () => {
    const f = fixture({ workspaceMode: 'new_per_run', workspaceId: null })
    const request = workspaceRequest(f.request)
    bindAutomationOutputWorkspace(f.store, request, 'created-workspace')
    bindAutomationOutputWorkspace(f.store, request, 'replacement-workspace')
    expect(f.bind({ authority: authority({ worktreeId: 'replacement-workspace' }) })).toBe(false)
    expect(f.bind({ authority: authority({ worktreeId: 'created-workspace' }) })).toBe(true)
    const binding = f.read()
    bindAutomationOutputWorkspace(f.store, request, 'post-launch-workspace')
    expect(f.read()).toBe(binding)
    expect(f.read()?.workspaceId).toBe('created-workspace')
  })

  it('cannot change a configured existing workspace or revive an expired dispatch grant', () => {
    const existing = fixture()
    bindAutomationOutputWorkspace(existing.store, workspaceRequest(existing.request), 'other')
    expect(existing.bind({ authority: authority({ worktreeId: 'other' }) })).toBe(false)
    expect(existing.bind()).toBe(true)
    const expired = fixture({ workspaceMode: 'new_per_run', workspaceId: null })
    const request = workspaceRequest(expired.request)
    vi.setSystemTime(ISSUED_AT + DISPATCH_TTL)
    bindAutomationOutputWorkspace(expired.store, request, 'created-workspace')
    expect(expired.bind({ authority: authority({ worktreeId: 'created-workspace' }) })).toBe(false)
    expect(expired.read()).toBeNull()
  })
})
