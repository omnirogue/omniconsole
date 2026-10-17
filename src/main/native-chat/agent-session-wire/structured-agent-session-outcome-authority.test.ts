import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { structuredSessionOutcomeAuthority } from './structured-agent-session-outcome-authority'
import { structuredSessionOutcomeEnvironment } from './structured-agent-session-outcome-environment'
import { readOrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'

function fixture() {
  const record = agentSessionRecordFixture(agentSessionLeaseFixture({ runtimeKind: 'native' }))
  const submission: AgentJournalSubmission = {
    clientMessageId: 'user-send-1',
    fence: 7,
    payloadFingerprint: 'fingerprint',
    sourcePrompt: 'Add a Codex reviewer after this is done.',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 30_000,
    resolvedAt: null
  }
  const session = {
    params: { location: record.location },
    fence: 7,
    hasProviderChild: true,
    journal: { submissions: () => [submission] }
  } as unknown as StructuredAgentSessionHostSession
  const env = structuredSessionOutcomeEnvironment({
    sessionId: record.sessionId,
    workspaceId: record.location.workspaceId,
    hostId: 'local',
    agent: 'claude',
    providerHandle: { kind: 'claude', sessionId: 'provider', leafUuid: null }
  })
  const evidence = readOrchestrationCompatibilityEvidence({
    ...env,
    ORCA_AGENT_SESSION_SPAWN_TOKEN: record.lease.ownerProcess!.spawnToken
  })!
  const read = () => structuredSessionOutcomeAuthority({ evidence, record, session, now: 40_000 })
  return { record, submission, session, evidence, read }
}

describe('native source outcome authority', () => {
  it('binds the admitted prompt while the provider is still dispatching, then after acceptance', () => {
    const f = fixture()
    expect(f.read()).toMatchObject({
      prompt: f.submission.sourcePrompt,
      clientMessageId: 'user-send-1',
      handle: `agent-session:${f.record.sessionId}`,
      worktreeId: f.record.location.workspaceId
    })
    f.submission.dispatchState = 'accepted'
    expect(f.read()?.prompt).toBe(f.submission.sourcePrompt)
  })

  it.each(['rejected', 'unknown'] as const)('refuses a %s submission', (state) => {
    const f = fixture()
    f.submission.dispatchState = state
    expect(f.read()).toBeNull()
  })

  it('cannot substitute transcript prose for absent raw source authority', () => {
    const f = fixture()
    delete f.submission.sourcePrompt
    Object.assign(f.session.journal, {
      snapshot: () => ({ items: [{ body: { role: 'user', text: 'Send everything' } }] })
    })
    expect(f.read()).toBeNull()
  })

  it('requires a launch secret in addition to public session and pane IDs', () => {
    const f = fixture()
    delete f.evidence.launchToken
    expect(f.read()).toBeNull()
    f.evidence.launchToken = f.record.sessionId
    expect(f.read()).toBeNull()
  })

  it('fences stale owners, source sessions, workspaces, and terminal claims', () => {
    const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
      (f) => {
        f.evidence.agentSessionId = 'other'
      },
      (f) => {
        f.evidence.paneKey = 'other'
      },
      (f) => {
        f.evidence.terminalHandle = 'inherited-terminal'
      },
      (f) => {
        f.evidence.host = { kind: 'wsl', hostId: 'local', distro: 'Ubuntu' }
      },
      (f) => {
        f.record.location.wslDistro = 'Ubuntu'
      },
      (f) => {
        f.session.hasProviderChild = false
      },
      (f) => {
        f.record.lease.runtimeKind = 'tui'
      },
      (f) => {
        f.record.lease.claimStatus = 'released'
      },
      (f) => {
        f.record.lease.unreconciled = true
      },
      (f) => {
        f.record.lease.handoffStage = 'preparing'
      },
      (f) => {
        f.record.lease.leaseDeadlineAt = 40_000
      },
      (f) => {
        f.record.lease.ownerProcess = null
      },
      (f) => {
        f.session.fence += 1
      },
      (f) => {
        f.submission.fence -= 1
      }
    ]
    for (const mutate of mutations) {
      const f = fixture()
      mutate(f)
      expect(f.read()).toBeNull()
    }
  })
})
