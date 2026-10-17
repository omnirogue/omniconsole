import { describe, expect, it, vi } from 'vitest'
import type { AskWaitResult } from './session-manage-ask-wait'
import { consolidateSessions } from './session-manage-consolidate'
import { handoffSession } from './session-manage-handoff'
import { SessionManagePartialError, SessionManageRefusal } from './session-manage-refusal'
import type { SessionTransferInput, TransferSession } from './session-manage-transfer-contract'
import { transferFixture, transferSession } from './session-manage-transfer-fixtures'
import { HOST_MOVE_PAIRED_RUNTIME_REFUSAL } from './session-transfer-host'
import type {
  HostMovePlan,
  SessionTransferHostDeps,
  TransferSourceWork
} from './session-transfer-host-contract'

const HOST = 'ssh:mw0002' as const
const actor = { kind: 'pane' as const, paneKey: 'actor', title: 'Coordinator' }
const source = transferSession('source')
const pushed: TransferSourceWork = {
  kind: 'git',
  path: '/w',
  branch: 'feat/parser',
  head: 'abc123',
  upstream: { name: 'origin/feat/parser', ahead: 0 },
  uncommitted: 0
}
const unpushed: TransferSourceWork = {
  ...pushed,
  upstream: { name: 'origin/feat/parser', ahead: 2 },
  uncommitted: 1
}
const workspace = {
  id: 'host-repo::/work/parser',
  path: '/work/parser',
  branch: 'feat/parser',
  name: 'parser'
}
const input: SessionTransferInput = {
  actor,
  sources: [source],
  target: 'new',
  dryRun: false,
  note: 'Start with the parser.',
  host: { hostId: HOST }
}

function remote(title: string, overrides: Partial<TransferSession['entry']> = {}): TransferSession {
  const session = transferSession('remote', {
    title,
    worktreeId: workspace.id,
    terminal: 'term_remote',
    hostId: HOST,
    ...overrides
  })
  return { ...session, row: { ...session.row, hostId: HOST } }
}

function fixture(works: TransferSourceWork[] = [pushed]) {
  const base = transferFixture()
  const plan: HostMovePlan = { hostId: HOST, label: 'mw0002', workspace, works }
  const acceptance = (reply = 'Accepted transfer fixture'): Promise<AskWaitResult> =>
    Promise.resolve({ outcome: 'answered', reply })
  const host = {
    plan: vi.fn<SessionTransferHostDeps['plan']>(async () => plan),
    readWork: vi.fn<SessionTransferHostDeps['readWork']>(async () => {
      base.events.push('readWork')
      return pushed
    }),
    launch: vi.fn<SessionTransferHostDeps['launch']>(async (_plan, _source, title, prompt) => {
      base.events.push('launch')
      return {
        target: remote(title),
        pending: { sent: prompt, acknowledgement: 'Accepted transfer fixture', wait: acceptance() }
      }
    }),
    reachable: vi.fn(() => true),
    label: vi.fn(() => 'mw0002')
  } satisfies SessionTransferHostDeps
  return { ...base, plan, host, deps: { ...base.deps, host } }
}

describe('moving a session to another computer by handoff', () => {
  it('dry run lists the exact steps and asks, starts and archives nothing', async () => {
    const { deps, host } = fixture([unpushed])
    const result = await handoffSession(deps, { ...input, dryRun: true })
    expect(result.outcome).toBe('planned')
    expect(result.steps).toEqual([
      'Ask “source” to commit and push branch feat/parser (1 uncommitted file, 2 commits are not on origin/feat/parser), then check git again; refuse if anything is still unpushed.',
      'Ask “source” for a handoff brief.',
      'Start claude on mw0002 (ssh:mw0002) in /work/parser as “source (continued)”, its first prompt the brief, the branch and the acceptance line; file it in unfiled.',
      'Wait for its finished reply to be exactly that acceptance line (it confirms it has the work first).',
      'Only then archive every source here (never delete), naming the new session on mw0002. Asking a source turned its Keep going off.'
    ])
    expect(result.summary).toBe(
      'Would handoff “source” into a new session on mw0002 in /work/parser. Nothing changed.'
    )
    for (const dependency of [deps.ask, deps.archive, deps.audit, deps.file, host.launch]) {
      expect(dependency).not.toHaveBeenCalled()
    }
  })

  it('asks unpushed work to be pushed, re-reads git, and refuses with the push command', async () => {
    const { deps, host } = fixture([unpushed])
    host.readWork.mockResolvedValueOnce(unpushed)
    const result = await handoffSession(deps, input)
    expect(result).toMatchObject({ outcome: 'failed', failedStep: 'push source work' })
    expect(result.failure).toContain('still has unpushed work')
    expect(result.failure).toContain('run git push -u origin feat/parser')
    expect(deps.ask).toHaveBeenCalledOnce()
    expect(deps.ask.mock.calls[0][1]).toContain('push branch feat/parser to its remote')
    expect(host.launch).not.toHaveBeenCalled()
    expect(deps.archive).not.toHaveBeenCalled()
    expect(deps.audit.mock.calls.map(([record]) => record.action)).toEqual(['ask', 'handoff'])
  })

  it('continues once the source pushed: push question, fresh read, brief, then launch', async () => {
    const { deps, events } = fixture([unpushed])
    const result = await handoffSession(deps, input)
    expect(result.outcome).toBe('completed')
    const steps = events.filter((event) => !event.startsWith('audit:'))
    expect(steps.slice(0, 5)).toEqual(['ask', 'readWork', 'ask', 'readWork', 'launch'])
  })

  it('archives the source only after the new session there accepts, naming each other', async () => {
    const { deps, events, host } = fixture()
    const result = await handoffSession(deps, input)
    expect(result).toMatchObject({
      outcome: 'completed',
      archived: [{ paneKey: 'source' }],
      target: { paneKey: 'remote', title: 'source (continued)' },
      host: {
        hostId: HOST,
        label: 'mw0002',
        workspace: { id: workspace.id, path: '/work/parser', branch: 'feat/parser' },
        branches: [
          { title: 'source', branch: 'feat/parser', upstream: 'origin/feat/parser', head: 'abc123' }
        ],
        verdict: 'live'
      }
    })
    const prompt = host.launch.mock.calls[0][3]
    expect(prompt).toContain('You are taking over this work from session “source”')
    expect(prompt).toContain('Start with the parser.')
    expect(prompt).toContain('branch feat/parser, which is on origin/feat/parser at commit abc123')
    expect(prompt).toContain('you run on mw0002 (ssh:mw0002) in /work/parser')
    expect(events.indexOf('audit:session.acknowledge')).toBeLessThan(events.indexOf('archive'))
    expect(deps.archive).toHaveBeenCalledWith(
      [source],
      'handed off to source (continued) on mw0002',
      expect.any(Function),
      expect.objectContaining({ row: expect.objectContaining({ hostId: HOST }) })
    )
    const audits = deps.audit.mock.calls.map(([record]) => record)
    expect(audits.map((record) => record.action)).toEqual([
      'ask',
      'session.create',
      'session.move',
      'session.acknowledge',
      'session.archive',
      'handoff'
    ])
    expect(audits[1]).toMatchObject({
      target: { entry: { paneKey: 'remote' } },
      summary:
        'Started “source (continued)” on mw0002 in /work/parser with the handoff brief of “source”.',
      after: { host: HOST, workspace: workspace.id }
    })
    expect(audits[4]).toMatchObject({
      target: { entry: { paneKey: 'source' } },
      summary: 'Archived “source”: handed off to source (continued) on mw0002.'
    })
  })

  it('reports an unreachable host as unverifiable and leaves the source untouched', async () => {
    const { deps, host } = fixture()
    host.plan.mockRejectedValueOnce(
      new SessionManageRefusal('mw0002 (ssh:mw0002) is not connected (unverifiable).')
    )
    host.reachable.mockReturnValue(false)
    const result = await handoffSession(deps, input)
    expect(result).toMatchObject({
      outcome: 'failed',
      failedStep: 'validate',
      briefSent: false,
      host: { hostId: HOST, label: 'mw0002', verdict: 'unverifiable' }
    })
    expect(result.summary).toContain("the new session's state there is unverifiable")
    for (const dependency of [deps.ask, deps.archive, deps.audit, host.launch]) {
      expect(dependency).not.toHaveBeenCalled()
    }
  })

  it('never reports a move whose acceptance was lost with the host', async () => {
    const { deps, host } = fixture()
    host.launch.mockImplementationOnce(async (_plan, _source, title, prompt) => {
      host.reachable.mockReturnValue(false)
      return {
        target: remote(title),
        pending: {
          sent: prompt,
          acknowledgement: 'Accepted transfer fixture',
          wait: Promise.resolve({ outcome: 'timeout', question: 'delivered' })
        }
      }
    })
    const result = await handoffSession(deps, input)
    expect(result).toMatchObject({
      outcome: 'failed',
      failedStep: 'acknowledgement',
      briefSent: true,
      archived: [],
      host: { verdict: 'unverifiable' }
    })
    expect(result.summary).toContain('it may still be running')
    expect(deps.archive).not.toHaveBeenCalled()
  })

  it('archives nothing when the new session is unverifiable after accepting', async () => {
    const { deps } = fixture()
    deps.refresh.mockImplementation(async (session) =>
      session.entry.paneKey === 'remote'
        ? { ...session, entry: { ...session.entry, verdict: 'unverifiable' as const } }
        : session
    )
    const result = await handoffSession(deps, input)
    expect(result).toMatchObject({ outcome: 'failed', failedStep: 'archive sources' })
    expect(result.failure).toContain('is unverifiable')
    expect(deps.archive).not.toHaveBeenCalled()
  })

  it('refuses a remote source through the existing locality rule before planning', async () => {
    const { deps, host } = fixture()
    const remoteSource = transferSession('source', { hostId: 'ssh:other' })
    const result = await handoffSession(deps, { ...input, sources: [remoteSource] })
    expect(result).toMatchObject({ outcome: 'failed', failedStep: 'validate' })
    expect(result.failure).toContain('runs on the SSH host other, not on this computer')
    expect(host.plan).not.toHaveBeenCalled()
  })

  it('refuses a paired OmniConsole host and a named target without reading anything', async () => {
    const { deps, host } = fixture()
    const paired = await handoffSession(deps, { ...input, host: { hostId: 'runtime:env-1' } })
    expect(paired.failure).toBe(HOST_MOVE_PAIRED_RUNTIME_REFUSAL)
    const named = await handoffSession(deps, { ...input, target: transferSession('target') })
    expect(named.failure).toContain('--host starts a new session on that computer')
    expect(host.plan).not.toHaveBeenCalled()
  })

  it('refuses a brief that trips a hard stop before anything starts there', async () => {
    const { deps, host } = fixture()
    deps.ask.mockResolvedValueOnce({
      sent: 'question',
      wait: Promise.resolve({ outcome: 'answered', reply: 'Next: deploy it to production.' })
    })
    const result = await handoffSession(deps, input)
    expect(result).toMatchObject({ outcome: 'failed', failedStep: 'launch on host' })
    expect(result.failure).toContain('hard stop: deploy')
    expect(host.launch).not.toHaveBeenCalled()
  })

  it('audits a launch whose outcome is unknown as partly applied and archives nothing', async () => {
    const { deps, host } = fixture()
    host.launch.mockRejectedValueOnce(
      new SessionManagePartialError('relay dropped', 'launch op-1 may have started a session')
    )
    const result = await handoffSession(deps, input)
    expect(result).toMatchObject({ outcome: 'failed', failedStep: 'launch on host' })
    expect(deps.audit.mock.calls.map(([record]) => record)).toContainEqual(
      expect.objectContaining({
        action: 'session.create',
        summary: expect.stringContaining('Partly applied')
      })
    )
    expect(deps.archive).not.toHaveBeenCalled()
  })

  it('consolidates into one new session there, listing every source branch', async () => {
    const lexer: TransferSourceWork = {
      ...pushed,
      branch: 'feat/lexer',
      head: 'def456',
      upstream: { name: 'origin/feat/lexer', ahead: 0 }
    }
    const { deps, host } = fixture([pushed, lexer])
    host.readWork.mockImplementation(async (session) =>
      session.entry.paneKey === 'b' ? lexer : pushed
    )
    const sources = [transferSession('a'), transferSession('b')]
    const result = await consolidateSessions(deps, { ...input, sources, note: undefined })
    expect(result).toMatchObject({
      outcome: 'completed',
      archived: [{ paneKey: 'a' }, { paneKey: 'b' }]
    })
    const prompt = host.launch.mock.calls[0][3]
    expect(prompt).toContain('“a” worked on branch feat/parser, which is on origin/feat/parser')
    expect(prompt).toContain('“b” worked on branch feat/lexer, which is on origin/feat/lexer')
    expect(prompt).toContain('make sure this workspace is on branch feat/parser with commit abc123')
  })
})
