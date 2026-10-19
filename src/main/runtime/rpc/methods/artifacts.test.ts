import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ARTIFACT_CLI_MAX_RPC_BYTES } from '../../../../shared/artifacts'
import {
  startSessionWrittenFiles,
  type SessionWrittenFilesObservation
} from '../../../artifacts/session-written-files-store'
import { isStreamingMethod, type RpcMethod } from '../core'
import { ARTIFACT_METHODS } from './artifacts'

const validRequest = {
  sourceKey: '/repo/report.html',
  content: '<h1>Report</h1>',
  contentType: 'text/html',
  fileName: 'report.html'
}

function writeSchema(name: string) {
  const method = ARTIFACT_METHODS.find((candidate) => candidate.name === name)
  if (!method?.params) {
    throw new Error(`Missing ${name} schema`)
  }
  return method.params
}

const PANE = 'tab-a:11111111-1111-4111-8111-111111111111'

/** A pane whose proven agent is `agentPid`, read against the real process table. */
function paneAgentRuntime(agentPid: number) {
  return {
    shareArtifact: vi.fn().mockResolvedValue({ status: 'ok' }),
    updateArtifact: vi.fn().mockResolvedValue({ status: 'ok' }),
    getTerminalPaneKey: vi.fn().mockReturnValue(PANE),
    getTerminalWorktreeIdForPaneKey: vi.fn().mockReturnValue('wt-1'),
    getTerminalHandleForPaneKey: vi.fn().mockReturnValue('term-1'),
    resolveTerminalContext: vi.fn().mockReturnValue({ worktreeId: 'wt-1', connectionId: null }),
    readTerminalProcessEvidence: vi.fn().mockResolvedValue({
      proof: { pid: agentPid, agent: 'claude', ptyId: 'pty-1' },
      tree: { kind: 'other' }
    }),
    assertTerminalAgentProcess: vi.fn().mockResolvedValue(undefined),
    getReportedProviderSessionsForPane: vi.fn().mockReturnValue([])
  }
}

function requestMethod(name: string): RpcMethod {
  const method = ARTIFACT_METHODS.find((candidate) => candidate.name === name)
  if (!method || isStreamingMethod(method)) {
    throw new Error(`Missing request method ${name}`)
  }
  return method
}

describe('artifact RPC schemas', () => {
  it('registers the local publish upsert', () => {
    expect(writeSchema('artifacts.publish').safeParse(validRequest).success).toBe(true)
  })

  it('registers the persisted-link lookup', () => {
    const schema = writeSchema('artifacts.getPublishedLink')
    expect(schema.safeParse({ sourceKey: validRequest.sourceKey }).success).toBe(true)
    expect(schema.safeParse({ sourceKey: '' }).success).toBe(false)
  })

  it('rejects empty and oversized artifact requests', () => {
    const schema = writeSchema('artifacts.publish')
    expect(schema.safeParse({ ...validRequest, content: '' }).success).toBe(false)
    expect(
      schema.safeParse({ ...validRequest, content: 'x'.repeat(ARTIFACT_CLI_MAX_RPC_BYTES + 1) })
        .success
    ).toBe(false)
    expect(
      schema.safeParse({
        ...validRequest,
        content: '"'.repeat(Math.floor(ARTIFACT_CLI_MAX_RPC_BYTES / 2))
      }).success
    ).toBe(false)
  })

  it('accepts and keeps review fields', () => {
    const schema = writeSchema('artifacts.share')
    const parsed = schema.safeParse({
      ...validRequest,
      review: { question: 'Ship it?', reviewers: ['a@example.com'] },
      audience: 'team'
    })
    expect(parsed.success && parsed.data).toMatchObject({
      review: { question: 'Ship it?', reviewers: ['a@example.com'] },
      audience: 'team'
    })
    expect(schema.safeParse({ ...validRequest, review: {} }).success).toBe(true)
  })

  it('rejects invalid review fields', () => {
    const schema = writeSchema('artifacts.update')
    expect(schema.safeParse({ ...validRequest, audience: 'everyone' }).success).toBe(false)
    expect(
      schema.safeParse({ ...validRequest, review: { question: 'x'.repeat(501) } }).success
    ).toBe(false)
    expect(
      schema.safeParse({
        ...validRequest,
        review: { reviewers: Array.from({ length: 21 }, (_, index) => `r${index}@x.com`) }
      }).success
    ).toBe(false)
    expect(schema.safeParse({ ...validRequest, review: { decide: 'approved' } }).success).toBe(
      false
    )
  })

  it('accepts a review summary and options, bounded like the server', () => {
    const schema = writeSchema('artifacts.share')
    const review = {
      question: 'Fix it?',
      summary: 'Two lines to decide from.',
      options: [{ label: 'Start', detail: 'Open a PR', recommended: true }, { label: 'Not now' }],
      multi: true
    }
    const parsed = schema.safeParse({ ...validRequest, review })
    expect(parsed.success && parsed.data).toMatchObject({ review })
    const rejects = (extra: object) =>
      schema.safeParse({ ...validRequest, review: { ...review, ...extra } }).success
    expect(rejects({ summary: 'x'.repeat(1201) })).toBe(false)
    expect(rejects({ options: [{ label: 'Only' }] })).toBe(false)
    expect(rejects({ options: [{ label: 'A', pick: true }, { label: 'B' }] })).toBe(false)
    expect(rejects({ options: [{ label: 'x'.repeat(161) }, { label: 'B' }] })).toBe(false)
    expect(rejects({ multi: false })).toBe(false)
  })

  it('accepts a review category, bounded and strict', () => {
    const schema = writeSchema('artifacts.share')
    const review = { reviewers: ['a@example.com'], about: { category: 'customer-service' } }
    const parsed = schema.safeParse({ ...validRequest, review })
    expect(parsed.success && parsed.data).toMatchObject({ review })
    const accepts = (about: unknown) =>
      schema.safeParse({ ...validRequest, review: { about } }).success
    expect(accepts({ category: 'x'.repeat(40) })).toBe(true)
    expect(accepts({ category: 'x'.repeat(41) })).toBe(false)
    expect(accepts({ category: '' })).toBe(false)
    expect(accepts({ category: 'finance', company: 'acme' })).toBe(false)
  })

  it('registers the review status read by file or slug', () => {
    const schema = writeSchema('artifacts.reviewStatus')
    expect(schema.safeParse({ sourceKey: '/repo/plan.html' }).success).toBe(true)
    expect(schema.safeParse({ slug: 'artifact-1' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ slug: '../admin' }).success).toBe(false)
  })

  it('passes a list state filter and refuses unknown states', () => {
    const schema = writeSchema('artifacts.list')
    for (const state of ['open', 'closed', 'needs_me']) {
      expect(schema.safeParse({ state }).success).toBe(true)
    }
    expect(schema.safeParse({ cursor: 'c1' }).success).toBe(true)
    expect(schema.safeParse({ state: 'all' }).success).toBe(false)
  })

  it('routes a lifecycle change to the runtime by page id', async () => {
    const method = requestMethod('artifacts.lifecycle')
    const runtime = { changeArtifactLifecycle: vi.fn().mockResolvedValue({ status: 'ok' }) }
    const body = { action: 'close', revision: 2, lifecycle: 'no_action', note: 'Answered' }
    await method.handler({ id: 'artifact-1', body, apiUrl: 'https://x.test' }, {
      runtime
    } as never)
    expect(runtime.changeArtifactLifecycle).toHaveBeenCalledWith('artifact-1', body, {
      apiUrl: 'https://x.test'
    })
    expect(method.params?.safeParse({ id: '../admin', body }).success).toBe(false)
    expect(
      method.params?.safeParse({ id: 'a', body: { action: 'reopen', revision: 1 } }).success
    ).toBe(false)
  })

  it('accepts the publishing terminal and drops unknown origin fields', () => {
    const schema = writeSchema('artifacts.share')
    const parsed = schema.safeParse({
      ...validRequest,
      origin: { terminalHandle: 'term-1', paneKey: 'tab:leaf', worktreeId: 'wt', extra: 'x' }
    })
    expect(parsed.success && parsed.data).toMatchObject({
      origin: { terminalHandle: 'term-1', paneKey: 'tab:leaf', worktreeId: 'wt' }
    })
    expect(parsed.success && (parsed.data as { origin: object }).origin).not.toHaveProperty('extra')
    expect(schema.safeParse({ ...validRequest, origin: { paneKey: '' } }).success).toBe(false)
  })

  it('resolves the terminal to its session before the service sees the request', async () => {
    const method = requestMethod('artifacts.update')
    const runtime = paneAgentRuntime(process.ppid)
    await method.handler({ ...validRequest, origin: { terminalHandle: 'term-1' } }, {
      runtime,
      callerPid: process.pid
    } as never)
    expect(runtime.updateArtifact).toHaveBeenCalledWith({
      ...validRequest,
      origin: { paneKey: PANE, worktreeId: 'wt-1' },
      verifiedSession: {}
    })
  })

  it.runIf(process.platform !== 'win32')(
    'publishes unbound when the calling process is not under the pane agent',
    async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
      const method = requestMethod('artifacts.share')
      // The caller's parent is not a process of the agent (this test process).
      const runtime = paneAgentRuntime(process.pid)
      runtime.shareArtifact.mockResolvedValue({ status: 'ok', value: { shareUrl: 'u' } })
      const result = await method.handler(
        { ...validRequest, origin: { terminalHandle: 'term-1' } },
        { runtime, callerPid: process.ppid } as never
      )
      const reason = 'this command was not started by the agent in its terminal'
      expect(runtime.shareArtifact).toHaveBeenCalledWith({ ...validRequest, unboundReason: reason })
      expect(result).toEqual({
        status: 'ok',
        value: { shareUrl: 'u', sessionBinding: { state: 'unbound', reason } }
      })
      info.mockRestore()
    }
  )

  it('registers the renderer-safe session record list', () => {
    const method = requestMethod('artifacts.sessionRecords')
    const runtime = { listArtifactSessionRecords: vi.fn().mockReturnValue([]) }
    expect(method.params).toBeNull()
    expect(method.handler(undefined, { runtime } as never)).toEqual([])
  })

  it('keeps the published by-pane written files and adds the per-session read beside it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'artifact-written-files-'))
    let observe: ((event: SessionWrittenFilesObservation) => void) | null = null
    const stop = startSessionWrittenFiles({
      directory,
      subscribe: (listener) => {
        observe = listener
        return () => undefined
      }
    })
    try {
      observe!({
        paneKey: 'tab-1:1',
        hookEventName: 'PostToolUse',
        providerSession: { id: 'session-1' },
        payload: { agentType: 'kimi', toolName: 'Write', toolInput: '/w/a.md' }
      })
      const published = requestMethod('artifacts.sessionWrittenFiles')
      expect(published.params).toBeNull()
      expect(published.handler(undefined, {} as never)).toEqual([
        { paneKey: 'tab-1:1', sessionId: 'session-1', paths: ['/w/a.md'] }
      ])
      const perSession = requestMethod('artifacts.sessionWrittenFilesV2')
      expect(perSession.params?.safeParse({ provider: 'kimi' }).success).toBe(false)
      expect(perSession.handler({ provider: 'kimi', sessionId: 'session-1' }, {} as never)).toEqual(
        ['/w/a.md']
      )
      expect(perSession.handler({ provider: 'gemini', sessionId: 'x' }, {} as never)).toEqual([])
    } finally {
      await stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
