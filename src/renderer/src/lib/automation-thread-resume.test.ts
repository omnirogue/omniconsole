import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AutomationRun } from '../../../shared/automations-types'
import { findReusableAutomationSession } from './automation-session-reuse'
import { selectAutomationRunProviderSession } from './automation-run-provider-session-observation'
import {
  collectOpenProviderThreadIds,
  confirmAutomationThreadResume,
  decideAutomationThreadResume
} from './automation-thread-resume'

const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = `tab-1:${leafId}`
const CODEX_HOME = '/Users/maintainer/Library/Application Support/omniconsole-ide/codex-accounts/acct/home'
const OTHER_HOME =
  '/Users/maintainer/Library/Application Support/omniconsole-ide/codex-accounts/other/home'
const transcriptPath = `${CODEX_HOME}/sessions/2026/09/19/rollout-2026-09-19T16-30-57-thread-1.jsonl`

function run(overrides: Partial<AutomationRun>): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    title: 'Run 1',
    scheduledFor: 1,
    status: 'completed',
    trigger: 'manual',
    workspaceId: 'wt-1',
    workspaceDisplayName: 'Workspace',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab-1',
    terminalPaneKey: paneKey,
    terminalPtyId: 'pty-1',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 1,
    dispatchedAt: 1,
    createdAt: 1,
    providerSessionId: 'thread-1',
    providerSessionAgent: 'codex',
    providerSessionTranscriptPath: transcriptPath,
    providerSessionHome: CODEX_HOME,
    ...overrides
  }
}

const decide = (
  runs: AutomationRun[],
  overrides: Partial<Parameters<typeof decideAutomationThreadResume>[0]> = {}
) =>
  decideAutomationThreadResume({
    automationId: 'auto-1',
    agentId: 'codex',
    worktreeId: 'wt-1',
    currentRunId: 'run-now',
    runs,
    ...overrides
  })

describe('decideAutomationThreadResume', () => {
  it('leaves a live pane to pane reuse and resumes the recorded thread once it is gone', () => {
    const previous = run({})
    const liveState = {
      agentStatusByPaneKey: {
        [paneKey]: { state: 'done', agentType: 'codex', updatedAt: 1 } as AgentStatusEntry
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: {},
      unifiedTabsByWorktree: { 'wt-1': [{ contentType: 'terminal', entityId: 'tab-1' }] }
    } as unknown as Parameters<typeof findReusableAutomationSession>[0]['state']
    expect(
      findReusableAutomationSession({
        automationId: 'auto-1',
        agentId: 'codex',
        worktreeId: 'wt-1',
        currentRunId: 'run-now',
        runs: [previous],
        state: liveState
      })
    ).toEqual({ tabId: 'tab-1', ptyId: 'pty-1', paneKey })

    // Pane gone (app restart): the same history now yields a thread resume.
    expect(decide([previous])).toEqual({
      kind: 'resume',
      sourceRunId: 'run-1',
      recorded: {
        providerSessionId: 'thread-1',
        providerSessionAgent: 'codex',
        providerSessionTranscriptPath: transcriptPath,
        providerSessionHome: CODEX_HOME
      },
      providerSession: { key: 'session_id', id: 'thread-1', transcriptPath }
    })
  })

  it('picks the newest completed run of this automation in this workspace', () => {
    const decision = decide([
      run({ id: 'old', createdAt: 1, providerSessionId: 'thread-old' }),
      run({ id: 'newest', createdAt: 3, providerSessionId: 'thread-new' }),
      run({ id: 'elsewhere', createdAt: 9, workspaceId: 'wt-2', providerSessionId: 'thread-x' }),
      run({ id: 'other-automation', createdAt: 9, automationId: 'auto-2' }),
      run({ id: 'run-now', createdAt: 10, providerSessionId: 'thread-self' }),
      run({ id: 'unfinished', createdAt: 8, status: 'dispatched', providerSessionId: 't-d' })
    ])
    expect(decision?.kind).toBe('resume')
    expect(decision && decision.kind === 'resume' && decision.sourceRunId).toBe('newest')
  })

  it('starts fresh with no recorded thread, a thread from another agent, or a non-resumable agent', () => {
    expect(
      decide([run({ providerSessionId: undefined, providerSessionAgent: undefined })])
    ).toBeNull()
    expect(decide([run({ providerSessionAgent: 'claude' })])).toBeNull()
    expect(decide([run({})], { agentId: 'gemini' })).toBeNull()
    expect(decide([run({ providerSessionId: '--flag' })])).toBeNull()
  })

  it('never resumes a thread recorded under another account home, and records why', () => {
    expect(decide([run({})], { expectedHome: OTHER_HOME })).toEqual({
      kind: 'fresh',
      requested: 'thread-1',
      reason: 'The recorded thread belongs to a different account home.'
    })
    expect(decide([run({})], { expectedHome: `${CODEX_HOME}/` })?.kind).toBe('resume')
    expect(decide([run({})], { localWorkspace: false })?.kind).toBe('fresh')
  })

  it('starts fresh while the recorded thread is still open in a live pane (2026-09-20 lock)', () => {
    // The Advertising routine's run 7 pane was not reusable (its status was not `done`),
    // so the apply run resumed the same thread in a new tab and Codex refused with
    // "This conversation is open in another app · R to Retry"; the pauses never ran.
    const open = collectOpenProviderThreadIds({
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'thread-1' }
        } as AgentStatusEntry,
        'tab-gone:leaf': {
          state: 'done',
          providerSession: { key: 'session_id', id: 'thread-closed' }
        } as AgentStatusEntry
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-gone': [] }
    })
    expect([...open]).toEqual(['thread-1'])
    expect(decide([run({})], { openThreadIds: open })).toEqual({
      kind: 'fresh',
      requested: 'thread-1',
      reason: 'The recorded thread is still open in another pane; Codex would refuse to resume it.'
    })
    expect(decide([run({})], { openThreadIds: new Set(['thread-closed']) })?.kind).toBe('resume')
    // Claude would have taken the prompt in an idle pane (findReusableAutomationSession);
    // a thread still open here is in a busy or taken-over pane, and the reason says so.
    expect(
      decide([run({ providerSessionAgent: 'claude' })], { agentId: 'claude', openThreadIds: open })
    ).toEqual({
      kind: 'fresh',
      requested: 'thread-1',
      reason:
        'The recorded thread is open in a pane that is busy or taken over; the routine starts its own session.'
    })
  })
})

describe('confirmAutomationThreadResume', () => {
  it('keeps a resume the hook confirmed and demotes one that opened another thread', () => {
    const requested = { requested: 'thread-1', outcome: 'resumed' as const }
    expect(confirmAutomationThreadResume(requested, { id: 'thread-1' })).toBe(requested)
    expect(confirmAutomationThreadResume(requested, undefined)).toBe(requested)
    expect(confirmAutomationThreadResume(requested, { id: 'thread-9' })).toEqual({
      requested: 'thread-1',
      outcome: 'fresh',
      reason: 'The agent opened thread thread-9 instead of the requested one.'
    })
    const failed = { requested: 'thread-1', outcome: 'failed' as const, reason: 'boom' }
    expect(confirmAutomationThreadResume(failed, { id: 'thread-9' })).toBe(failed)
  })
})

describe('selectAutomationRunProviderSession', () => {
  it('shapes the hook-reported thread for the run and derives the account home', () => {
    expect(
      selectAutomationRunProviderSession(
        {
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'thread-1', transcriptPath }
        },
        'codex'
      )
    ).toEqual({
      providerSessionId: 'thread-1',
      providerSessionAgent: 'codex',
      providerSessionTranscriptPath: transcriptPath,
      providerSessionHome: CODEX_HOME
    })
    const claudePath = '/Users/maintainer/.claude/projects/-Users-sal-repo/abc.jsonl'
    expect(
      selectAutomationRunProviderSession(
        {
          agentType: 'claude',
          providerSession: { key: 'session_id', id: 'abc', transcriptPath: claudePath }
        },
        'claude'
      )
    ).toMatchObject({ providerSessionHome: '/Users/maintainer/.claude' })
  })

  it('ignores a pane running another agent, a non-resumable agent, or no hook identity', () => {
    const providerSession = { key: 'session_id' as const, id: 'thread-1' }
    expect(
      selectAutomationRunProviderSession({ agentType: 'claude', providerSession }, 'codex')
    ).toBeNull()
    expect(
      selectAutomationRunProviderSession({ agentType: 'gemini', providerSession }, 'gemini')
    ).toBeNull()
    expect(selectAutomationRunProviderSession({ agentType: 'codex' }, 'codex')).toBeNull()
    expect(selectAutomationRunProviderSession(undefined, 'codex')).toBeNull()
    expect(
      selectAutomationRunProviderSession({ agentType: 'unknown', providerSession }, 'codex')
    ).toMatchObject({ providerSessionId: 'thread-1' })
  })
})
