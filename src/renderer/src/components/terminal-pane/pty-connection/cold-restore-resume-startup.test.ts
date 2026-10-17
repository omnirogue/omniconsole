// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { bindBuildColdRestoreAgentResumeStartup } from './cold-restore-resume-startup'

const PANE = 'tab-1:leaf-1'
const THREAD = { key: 'session_id' as const, id: '01a09aaa-07a7-7233-a118-668a0075b1c0' }
const RECORD = {
  agent: 'codex',
  providerSession: THREAD,
  launchConfig: { agentArgs: '--dangerously-bypass-approvals-and-sandbox', agentEnv: {} },
  paneKey: PANE
}

function makeSession(
  paneStartup: ConnectPanePtySession['paneStartup'],
  record: Record<string, unknown> = RECORD,
  executionHostId: string | null = null
): ConnectPanePtySession {
  const session = {
    pendingStartupCommand: null,
    cacheKey: PANE,
    paneStartup,
    connectionId: null,
    executionHostId,
    projectRuntime: undefined,
    shellOverride: undefined,
    worktree: { path: '/Users/dev/code/omni' },
    getSleepingRecordForPane: () => ({ paneKey: PANE, record }),
    isLegacyWorkerAutomaticResumeBlocked: () => false
  } as unknown as ConnectPanePtySession
  bindBuildColdRestoreAgentResumeStartup(session)
  return session
}

describe('buildColdRestoreAgentResumeStartup', () => {
  beforeEach(() => {
    useAppStore.setState({ agentStatusByPaneKey: {}, settings: {} as never })
  })

  it('rebuilds the resume line from the recorded args when the pane has no explicit startup', () => {
    const startup = makeSession(null).buildColdRestoreAgentResumeStartup()
    expect(startup?.command).toBe(
      `codex '--dangerously-bypass-approvals-and-sandbox' 'resume' '${THREAD.id}'`
    )
    expect(startup?.hasSleepingRecord).toBe(true)
  })

  it('adopts an explicit resume of the same thread verbatim, keeping its flags and token', () => {
    const command = `codex '--dangerously-bypass-approvals-and-sandbox' '-m' 'gpt-6-astra' '-c' 'model_reasoning_effort=high' 'resume' '${THREAD.id}'`
    const startup = makeSession({
      command,
      env: { CODEX_HOME: '/tmp/home/.codex' },
      launchConfig: { agentArgs: '--dangerously-bypass-approvals-and-sandbox', agentEnv: {} },
      resumeProviderSession: THREAD,
      launchToken: 'relaunch-token',
      launchAgent: 'codex',
      startupCommandDelivery: 'shell-ready'
    }).buildColdRestoreAgentResumeStartup()
    expect(startup?.command).toBe(command)
    expect(startup?.launchToken).toBe('relaunch-token')
    expect(startup?.env).toEqual({
      CODEX_HOME: '/tmp/home/.codex',
      ORCA_AGENT_LAUNCH_TOKEN: 'relaunch-token'
    })
    expect(startup?.resumeProviderSession).toEqual(THREAD)
    expect(startup?.hasSleepingRecord).toBe(true)
  })

  it('resumes a local pane under the account home that holds its transcript', () => {
    const home = '/Users/dev/Library/Application Support/omni/claude-accounts/a1/auth/session'
    const providerSession = {
      ...THREAD,
      transcriptPath: `${home}/projects/-w/${THREAD.id}.jsonl`
    }
    const startup = makeSession(
      null,
      {
        agent: 'claude',
        providerSession,
        // What an omni-launch-best pane saved: no account, a bare command.
        launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
        paneKey: PANE
      },
      'local'
    ).buildColdRestoreAgentResumeStartup()
    expect(startup?.command).toBe(
      `CLAUDE_CONFIG_DIR='${home}' command claude '--resume' '${THREAD.id}'`
    )
    expect(startup?.env).toMatchObject({ CLAUDE_CONFIG_DIR: home })
  })

  it('ignores an explicit startup that resumes a different thread', () => {
    const startup = makeSession({
      command: `codex 'resume' 'other-thread'`,
      launchConfig: { agentArgs: '', agentEnv: {} },
      resumeProviderSession: { key: 'session_id', id: 'other-thread' },
      launchAgent: 'codex'
    }).buildColdRestoreAgentResumeStartup()
    expect(startup?.command).toBe(
      `codex '--dangerously-bypass-approvals-and-sandbox' 'resume' '${THREAD.id}'`
    )
  })
})

it('resumes a done pane from its retained provider session when no sleeping record remains', () => {
  useAppStore.setState({
    settings: {} as never,
    agentStatusByPaneKey: {
      [PANE]: {
        paneKey: PANE,
        agentType: 'codex',
        state: 'done',
        providerSession: THREAD
      } as never
    }
  })
  const session = makeSession(null)
  session.getSleepingRecordForPane = () => null
  const startup = session.buildColdRestoreAgentResumeStartup()
  expect(startup?.resumeProviderSession).toEqual(THREAD)
  expect(startup?.command).toContain("'resume'")
})

describe('restore flood guard', () => {
  it('never returns null for a guarded record (a null would connect a bare login shell)', () => {
    // A finished hibernated agent no person opened: the connect gate holds such a pane before it
    // connects; the builder itself must still build the resume the pane will run once opened.
    const session = makeSession(null, {
      ...RECORD,
      origin: 'worktree-sleep',
      state: 'done',
      capturedAt: 1,
      tabId: 'tab-1'
    })
    const startup = session.buildColdRestoreAgentResumeStartup()
    expect(startup?.command).toContain(THREAD.id)
  })

  it('builds even while another live pane runs the same thread (dedupe belongs to the gate)', () => {
    const OTHER = 'tab-2:22222222-2222-4222-8222-222222222222'
    useAppStore.setState({
      settings: {} as never,
      agentStatusByPaneKey: {
        [OTHER]: { paneKey: OTHER, agentType: 'codex', state: 'done', providerSession: THREAD } as never
      },
      tabsByWorktree: { wt: [{ id: 'tab-2', ptyId: 'other-pty' }] } as never,
      ptyIdsByTabId: { 'tab-2': ['other-pty'] }
    })
    expect(makeSession(null).buildColdRestoreAgentResumeStartup()?.command).toContain(THREAD.id)
  })
})
