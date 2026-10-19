import { describe, expect, it, vi } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import type { SessionManageActor } from '../../shared/session-manage-types'
import {
  renameSession,
  restartSession,
  SESSION_HUNG_AFTER_MS,
  stopSession,
  type SessionControlDeps,
  type SessionControlTarget
} from './session-manage-control'
import { SessionManagePartialError } from './session-manage-refusal'
import { agentProcess, manageEntry, sidebarRow } from './session-manage-test-fixtures'
import { pauseOwnedTerminal } from './session-owner-pause'

const source: ConversationSource = {
  worktreeId: 'repo::/ads',
  paneKey: 'tab-2:leaf-2',
  kind: 'pty'
}
const actor: SessionManageActor = { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Manager' }
const NOW = 10_000_000

function deps(overrides: Partial<SessionControlDeps> = {}): SessionControlDeps {
  return {
    interrupt: vi.fn(async () => {}),
    stopKeepGoing: vi.fn(() => true),
    lastOutputAt: vi.fn(async () => NOW - 1_000),
    stillWorking: vi.fn(async () => false),
    resume: vi.fn(async () => ({
      summary: 'Resumed “Ads session”: the same conversation, in a new tab',
      tabId: 'tab-7',
      paneKey: 'tab-7:leaf-7'
    })),
    confirmRestarted: vi.fn(async () => ({ state: 'same' as const, paneKey: 'tab-7:leaf-7' })),
    keepCheckpoint: vi.fn(async () => true),
    rename: vi.fn(async (_target, title: string) => ({
      summary: `Renamed “Ads session” to “${title}”`,
      before: 'Ads session',
      after: title
    })),
    sleep: vi.fn(async () => {}),
    now: () => NOW,
    ...overrides
  }
}

function target(
  entry: Parameters<typeof manageEntry>[0] = {},
  row: Parameters<typeof sidebarRow>[0] = {}
): SessionControlTarget {
  return {
    entry: manageEntry(entry),
    row: sidebarRow({ paneKey: 'tab-2:leaf-2', tabId: 'tab-2', ...row }),
    source,
    agentProcess: agentProcess()
  }
}

const CONVERSATION = '2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c'
const exitedWithCheckpoint = () =>
  target(
    { verdict: 'exited', state: 'exited', terminal: null },
    { resumable: true, providerSessionId: CONVERSATION }
  )

describe('session restart', () => {
  it('resumes an exited session in the same provider conversation and sends nothing', async () => {
    const d = deps()
    const result = await restartSession(d, {
      actor,
      target: exitedWithCheckpoint(),
      dryRun: false
    })
    expect(d.resume).toHaveBeenCalledWith(
      { paneKey: 'tab-2:leaf-2', tabId: 'tab-2', keepCheckpoint: true },
      {
        trigger: 'session-resume',
        parentPaneKey: 'tab-2:leaf-2',
        actor: { kind: 'local-cli', paneKey: 'tab-9:leaf-9' }
      }
    )
    expect(d.confirmRestarted).toHaveBeenCalledWith(
      { sessionId: CONVERSATION, hostId: 'local', transcriptPath: null },
      'tab-7:leaf-7'
    )
    expect(d.interrupt).not.toHaveBeenCalled()
    expect(d.keepCheckpoint).not.toHaveBeenCalled()
    expect(result).toMatchObject({ outcome: 'restarted' })
    expect(result.summary).toContain('the same conversation, confirmed by its agent')
  })

  it.each([
    [
      'no hook report',
      { state: 'unconfirmed' as const },
      'did not report which conversation it opened within 30 s',
      'launched',
      'Its checkpoint was kept on that tab'
    ],
    [
      'another conversation',
      { state: 'different' as const, reported: 'fresh-1' },
      'reported a different conversation (fresh-1)',
      'original',
      'Its checkpoint was put back on its old pane'
    ]
  ] as const)(
    'reports a restart its agent hooks never confirmed as started_unconfirmed (%s), keeping its checkpoint',
    async (_name, verdict, reason, onto, note) => {
      const d = deps({ confirmRestarted: vi.fn(async () => verdict) })
      const result = await restartSession(d, {
        actor,
        target: exitedWithCheckpoint(),
        dryRun: false
      })
      expect(d.resume).toHaveBeenCalledWith(
        expect.objectContaining({ keepCheckpoint: true }),
        expect.anything()
      )
      expect(result).toMatchObject({
        outcome: 'started_unconfirmed',
        reason: expect.stringContaining(reason)
      })
      expect(d.keepCheckpoint).toHaveBeenCalledExactlyOnceWith('tab-7', onto)
      expect(result.summary).not.toContain('Resumed')
      expect(result.summary).toContain('unconfirmed')
      expect(result.summary).toContain(note)
      expect(result.summary).toContain(`omni session resume --ref claude:${CONVERSATION}@local`)
    }
  )

  it('never calls a restart confirmed when the new pane cannot be named, and keeps its checkpoint', async () => {
    const d = deps({ resume: vi.fn(async () => ({ summary: 'Resumed', tabId: 'tab-7' })) })
    const result = await restartSession(d, {
      actor,
      target: exitedWithCheckpoint(),
      dryRun: false
    })
    expect(d.confirmRestarted).not.toHaveBeenCalled()
    expect(d.keepCheckpoint).toHaveBeenCalledExactlyOnceWith('tab-7', 'original')
    expect(result).toMatchObject({
      outcome: 'started_unconfirmed',
      reason: 'its new pane could not be named'
    })
  })

  it('refuses an exited session with no checkpoint to resume', async () => {
    const d = deps()
    await expect(
      restartSession(d, {
        actor,
        target: target({ verdict: 'exited', state: 'exited' }),
        dryRun: false
      })
    ).rejects.toThrow('without a resumable checkpoint')
    expect(d.resume).not.toHaveBeenCalled()
  })

  it.each([
    ['unverifiable', { verdict: 'unverifiable', state: 'unknown' }],
    ['unknown', { verdict: 'live', state: 'unknown' }]
  ] as const)('never restarts an %s session', async (_name, entry) => {
    const d = deps()
    await expect(
      restartSession(d, { actor, target: target(entry, { resumable: true }), dryRun: false })
    ).rejects.toThrow('never treated as stopped or dead')
    expect(d.resume).not.toHaveBeenCalled()
    expect(d.interrupt).not.toHaveBeenCalled()
  })

  it('unsticks a hung turn by interrupting it, in the same conversation', async () => {
    const d = deps({ lastOutputAt: vi.fn(async () => NOW - SESSION_HUNG_AFTER_MS - 60_000) })
    const result = await restartSession(d, {
      actor,
      target: target({ state: 'working' }),
      dryRun: false
    })
    expect(d.stopKeepGoing).toHaveBeenCalled()
    expect(d.interrupt).toHaveBeenCalledWith('term_2', agentProcess(), source)
    expect(d.resume).not.toHaveBeenCalled()
    expect(result.summary).toContain('back at its prompt')
  })

  it('refuses a live session that is working and printing', async () => {
    const d = deps()
    await expect(
      restartSession(d, { actor, target: target({ state: 'working' }), dryRun: false })
    ).rejects.toThrow('not hung')
    expect(d.interrupt).not.toHaveBeenCalled()
  })

  it('changes nothing on a dry run', async () => {
    const d = deps()
    const result = await restartSession(d, {
      actor,
      target: target({ verdict: 'exited', state: 'exited' }, { resumable: true }),
      dryRun: true
    })
    expect(d.resume).not.toHaveBeenCalled()
    expect(result).toMatchObject({ dryRun: true })
    expect(result.summary).toContain('dry run')
  })

  it('leaves a chat-view session to its own tab', async () => {
    await expect(
      restartSession(deps(), { actor, target: target({ kind: 'chat' }), dryRun: false })
    ).rejects.toThrow('chat-view conversation')
  })
})

describe('session stop', () => {
  it('pauses archived idle sessions by disabling Keep going without interrupting', async () => {
    const d = deps()
    const result = await pauseOwnedTerminal(
      d,
      target({ archived: true, keepGoing: true, queueLength: 2 }),
      () => true
    )
    expect(result).toMatchObject({ state: 'paused', keepGoingStopped: true, queuedPrompts: 2 })
    expect(result.message).toContain('queued prompts will still be sent')
    expect(d.interrupt).not.toHaveBeenCalled()
    expect(d.stopKeepGoing).toHaveBeenCalledOnce()
  })

  it('counts idle with Keep going off as already idle, without an interrupt', async () => {
    const d = deps({ stopKeepGoing: vi.fn(() => false) })
    expect(await pauseOwnedTerminal(d, target(), () => true)).toMatchObject({
      state: 'already-idle'
    })
    expect(d.interrupt).not.toHaveBeenCalled()
  })

  it('refuses a changed pause target before stopping Keep going or interrupting', async () => {
    const d = deps()
    expect(await pauseOwnedTerminal(d, target({ state: 'working' }), () => false)).toMatchObject({
      state: 'source-changed'
    })
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
    expect(d.interrupt).not.toHaveBeenCalled()
  })

  it('reports pause uncertainty and a prior Keep going change without retrying', async () => {
    const d = deps({
      interrupt: vi.fn(async () => {
        throw new SessionManagePartialError('Inspect before retrying', 'interrupt may have arrived')
      })
    })
    expect(await pauseOwnedTerminal(d, target({ state: 'working' }), () => true)).toMatchObject({
      state: 'unverifiable',
      keepGoingStopped: true
    })
    expect(d.interrupt).toHaveBeenCalledOnce()
  })

  it('does not call a written interrupt paused until the same agent confirms idle', async () => {
    const d = deps({ stillWorking: vi.fn(async () => true) })
    const result = await pauseOwnedTerminal(d, target({ state: 'working' }), () => true)
    expect(result).toMatchObject({ state: 'unverifiable', keepGoingStopped: true })
    expect(result.message).toContain('has not confirmed an idle prompt')
    expect(d.interrupt).toHaveBeenCalledOnce()
    expect(d.stillWorking).toHaveBeenCalledWith('term_2', agentProcess())
  })

  it('refuses title-only work and missing receiver identity before interrupting', async () => {
    for (const unproven of [
      target({ state: 'working', stateBasis: 'title' }),
      { ...target({ state: 'working' }), agentProcess: null }
    ]) {
      const d = deps()
      await expect(
        stopSession(d, { actor, target: unproven, force: false, dryRun: false })
      ).rejects.toThrow('cannot be verified')
      expect(d.interrupt).not.toHaveBeenCalled()
      expect(d.stopKeepGoing).not.toHaveBeenCalled()
    }
  })

  it('interrupts a working agent and turns its Keep going off', async () => {
    const d = deps()
    const result = await stopSession(d, {
      actor,
      target: target({ state: 'working', keepGoing: true }),
      force: false,
      dryRun: false
    })
    expect(d.stopKeepGoing).toHaveBeenCalledWith(
      source,
      'Manager stopped this conversation at your request.'
    )
    expect(d.interrupt).toHaveBeenCalledWith('term_2', agentProcess(), source)
    expect(result.keepGoingStopped).toBe(true)
  })

  it('never interrupts an idle agent, so a second stop cannot exit it', async () => {
    const d = deps()
    await stopSession(d, { actor, target: target({ state: 'idle' }), force: false, dryRun: false })
    expect(d.interrupt).not.toHaveBeenCalled()
  })

  it('refuses an unanswered decision unless forced', async () => {
    const d = deps()
    await expect(
      stopSession(d, {
        actor,
        target: target({ state: 'awaiting-user' }),
        force: false,
        dryRun: false
      })
    ).rejects.toThrow('Pass --force')
    await expect(
      stopSession(d, {
        actor,
        target: target({ state: 'waiting-for-yes' }),
        force: false,
        dryRun: false
      })
    ).rejects.toThrow('unanswered decision')
    expect(d.interrupt).not.toHaveBeenCalled()
    await stopSession(d, {
      actor,
      target: target({ state: 'awaiting-user' }),
      force: true,
      dryRun: false
    })
    expect(d.interrupt).toHaveBeenCalledTimes(1)
  })

  it('never stops an unknown, unverifiable or exited session', async () => {
    for (const entry of [
      { verdict: 'live' as const, state: 'unknown' as const },
      { verdict: 'unverifiable' as const, state: 'unknown' as const },
      { verdict: 'exited' as const, state: 'exited' as const }
    ]) {
      await expect(
        stopSession(deps(), { actor, target: target(entry), force: true, dryRun: false })
      ).rejects.toThrow()
    }
  })

  it('refuses the session running the command', async () => {
    await expect(
      stopSession(deps(), {
        actor: { kind: 'pane', paneKey: 'tab-2:leaf-2', title: 'Ads session' },
        target: target({ state: 'working' }),
        force: false,
        dryRun: false
      })
    ).rejects.toThrow('cannot stop itself')
  })

  it('changes nothing on a dry run', async () => {
    const d = deps()
    const result = await stopSession(d, {
      actor,
      target: target({ state: 'working', keepGoing: true }),
      force: false,
      dryRun: true
    })
    expect(d.interrupt).not.toHaveBeenCalled()
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
    expect(result.summary).toContain('dry run')
  })
})

describe('session rename', () => {
  it('renames through the window and reports before and after', async () => {
    const d = deps()
    const result = await renameSession(d, {
      actor,
      target: target(),
      title: '  Ads: Q4 headlines ',
      dryRun: false
    })
    expect(d.rename).toHaveBeenCalledWith(
      { paneKey: 'tab-2:leaf-2', tabId: 'tab-2' },
      'Ads: Q4 headlines'
    )
    expect(result).toMatchObject({ before: 'Ads session', after: 'Ads: Q4 headlines' })
  })

  it('renames nothing on a dry run, and refuses a row with no tab', async () => {
    const d = deps()
    const dry = await renameSession(d, { actor, target: target(), title: 'New', dryRun: true })
    expect(d.rename).not.toHaveBeenCalled()
    expect(dry.summary).toBe(
      'Would rename “Ads session” to “New” in the sidebar and its tab (dry run: nothing changed).'
    )
    await expect(
      renameSession(d, { actor, target: target({}, { tabId: null }), title: 'New', dryRun: false })
    ).rejects.toThrow('no open tab')
  })
})

describe('stop and restart respect execution ownership and report partial effects', () => {
  it('refuses SSH without an owner stop ticket, including --force', async () => {
    const d = deps()
    const ssh = target({ state: 'working', hostId: 'ssh:build-box' })
    await expect(
      stopSession(d, { actor, target: ssh, force: true, dryRun: false })
    ).rejects.toThrow('has not supplied a verified guarded-stop ticket')
    await expect(restartSession(d, { actor, target: ssh, dryRun: false })).rejects.toThrow(
      'not on this computer'
    )
    expect(d.stopKeepGoing).not.toHaveBeenCalled()
    expect(d.interrupt).not.toHaveBeenCalled()
  })

  it('allows only stop with an owner ticket; restart and paired execution remain refused', async () => {
    const interrupt = vi.fn(async () => {})
    const d = deps({ interrupt })
    const ssh = target({ state: 'working', hostId: 'ssh:build-box' })
    ssh.agentProcess = agentProcess({ interruptToken: '9d283a44-cbc8-4db9-a2e5-fb8154cd8ba4' })
    const dry = await stopSession(d, { actor, target: ssh, force: false, dryRun: true })
    expect(dry.summary).toContain('Would interrupt')
    expect(interrupt).not.toHaveBeenCalled()
    await stopSession(d, { actor, target: ssh, force: false, dryRun: false })
    expect(interrupt).toHaveBeenCalledWith('term_2', ssh.agentProcess, source)
    await expect(restartSession(d, { actor, target: ssh, dryRun: false })).rejects.toThrow(
      'not on this computer'
    )
    ssh.entry.hostId = 'runtime:peer'
    await expect(
      stopSession(d, { actor, target: ssh, force: false, dryRun: false })
    ).rejects.toThrow('another OmniConsole')
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('reports an interrupt that failed after Keep going went off as partial', async () => {
    const d = deps({
      interrupt: vi.fn(async () => {
        throw new Error('terminal_not_writable')
      })
    })
    const failed = stopSession(d, {
      actor,
      target: target({ state: 'working', keepGoing: true }),
      force: false,
      dryRun: false
    })
    await expect(failed).rejects.toBeInstanceOf(SessionManagePartialError)
    await expect(failed).rejects.toThrow('Already done: its Keep going was turned off.')
  })
})
