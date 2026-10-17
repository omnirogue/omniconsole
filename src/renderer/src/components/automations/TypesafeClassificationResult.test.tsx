// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import type { RoutineStructuredResult } from '../../../../shared/routine-structured-result'
import { TypesafeClassificationResult } from './TypesafeClassificationResult'
import { makeAutomation, makeRun } from './automations-page-fixtures'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getRuntimeEnvironmentStatus: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

type Props = ComponentProps<typeof TypesafeClassificationResult>
const remote = { kind: 'environment', environmentId: 'remote-1' } as const
const runtimeOwner: AutomationOwnerRef = {
  authority: { kind: 'runtime', environmentId: 'remote-1', pairingRevision: 4 },
  selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 9 }
}
let root: Root
let container: HTMLDivElement

function result(overrides: Partial<RoutineStructuredResult> = {}): RoutineStructuredResult {
  return {
    protocol: 'routine-classification.v1',
    routineId: 'a-1',
    runId: 'run-1',
    sourceRevision: 'a'.repeat(64),
    evaluatedAt: Date.UTC(2026, 8, 20, 12),
    status: 'ready',
    reason: null,
    verdict: 'PASS',
    severity: 'WARNING',
    confidence: 0.93,
    provider: 'typesafe',
    model: 'typesafe-v1',
    ...overrides
  }
}

function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function render(overrides: Partial<Props> = {}) {
  await act(async () =>
    root.render(
      <TypesafeClassificationResult
        automation={makeAutomation({
          structuredOutput: { provider: 'typesafe', contract: 'classification.v1' }
        })}
        run={makeRun()}
        {...overrides}
      />
    )
  )
}

function fields() {
  return Object.fromEntries(
    [...container.querySelectorAll('dt')].map((label) => [
      label.textContent,
      label.nextElementSibling?.textContent
    ])
  )
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.mocked(callRuntimeRpc).mockReset()
  vi.mocked(callRuntimeRpc).mockResolvedValue({ result: result() })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('TypesafeClassificationResult', () => {
  it('shows the advisory verdict and provenance without execution controls', async () => {
    await render()

    expect(container.textContent).toContain('Advisory result')
    expect(fields()).toMatchObject({
      Verdict: 'PASS',
      Severity: 'WARNING',
      Confidence: '93%',
      Source: expect.stringContaining('typesafe'),
      Version: 'a'.repeat(64),
      Evaluated: expect.stringContaining('2026')
    })
    expect(fields().Source).toContain('typesafe-v1')
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'automation.structured.get',
      { automationId: 'a-1', runId: 'run-1' },
      expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 15_000 })
    )
  })

  it('keeps the result pending until the owning host answers', async () => {
    const pending = deferred()
    vi.mocked(callRuntimeRpc).mockReturnValue(pending.promise)
    await render()
    expect(container.textContent).toContain('Loading advisory result…')
    expect(container.textContent).not.toContain('PASS')

    await act(async () => pending.resolve({ result: null }))
    expect(container.textContent).toContain('This run has no advisory result yet.')
    expect(container.querySelector('dl')).toBeNull()
  })

  it('shows a blocked result and its reason without a verdict', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue({
      result: result({
        status: 'blocked',
        reason: 'Provider credentials are unavailable.',
        verdict: null,
        severity: null,
        confidence: null
      })
    })
    await render()

    expect(container.textContent).toContain('Advisory result is blocked.')
    expect(container.textContent).toContain('Provider credentials are unavailable.')
    expect(container.textContent).not.toContain('PASS')
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('reports an unavailable owner without retrying on another host', async () => {
    vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('offline'))
    await render({ sourceTarget: remote })

    expect(container.textContent).toContain('Advisory result is unavailable from the owning host.')
    expect(container.textContent).not.toContain('PASS')
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(vi.mocked(callRuntimeRpc).mock.calls[0][0]).toEqual(remote)
  })

  it.each([
    ['missing result wrapper', result()],
    ['invalid confidence', { result: result({ confidence: 1.5 }) }],
    ['another routine', { result: result({ routineId: 'a-2' }) }],
    ['another run', { result: result({ runId: 'run-2' }) }]
  ])('rejects %s without displaying its advisory verdict', async (_label, response) => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(response)
    await render()

    expect(container.textContent).toContain('Advisory result is unavailable from the owning host.')
    expect(container.textContent).not.toContain('PASS')
    expect(container.querySelector('dl')).toBeNull()
  })

  it.each([undefined, remote])(
    'resolves the owner from run context or source %j',
    async (sourceTarget) => {
      await render({
        sourceTarget,
        automation: makeAutomation({
          runContext: {
            kind: 'workspace-run',
            projectId: 'project-1',
            hostId: 'runtime:context-host',
            projectHostSetupId: 'setup-1',
            repoId: 'repo-1',
            path: '/srv/omni'
          }
        })
      })
      expect(vi.mocked(callRuntimeRpc).mock.calls[0][0]).toEqual(
        sourceTarget ?? { kind: 'environment', environmentId: 'context-host' }
      )
    }
  )

  it.each(['desktop', 'runtime'] as const)(
    'fences self and SSH reads on the %s authority',
    async (kind) => {
      const authority: AutomationOwnerRef['authority'] =
        kind === 'runtime' ? { kind, environmentId: 'remote-1', pairingRevision: 4 } : { kind }
      const sourceTarget = kind === 'runtime' ? remote : { kind: 'local' as const }
      for (const selector of [
        { kind: 'self' as const },
        { kind: 'ssh' as const, targetId: 'ssh-1', targetGeneration: 9 }
      ]) {
        await render({ sourceTarget, ownerRef: { authority, selector } })
        expect(callRuntimeRpc).toHaveBeenLastCalledWith(
          sourceTarget,
          'automation.structured.get',
          { automationId: 'a-1', runId: 'run-1', expectedOwner: { selector } },
          expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 15_000 })
        )
        expect(
          vi.mocked(callRuntimeRpc).mock.calls.at(-1)?.[3]?.expectedEnvironmentPairingRevision
        ).toBe(kind === 'runtime' ? 4 : undefined)
      }
    }
  )

  it.each(['source host', 'run'] as const)(
    'ignores a late result after changing the %s',
    async (changed) => {
      const oldRequest = deferred()
      const newRequest = deferred()
      vi.mocked(callRuntimeRpc)
        .mockReturnValueOnce(oldRequest.promise)
        .mockReturnValueOnce(newRequest.promise)
      await render({ sourceTarget: remote })
      const oldSignal = vi.mocked(callRuntimeRpc).mock.calls[0][3]?.signal
      const runId = changed === 'run' ? 'run-2' : 'run-1'
      await render({
        sourceTarget:
          changed === 'source host' ? { kind: 'environment', environmentId: 'remote-2' } : remote,
        run: makeRun({ id: runId })
      })
      expect(oldSignal?.aborted).toBe(true)
      expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('Loading advisory result…')

      await act(async () => newRequest.resolve({ result: result({ runId, verdict: 'FAIL' }) }))
      expect(fields().Verdict).toBe('FAIL')
      await act(async () => oldRequest.resolve({ result: result() }))
      expect(fields().Verdict).toBe('FAIL')
      expect(container.textContent).not.toContain('PASS')
    }
  )

  it.each(['pairing revision', 'SSH generation'] as const)(
    'invalidates a result after the %s changes',
    async (changed) => {
      const replacement = deferred()
      vi.mocked(callRuntimeRpc)
        .mockResolvedValueOnce({ result: result() })
        .mockReturnValueOnce(replacement.promise)
      await render({ sourceTarget: remote, ownerRef: runtimeOwner })
      expect(fields().Verdict).toBe('PASS')
      const ownerRef: AutomationOwnerRef =
        changed === 'pairing revision'
          ? {
              ...runtimeOwner,
              authority: { kind: 'runtime', environmentId: 'remote-1', pairingRevision: 5 }
            }
          : { ...runtimeOwner, selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 10 } }
      await render({ sourceTarget: remote, ownerRef })

      expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
      expect(container.textContent).not.toContain('PASS')
      expect(container.textContent).toContain('Loading advisory result…')
      expect(vi.mocked(callRuntimeRpc).mock.calls[1][2]).toMatchObject({
        expectedOwner: { selector: ownerRef.selector }
      })
      expect(vi.mocked(callRuntimeRpc).mock.calls[1][3]?.expectedEnvironmentPairingRevision).toBe(
        changed === 'pairing revision' ? 5 : 4
      )
      await act(async () => replacement.resolve({ result: null }))
      expect(container.textContent).toContain('This run has no advisory result yet.')
    }
  )
})
