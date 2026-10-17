// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { BoundAdvertisingDecision } from '../../../../shared/typesafe-advertising'
import { TypesafeAdvertisingDecision } from './TypesafeAdvertisingDecision'
import { makeAdvertisingPreview } from './typesafe-advertising-actions-fixtures'
import {
  makeLocalAdvertisingDecision,
  makeLocalAdvertisingPreview,
  makeLocalAdvertisingReceipt
} from './typesafe-local-advertising-fixtures'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, name: string) => String(values?.[name] ?? match))
}))

const rpc = vi.mocked(callRuntimeRpc)
let root: Root
let container: HTMLDivElement

async function render(decision: BoundAdvertisingDecision = makeLocalAdvertisingDecision()) {
  await act(async () =>
    root.render(
      <TypesafeAdvertisingDecision
        decision={decision}
        target={{ kind: 'local' }}
        automationId="a-1"
        runId="run-1"
        ownerRef={{ authority: { kind: 'desktop' }, selector: { kind: 'self' } }}
        disabled={false}
      />
    )
  )
}

function button(label: string) {
  const result = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === label
  )
  expect(result, `Expected button: ${label}`).toBeDefined()
  return result!
}

async function click(label: string) {
  await act(async () => button(label).click())
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  rpc.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('local advertising status approval', () => {
  it.each(['PAUSE', 'TURN_ON'] as const)(
    'keeps %s a proposal until exact preview approval',
    async (kind) => {
      rpc.mockResolvedValueOnce({ preview: makeLocalAdvertisingPreview(kind) })
      await render(makeLocalAdvertisingDecision(kind))
      expect(container.textContent).toContain('Recommendation only')
      expect(container.textContent).toContain('requires separate local action authorization')
      expect(rpc).not.toHaveBeenCalled()
      await click('Review status action')
      expect(rpc.mock.calls[0][1]).toBe('automation.advertising.preview')
      expect(container.textContent).toContain('Not a signed backend action')
      expect(container.textContent).toContain(
        'does not prove this request caused the observed state'
      )
      const confirm = kind === 'PAUSE' ? 'Confirm Pause' : 'Confirm Turn on'
      expect(button(confirm).disabled).toBe(true)
      await click(confirm)
      expect(rpc).toHaveBeenCalledTimes(1)
      const checkbox = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!
      expect(checkbox.getAttribute('aria-checked')).toBe('false')
      await act(async () => checkbox.click())
      rpc.mockResolvedValueOnce({ receipt: makeLocalAdvertisingReceipt(false, kind) })
      await click(confirm)
      expect(rpc.mock.calls[1][1]).toBe('automation.advertising.execute')
      expect(rpc.mock.calls[1][2]).toMatchObject({
        approved: true,
        previewId: `act_${'b'.repeat(32)}`,
        expectedRevision: 'c'.repeat(64)
      })
      expect(container.querySelector('[role="checkbox"]')).toBeNull()
      expect(container.textContent).toContain('Action unverified')
      expect(container.querySelector('.text-status-success')).toBeNull()
    }
  )

  it('does not expose approval after absent local authority or an older host refusal', async () => {
    rpc.mockRejectedValueOnce(new Error('Local action authority unavailable'))
    await render()
    await click('Review status action')
    expect(container.querySelector('[role="checkbox"]')).toBeNull()
    expect(container.textContent).not.toContain('Confirm Pause')
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it.each(['INCREASE_BUDGET', 'DECREASE_BUDGET', 'NO_ACTION', 'KEEP_RUNNING'] as const)(
    'never offers a local action for %s',
    async (kind) => {
      await render({ ...makeLocalAdvertisingDecision(), kind })
      expect(container.querySelector('button')).toBeNull()
      expect(rpc).not.toHaveBeenCalled()
    }
  )

  it('never offers a campaign status action', async () => {
    const decision = makeLocalAdvertisingDecision()
    decision.target = {
      ...decision.target,
      objectType: 'campaign',
      nativeId: '54321',
      adsetId: null
    }
    await render(decision)
    expect(container.querySelector('button')).toBeNull()
  })

  it.each(['backend substitution', 'another run', 'another decision'] as const)(
    'refuses a local preview with %s',
    async (mismatch) => {
      const preview = makeLocalAdvertisingPreview()
      if (mismatch === 'another run') {
        preview.run_id = 'run-2'
      }
      if (mismatch === 'another decision') {
        preview.decision_id = '9'.repeat(64)
      }
      rpc.mockResolvedValueOnce({
        preview: mismatch === 'backend substitution' ? makeAdvertisingPreview() : preview
      })
      await render()
      await click('Review status action')
      expect(container.querySelector('[role="checkbox"]')).toBeNull()
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
    }
  )

  it('labels independently observed target state without claiming causal execution', async () => {
    rpc.mockResolvedValueOnce({ receipt: makeLocalAdvertisingReceipt(true) })
    await render()
    await click('Check recorded action')
    expect(container.querySelector('.text-status-success')?.textContent).toContain(
      'Target state verified by local Meta readback'
    )
    expect(container.textContent).toContain('Causality is unproven')
    expect(container.textContent).not.toContain('Pause verified')
    expect(rpc.mock.calls.map((call) => call[1])).toEqual(['automation.advertising.verify'])
  })

  it('rejects a false local verification with changed budgets', async () => {
    const receipt = makeLocalAdvertisingReceipt(true)
    receipt.execution!.verification!.observed!.dailyBudget = 6000
    rpc.mockResolvedValueOnce({ receipt })
    await render()
    await click('Check recorded action')
    expect(container.querySelector('.text-status-success')).toBeNull()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })
})
