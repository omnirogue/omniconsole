// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import { createTestStore, makeTab, seedStore } from '@/store/slices/store-test-helpers'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { dropAgentResumeArgvFromCommand } from '../../../../shared/agent-resume-argv-drop'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import { buildCodexResumeRelaunchStartup } from './codex-resume-relaunch-plan'
import {
  beginCodexResumeRelaunch,
  resetCodexResumeRelaunchForTests
} from './codex-resume-relaunch-state'

const PANE = 'tab-1:leaf-1'
const PTY = 'wt1@@pty-1'
const NOW = 1_000_000
const THREAD = { key: 'session_id' as const, id: 'thread-1' }

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'hi',
    updatedAt: NOW - 1000,
    stateStartedAt: NOW - 1000,
    paneKey: PANE,
    agentType: 'codex',
    stateHistory: [],
    providerSession: THREAD,
    ...overrides
  }
}

function sleeping(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: PANE,
    worktreeId: 'wt1',
    agent: 'codex',
    providerSession: THREAD,
    prompt: 'hi',
    state: 'done',
    capturedAt: NOW - 5000,
    updatedAt: NOW - 5000,
    ...overrides
  }
}

function makeStore(state: Parameters<typeof seedStore>[1] = {}) {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [{ id: 'wt1', path: '/Users/dev/code/omni' }] } as never,
    tabsByWorktree: { wt1: [makeTab({ id: 'tab-1', worktreeId: 'wt1', ptyId: PTY })] },
    ptyIdsByTabId: { 'tab-1': [PTY] },
    settings: {} as never,
    ...state
  })
  return store
}

function build(
  store: ReturnType<typeof makeStore>,
  overrides: Partial<Parameters<typeof buildCodexResumeRelaunchStartup>[0]> = {}
) {
  return buildCodexResumeRelaunchStartup({
    state: store.getState(),
    paneKey: PANE,
    terminalTabId: 'tab-1',
    ptyId: PTY,
    isWorking: false,
    requested: { model: 'gpt-5.5', effort: 'high' },
    now: NOW,
    ...overrides
  })
}

function refusalCode(result: ReturnType<typeof build>): string | null {
  return result.ok ? null : result.refusal.code
}

describe('buildCodexResumeRelaunchStartup refusals', () => {
  beforeEach(() => resetCodexResumeRelaunchForTests())

  it('refuses without a live pty', () => {
    expect(refusalCode(build(makeStore(), { ptyId: null }))).toBe('no-pty')
  })

  it('refuses remote panes by pty id and by worktree host', () => {
    const store = makeStore({ agentStatusByPaneKey: { [PANE]: entry() } })
    expect(refusalCode(build(store, { ptyId: 'remote:env-1@@terminal-1' }))).toBe('remote')
    const sshStore = makeStore({
      worktreesByRepo: {
        repo1: [{ id: 'wt1', path: '/srv/omni', hostId: 'ssh:box-1' }]
      } as never,
      agentStatusByPaneKey: { [PANE]: entry() }
    })
    expect(refusalCode(build(sshStore))).toBe('remote')
  })

  it('refuses while a relaunch is already in flight', () => {
    beginCodexResumeRelaunch(PANE, {
      phase: 'restarting',
      requested: { model: 'gpt-5.5' },
      selectedOption: 'model',
      threadId: 'thread-1',
      previousPtyId: PTY,
      startedAt: NOW
    })
    expect(refusalCode(build(makeStore({ agentStatusByPaneKey: { [PANE]: entry() } })))).toBe(
      'in-flight'
    )
  })

  it('refuses while an account restart is pending or its notice still blocks input', () => {
    const queued = makeStore({
      agentStatusByPaneKey: { [PANE]: entry() },
      pendingCodexPaneRestartIds: { [PTY]: true }
    })
    expect(refusalCode(build(queued))).toBe('account-restart-pending')
    const noticed = makeStore({ agentStatusByPaneKey: { [PANE]: entry() } })
    noticed
      .getState()
      .markCodexRestartNotices([
        { ptyId: PTY, previousAccountLabel: 'a@x', nextAccountLabel: 'b@x' }
      ])
    expect(refusalCode(build(noticed))).toBe('account-restart-pending')
  })

  it('refuses when neither the live row nor a sleeping record names a thread', () => {
    expect(refusalCode(build(makeStore()))).toBe('no-thread')
    expect(
      refusalCode(
        build(
          makeStore({ agentStatusByPaneKey: { [PANE]: entry({ providerSession: undefined }) } })
        )
      )
    ).toBe('no-thread')
  })

  it('refuses while Codex is working, from either the prop or a fresh non-done row', () => {
    expect(
      refusalCode(
        build(makeStore({ agentStatusByPaneKey: { [PANE]: entry() } }), { isWorking: true })
      )
    ).toBe('working')
    expect(
      refusalCode(
        build(
          makeStore({
            agentStatusByPaneKey: { [PANE]: entry({ state: 'working', updatedAt: NOW }) }
          })
        )
      )
    ).toBe('working')
  })

  it('does not treat unconfirmed, stale, or done rows as working', () => {
    for (const row of [
      entry({ state: 'working', updatedAt: NOW, restoredUnconfirmed: true }),
      entry({ state: 'working', updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1 }),
      entry({ state: 'done', updatedAt: NOW })
    ]) {
      expect(build(makeStore({ agentStatusByPaneKey: { [PANE]: row } })).ok).toBe(true)
    }
  })

  it('refuses any fresh working row after a relaunch — Codex sends no SessionStart on resume, so it is a real turn', () => {
    beginCodexResumeRelaunch(PANE, {
      phase: 'confirmed',
      requested: { model: 'gpt-5.5' },
      selectedOption: 'model',
      threadId: 'thread-1',
      previousPtyId: PTY,
      startedAt: NOW - 3000
    })
    for (const row of [
      entry({ state: 'working', updatedAt: NOW - 2000, stateStartedAt: NOW - 2000 }),
      entry({ state: 'working', updatedAt: NOW, stateStartedAt: NOW }),
      entry({ state: 'waiting', updatedAt: NOW - 500, stateStartedAt: NOW - 500 })
    ]) {
      expect(refusalCode(build(makeStore({ agentStatusByPaneKey: { [PANE]: row } })))).toBe(
        'working'
      )
    }
    const done = entry({ state: 'done', updatedAt: NOW - 100, stateStartedAt: NOW - 100 })
    expect(build(makeStore({ agentStatusByPaneKey: { [PANE]: done } })).ok).toBe(true)
  })

  it('refuses an effort the model does not support', () => {
    const result = build(makeStore({ agentStatusByPaneKey: { [PANE]: entry() } }), {
      requested: { model: 'gpt-5.5', effort: 'ultra' }
    })
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'unsupported-effort', model: 'gpt-5.5', effort: 'ultra' }
    })
  })

  it('surfaces the command-override conflict when the plan cannot be built', () => {
    const result = build(
      makeStore({
        agentStatusByPaneKey: { [PANE]: entry() },
        settings: { agentCmdOverrides: { codex: 'codex -m x' } } as never
      })
    )
    expect(result).toMatchObject({ ok: false, refusal: { code: 'plan-failed' } })
    if (result.ok) {
      throw new Error('expected a refusal')
    }
    expect(result.refusal).toMatchObject({ detail: expect.stringContaining('conflicts') })
  })
})

describe('buildCodexResumeRelaunchStartup happy path', () => {
  beforeEach(() => resetCodexResumeRelaunchForTests())

  it('resumes the thread with the model and effort flags before `resume`', () => {
    const result = build(makeStore({ agentStatusByPaneKey: { [PANE]: entry() } }))
    if (!result.ok) {
      throw new Error(`refused: ${result.refusal.code}`)
    }
    const reference = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: THREAD,
      cmdOverrides: {},
      agentArgs: resolveTuiAgentLaunchArgs('codex', undefined),
      agentEnv: resolveTuiAgentLaunchEnv('codex', undefined),
      platform: 'linux',
      sessionOptions: { model: 'gpt-5.5', effort: 'high' },
      sessionOptionsOverrideAgentArgs: true
    })!
    expect(result.startup.command).toBe(reference.launchCommand)
    expect(result.startup.command).toContain(
      "'-m' 'gpt-5.5' '-c' 'model_reasoning_effort=high' 'resume' 'thread-1'"
    )
    expect(result.startup).toMatchObject({
      launchAgent: 'codex',
      startupCommandDelivery: 'shell-ready',
      resumeProviderSession: THREAD,
      sessionOptions: { model: 'gpt-5.5', effort: 'high' }
    })
    expect(result.startup.launchToken).toEqual(expect.any(String))
    expect(result.startup.launchConfig?.agentCommand).not.toMatch(/-m|-c/)
    expect(
      dropAgentResumeArgvFromCommand({
        command: result.startup.command,
        agent: 'codex',
        providerSession: THREAD
      })
    ).toMatchObject({ status: 'dropped' })
  })

  it('replays the sleeping launch config, replacing its effort flag and keeping the rest', () => {
    const result = build(
      makeStore({
        sleepingAgentSessionsByPaneKey: {
          [PANE]: sleeping({
            launchConfig: {
              agentArgs: '--dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort=low',
              agentEnv: { CODEX_FLAG: '1' }
            }
          })
        }
      })
    )
    if (!result.ok) {
      throw new Error(`refused: ${result.refusal.code}`)
    }
    expect(result.startup.command).not.toContain('model_reasoning_effort=low')
    expect(result.startup.command).toMatch(
      /'--dangerously-bypass-approvals-and-sandbox'.*'resume' 'thread-1'$/
    )
    expect(result.startup.command).toContain("'-c' 'model_reasoning_effort=high'")
    expect(result.startup.env).toEqual({ CODEX_FLAG: '1' })
  })

  it('drops a recorded effort override the requested model cannot take when no effort is sent', () => {
    const result = build(
      makeStore({
        sleepingAgentSessionsByPaneKey: {
          [PANE]: sleeping({
            launchConfig: {
              agentArgs:
                '--dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort=ultra',
              agentEnv: { CODEX_FLAG: '1' }
            }
          })
        }
      }),
      { requested: { model: 'gpt-5.5' } }
    )
    if (!result.ok) {
      throw new Error(`refused: ${result.refusal.code}`)
    }
    expect(result.startup.command).toContain("'-m' 'gpt-5.5'")
    expect(result.startup.command).toContain("'--dangerously-bypass-approvals-and-sandbox'")
    expect(result.startup.command).not.toContain('model_reasoning_effort')
    expect(result.startup.command).toMatch(/'resume' 'thread-1'$/)
    expect(result.startup.launchConfig?.agentArgs).not.toContain('model_reasoning_effort')
    expect(result.startup.env).toEqual({ CODEX_FLAG: '1' })
  })

  it('sends no effort flag when none is requested', () => {
    const result = build(makeStore({ agentStatusByPaneKey: { [PANE]: entry() } }), {
      requested: { model: 'gpt-5.5' }
    })
    if (!result.ok) {
      throw new Error(`refused: ${result.refusal.code}`)
    }
    expect(result.startup.command).toContain("'-m' 'gpt-5.5'")
    expect(result.startup.command).not.toContain("'-c'")
  })
})
