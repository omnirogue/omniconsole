import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  SESSION_PREP_ROUTING_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { runProcess } from '../../shared/child-process/run-process'
import { runSessionPrepRouter, sessionPrepRoutingMode } from './session-prep-router-cli'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
const brief = { title: 'Task', brief: 'Private task text' }
const decision = {
  provider: 'codex',
  model: 'gpt-6-luna',
  effort: 'medium',
  tier: 'fast',
  gate: 'jev',
  reason: 'Bounded',
  note: ''
}

beforeEach(() => {
  vi.stubEnv('OMNI_ROUTE_SCRIPT', join(process.cwd(), 'resources/dispatch-router/omni_route.py'))
  vi.stubEnv('OMNI_DISPATCH_ROUTER_MODE', '')
  vi.mocked(runProcess).mockResolvedValue({
    stdout: JSON.stringify(decision),
    stderr: '',
    code: 0,
    timedOut: false,
    signal: null
  } as Awaited<ReturnType<typeof runProcess>>)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('dispatch router modes and bounded adapter', () => {
  it('keeps live as the default and gives operator off rollback priority', async () => {
    expect(sessionPrepRoutingMode()).toBe('live')
    vi.stubEnv('OMNI_DISPATCH_ROUTER_MODE', 'off')
    expect(await runSessionPrepRouter({ ...brief, mode: 'live' })).toMatchObject({
      status: 'off',
      mode: 'off'
    })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it.each(['off', 'shadow', 'live'] as const)(
    'gives operator %s priority over an intake mode',
    (operator) => {
      vi.stubEnv('OMNI_DISPATCH_ROUTER_MODE', operator)
      expect(sessionPrepRoutingMode('live')).toBe(operator)
      expect(sessionPrepRoutingMode('off')).toBe(operator)
    }
  )

  it('keeps the full brief on stdin and uses only an opaque dispatch title in argv', async () => {
    const request = { title: 'Private customer title', brief: 'Private customer work details' }
    await runSessionPrepRouter(request)
    const call = vi.mocked(runProcess).mock.calls[0]![0]
    expect(call.input).toBe(request.brief)
    expect(JSON.stringify(call.args)).not.toContain(request.title)
    expect(JSON.stringify(call.args)).not.toContain(request.brief)
    const args = call.args!
    expect(args[args.indexOf('--title') + 1]).toMatch(/^dispatch-[a-f0-9]{16}$/)
  })

  it('records shadow decisions and their source hash without invoking an agent', async () => {
    expect(await runSessionPrepRouter({ ...brief, mode: 'shadow' })).toMatchObject({
      ...decision,
      mode: 'shadow',
      origin: 'override',
      version: expect.any(String)
    })
    expect(runProcess).toHaveBeenCalledOnce()
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'python3',
        timeoutMs: 6000,
        input: brief.brief
      })
    )
  })

  it('records a timeout without leaking stderr or automatically retrying', async () => {
    vi.mocked(runProcess).mockResolvedValue({
      stdout: '',
      stderr: 'private account detail',
      code: null,
      timedOut: true,
      signal: 'SIGTERM'
    } as Awaited<ReturnType<typeof runProcess>>)
    const result = await runSessionPrepRouter(brief)
    expect(result).toMatchObject({
      status: 'unavailable',
      unrouted: 'Dispatch classification timed out'
    })
    expect(JSON.stringify(result)).not.toContain('private account detail')
    expect(runProcess).toHaveBeenCalledOnce()
  })

  it('ships the audited classifier with private logs and declares mode capability', () => {
    expect(RUNTIME_CAPABILITIES).toContain(SESSION_PREP_ROUTING_RUNTIME_CAPABILITY)
    const root = join(process.cwd(), 'resources/dispatch-router')
    expect(readFileSync(join(root, 'omni_route.py'), 'utf8')).not.toContain("'head':")
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
      files: Record<string, string>
    }
    for (const [name, hash] of Object.entries(manifest.files)) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(root, name)))
          .digest('hex')
      ).toBe(hash)
    }
  })
})
