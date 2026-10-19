import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactWriteRequest } from '../../shared/artifacts'
import type { TerminalProcessTree } from '../../shared/pty-agent-process-evidence'
import { consolePublicationPrincipal } from '../backoffice/console-workflow-person'
import { setActiveLedgerPaneRegistry } from '../session-ledger/ledger-lookup'
import { CLAUDE, ROWS, SELF, row } from './artifact-caller-ancestry-test-fixture'
import { artifactSessionOriginOf, artifactUpdateOriginOf } from './artifact-session-origin'
import { artifactSourceReview } from './artifact-source-review-origin'
import { artifactSourceSessionRef } from './artifact-source-session'
import {
  withSessionBindingNotice,
  withVerifiedArtifactOrigin,
  type ArtifactOriginCallerDeps
} from './artifact-origin-caller'

const PANE = 'tab-a:11111111-1111-4111-8111-111111111111'
const request: ArtifactWriteRequest = {
  sourceKey: '/repo/plan.html',
  content: '<h1>Plan</h1>',
  contentType: 'text/html',
  fileName: 'plan.html',
  origin: { terminalHandle: 'term-1', paneKey: PANE, worktreeId: 'wt-env' }
}
const PROOF = {
  ...CLAUDE,
  ptyId: 'pty-1',
  incarnationId: null,
  rootPid: 100,
  pgid: 200,
  startTimeMs: 1,
  via: 'hook-report' as const
}

type RuntimeOptions = {
  evidence?: 'none' | TerminalProcessTree['kind']
  connectionId?: string | null
  paneSession?: string
  handle?: string | null
  agentReplaced?: boolean
  /** The pid on the pane's newest hook row: its agent reported since this app started. */
  reportedPid?: number
  noListing?: boolean
}

function runtime(options: RuntimeOptions = {}) {
  return {
    getTerminalPaneKey: vi.fn(() => PANE),
    getTerminalWorktreeIdForPaneKey: vi.fn(() => 'wt-1'),
    getTerminalHandleForPaneKey: vi.fn(() =>
      options.handle === undefined ? 'term-1' : options.handle
    ),
    resolveTerminalContext: vi.fn(() => ({
      worktreeId: 'wt-1',
      connectionId: options.connectionId ?? null
    })),
    readTerminalProcessEvidence: vi.fn(async () =>
      options.evidence === 'none'
        ? null
        : {
            proof: options.evidence ? null : PROOF,
            tree: { kind: options.evidence ?? ('other' as const) }
          }
    ),
    assertTerminalAgentProcess: vi.fn(async () => {
      if (options.agentReplaced) {
        throw new Error('The agent it was queued for no longer holds its terminal.')
      }
    }),
    getReportedProviderSessionsForPane: vi.fn(() =>
      options.paneSession ? [{ key: 'session_id' as const, id: options.paneSession }] : []
    ),
    getPtyIdForPaneKey: vi.fn(() => 'pty-1'),
    localPtyRootProcessIds: vi.fn(async () =>
      options.noListing ? new Map<string, number>() : new Map([['pty-1', 100]])
    ),
    getLastAgentHookRowForPane: vi.fn(() =>
      options.reportedPid ? ({ agentPid: options.reportedPid } as never) : null
    )
  }
}

// The agent exited; the pane's shell (100) now runs a dev server (150) or a stopped editor.
const NO_AGENT_ROWS = [
  ...ROWS.filter((r) => r.pid !== 200 && r.pid !== 210 && r.pid !== 700 && r.pid !== 1000),
  row(150, 100, 'npm run dev'),
  row(160, 150, 'node node_modules/.bin/vite')
]
// An agent whose binary OmniConsole does not recognise (170) runs in front instead.
const UNKNOWN_AGENT_ROWS = [
  ...NO_AGENT_ROWS.filter((r) => r.pid < 150),
  row(170, 100, 'mystery-agent')
]

const posix: ArtifactOriginCallerDeps = {
  platform: 'darwin',
  readProcessRows: async () => ROWS,
  selfExecutable: SELF,
  hookPidForPane: () => undefined
}
const BOUND = { paneKey: PANE, worktreeId: 'wt-1' }
const verify = (callerPid: number | undefined, options: RuntimeOptions = {}, deps = posix) =>
  withVerifiedArtifactOrigin(runtime(options), request, callerPid, deps)

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('withVerifiedArtifactOrigin', () => {
  it("keeps the pane for the agent's own descendants, Python scripts included (A2)", async () => {
    for (const callerPid of [220, 250, 270, 290]) {
      const verified = await verify(callerPid)
      expect(verified.origin).toEqual(BOUND)
      expect(verified).not.toHaveProperty('unboundReason')
    }
  })

  it.each([
    ['a pane child outside its agent (A1)', 410],
    ['an app launched from the pane shell (A1)', 330],
    ['an agent nested in the pane agent (A3)', 530],
    ['an app nested in the pane agent (A3)', 630]
  ])('publishes %s unbound, saying why', async (_label, callerPid) => {
    const verified = await verify(callerPid)
    expect(verified).not.toHaveProperty('origin')
    expect(verified.unboundReason).toBe('this command was not started by the agent in its terminal')
    expect(verified.content).toBe(request.content)
  })

  it('publishes unbound when the terminal is closed or runs no agent', async () => {
    const closed = await verify(220, { handle: null })
    expect(closed.unboundReason).toBe(
      'the terminal its environment names is not open in OmniConsole'
    )
    const noAgent = await verify(220, { evidence: 'agent-gone' })
    expect(noAgent.unboundReason).toBe('no agent is running in its terminal')
  })

  it('keeps today’s binding when the tree cannot be read', async () => {
    const failingPs = {
      ...posix,
      readProcessRows: async () => {
        throw new Error('ps')
      }
    }
    for (const verified of [
      await verify(410, { evidence: 'none' }), // no evidence: listing unavailable
      await verify(410, {}, failingPs),
      await verify(410, { evidence: 'other', noListing: true }, failingPs),
      await verify(undefined), // no caller pid on the socket
      await verify(410, { agentReplaced: true }) // its pid may be another process now
    ]) {
      expect(verified.origin).toEqual(BOUND)
    }
  })

  it('keeps today’s binding when an agent is in the pane but cannot be proven', async () => {
    for (const verified of [
      await verify(410, { evidence: 'stopped' }), // the agent (200) is a stopped job
      await verify(410, { evidence: 'other' }), // the agent (200) is not the foreground
      // The newest hook row names a process in the tree, whatever its command line.
      await verify(
        410,
        { evidence: 'other', reportedPid: 150 },
        { ...posix, readProcessRows: async () => NO_AGENT_ROWS }
      )
    ]) {
      expect(verified.origin).toEqual(BOUND)
    }
  })

  it('keeps the binding for an unrecognised agent its live hook reporter names (F1)', async () => {
    const unknownAgent = {
      ...posix,
      readProcessRows: async () => UNKNOWN_AGENT_ROWS,
      // The process evidence's reporter: alias-resolved, while the newest row has no pid.
      hookPidForPane: () => 170
    }
    const verified = await verify(330, { evidence: 'other' }, unknownAgent)
    expect(verified.origin).toEqual(BOUND)
  })

  it('keeps today’s binding with no hook pid at all, as just after a restart (F1)', async () => {
    const restarted = { ...posix, readProcessRows: async () => UNKNOWN_AGENT_ROWS }
    expect((await verify(330, { evidence: 'other' }, restarted)).origin).toEqual(BOUND)
  })

  it('publishes unbound when the tree was read and no agent is anywhere in the pane', async () => {
    const noAgent = { ...posix, readProcessRows: async () => NO_AGENT_ROWS }
    for (const deps of [
      noAgent, // its agent (200) reported since the app started, then exited
      { ...noAgent, hookPidForPane: () => 4242 } // a live reporter outside this pane's tree
    ]) {
      for (const tree of ['other', 'stopped'] as const) {
        const verified = await verify(330, { evidence: tree, reportedPid: 200 }, deps)
        expect(verified).not.toHaveProperty('origin')
        expect(verified.unboundReason).toBe('no agent is running in its terminal')
      }
    }
  })

  it("refuses a Claude session that is not the pane's, and keeps a matching one", async () => {
    const source = runtime({ paneSession: 'conv-1' })
    const other = { ...request, origin: { ...request.origin, claudeSessionId: 'conv-9' } }
    const refused = await withVerifiedArtifactOrigin(source, other, 220, posix)
    expect(refused).not.toHaveProperty('origin')
    expect(refused.unboundReason).toContain('another Claude conversation')
    const same = { ...request, origin: { ...request.origin, claudeSessionId: 'conv-1' } }
    expect((await withVerifiedArtifactOrigin(source, same, 220, posix)).origin).toEqual(BOUND)
  })

  it('keeps SSH and Windows panes it cannot read bound, unless the session disagrees', async () => {
    const ssh = runtime({ connectionId: 'ssh-1', evidence: 'agent-gone', paneSession: 'conv-1' })
    expect((await withVerifiedArtifactOrigin(ssh, request, 410, posix)).origin).toEqual(BOUND)
    const windows = { ...posix, platform: 'win32' as const }
    expect((await verify(410, {}, windows)).origin).toEqual(BOUND)
    const other = { ...request, origin: { ...request.origin, claudeSessionId: 'conv-9' } }
    expect(await withVerifiedArtifactOrigin(ssh, other, 410, posix)).not.toHaveProperty('origin')
  })

  it('leaves a request without an origin alone', async () => {
    const { origin: _, ...plain } = request
    const source = runtime()
    expect(await withVerifiedArtifactOrigin(source, plain, 220, posix)).toEqual(plain)
    expect(source.readTerminalProcessEvidence).not.toHaveBeenCalled()
  })
})

describe('withSessionBindingNotice', () => {
  const ok = { status: 'ok', value: { shareUrl: 'https://x/a/p' } }

  it('tells the caller its page is not tied to its session', () => {
    expect(withSessionBindingNotice({ unboundReason: 'why' }, ok)).toEqual({
      status: 'ok',
      value: { shareUrl: 'https://x/a/p', sessionBinding: { state: 'unbound', reason: 'why' } }
    })
  })

  it('adds nothing to a bound page or a failed write', () => {
    expect(withSessionBindingNotice({}, ok)).toBe(ok)
    const failed = { status: 'unconfigured' }
    expect(withSessionBindingNotice({ unboundReason: 'why' }, failed)).toBe(failed)
  })
})

describe('the conversation verified for a write', () => {
  const scope = {
    cloudUserId: 'user-a',
    cloudProfileId: 'cloud-a',
    cloudOrganizationId: 'org-a',
    apiOrigin: 'https://app.omnisi.ai'
  }
  const entry = {
    paneKey: PANE,
    ledgerId: 'als_1',
    nativeSessionId: 'conv-1',
    account: consolePublicationPrincipal(scope.apiOrigin, scope.cloudUserId)
  }

  beforeEach(() => {
    entry.nativeSessionId = 'conv-1'
    setActiveLedgerPaneRegistry({
      get: (key: string) => (key === PANE ? entry : undefined),
      byLedgerId: () => undefined,
      byPtyId: () => undefined,
      byNativeSessionId: () => undefined
    } as never)
  })

  afterEach(() => {
    setActiveLedgerPaneRegistry(null)
  })

  it('binds the page to the conversation that was verified', async () => {
    const verified = await verify(220)
    expect(verified.verifiedSession).toEqual({ ledgerId: 'als_1', nativeSessionId: 'conv-1' })
    expect(artifactSessionOriginOf(verified)).toEqual(BOUND)
    expect(artifactSourceSessionRef(verified, scope)).toBe('als_1')
    expect(artifactSourceReview(verified, scope)).toMatchObject({ nativeSessionId: 'conv-1' })
  })

  it('publishes unbound when another conversation replaced it before publication', async () => {
    const verified = await verify(220)
    entry.nativeSessionId = 'conv-2' // the pane's agent switched conversations meanwhile
    expect(artifactSessionOriginOf(verified)).toBeUndefined()
    expect(artifactSourceSessionRef(verified, scope)).toBeUndefined()
    expect(artifactSourceReview(verified, scope)).toBeNull()
    expect(artifactUpdateOriginOf(verified)).toBeNull()
    const ok = { status: 'ok', value: { shareUrl: 'u' } }
    expect(withSessionBindingNotice(verified, ok).value).toMatchObject({
      sessionBinding: {
        state: 'unbound',
        reason: 'its terminal switched to another conversation before the page was published'
      }
    })
  })
})
