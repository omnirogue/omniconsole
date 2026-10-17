// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import { TypesafeAdvertisingActions } from './TypesafeAdvertisingActions'
import { makeAutomation, makeRun } from './automations-page-fixtures'
import {
  makeAdvertisingDecision,
  makeAdvertisingEnvelope,
  makeAdvertisingPreview,
  makeAdvertisingReceipt
} from './typesafe-advertising-actions-fixtures'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getRuntimeEnvironmentStatus: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, name: string) => String(values?.[name] ?? match))
}))

type Props = ComponentProps<typeof TypesafeAdvertisingActions>
const remote = { kind: 'environment', environmentId: 'remote-1' } as const
const desktopOwner: AutomationOwnerRef = {
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
}
const runtimeOwner: AutomationOwnerRef = {
  authority: { kind: 'runtime', environmentId: 'remote-1', pairingRevision: 4 },
  selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 9 }
}
const rpc = vi.mocked(callRuntimeRpc)
let root: Root
let container: HTMLDivElement

function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function render(overrides: Partial<Props> = {}) {
  await act(async () =>
    root.render(
      <TypesafeAdvertisingActions
        automation={makeAutomation({
          structuredOutput: {
            provider: 'typesafe',
            contract: 'advertising.v1',
            advertising: { company: 'omnirogue', accountId: 'act_99999' }
          }
        })}
        run={makeRun()}
        ownerRef={desktopOwner}
        runNowAvailability={null}
        {...overrides}
      />
    )
  )
}

function button(label: string) {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent === label)
  expect(found, `Expected button: ${label}`).toBeDefined()
  return found!
}

async function click(label: string) {
  await act(async () => button(label).click())
}

async function approvePreview() {
  await click('Preview Pause')
  const checkbox = container.querySelector<HTMLButtonElement>('[role="checkbox"]')
  expect(checkbox).not.toBeNull()
  expect(checkbox!.getAttribute('aria-checked')).toBe('false')
  await act(async () => checkbox!.click())
  expect(checkbox!.getAttribute('aria-checked')).toBe('true')
}

function actionCalls(operation: string) {
  return rpc.mock.calls.filter((call) => call[1] === `automation.advertising.${operation}`)
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  rpc.mockReset()
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'automation.advertising.get') {
      return { envelope: makeAdvertisingEnvelope() }
    }
    if (method === 'automation.advertising.preview') {
      return { preview: makeAdvertisingPreview() }
    }
    if (method === 'automation.advertising.execute') {
      return { receipt: makeAdvertisingReceipt() }
    }
    if (method === 'automation.advertising.verify') {
      return { receipt: makeAdvertisingReceipt('verified') }
    }
    throw new Error(`Unexpected RPC: ${method}`)
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('TypesafeAdvertisingActions', () => {
  it.each([undefined, null])(
    'blocks action RPCs when the captured owner is %s',
    async (ownerRef) => {
      await render({ ownerRef })

      expect(container.textContent).toContain('Decision confidence: 93%')
      expect(container.textContent).toContain(
        'Refresh the host connection before previewing or checking this action.'
      )
      expect(button('Preview Pause').disabled).toBe(true)
      expect(button('Check recorded action').disabled).toBe(true)
      expect(container.querySelector('[role="checkbox"]')).toBeNull()
      expect(container.textContent).not.toContain('Confirm Pause')
      await click('Preview Pause')
      await click('Check recorded action')

      expect(rpc.mock.calls.map((call) => call[1])).toEqual(['automation.advertising.get'])
    }
  )

  it('separates decision confidence from the decision probability distribution', async () => {
    await render()

    expect(container.textContent).toContain('Decision confidence: 93%')
    const probabilities = Object.fromEntries(
      [...container.querySelectorAll('dt')].map((label) => [
        label.textContent,
        label.nextElementSibling?.textContent
      ])
    )
    expect(probabilities.Pause).toBe('60%')
    expect(Object.keys(probabilities)).toHaveLength(6)
    expect(container.textContent).toContain('Account: act_99999')
    expect(container.textContent).toContain('Source: console.coordinator.statistics')
    expect(container.querySelector('.text-status-success')).toBeNull()
  })

  it('shows the actual evidence source, budget owner, and source limitations', async () => {
    const decision = makeAdvertisingDecision()
    decision.evidence.source = 'console.sales.ads'
    decision.evidence.budgetOwnerId = '54321'
    decision.evidence.limitations = ['Purchases are unavailable for this window.']
    rpc.mockResolvedValue({ envelope: makeAdvertisingEnvelope({ decisions: [decision] }) })
    await render()

    expect(container.textContent).toContain('Source: console.sales.ads')
    expect(container.textContent).toContain('Budget owner: 54321')
    expect(container.textContent).toContain(
      'Evidence limits: Purchases are unavailable for this window.'
    )
  })

  it.each(['KEEP_RUNNING', 'NO_ACTION', 'INCREASE_BUDGET', 'DECREASE_BUDGET'] as const)(
    'never exposes action controls for %s',
    async (kind) => {
      rpc.mockResolvedValue({
        envelope: makeAdvertisingEnvelope({
          decisions: [makeAdvertisingDecision({ kind, recommendationOnly: false })]
        })
      })
      await render()

      expect(container.querySelector('article')?.textContent).toContain('Recommendation only')
      expect(container.querySelector('article')?.querySelectorAll('button')).toHaveLength(0)
      expect(rpc).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps a recommendation-only pause non-executable', async () => {
    rpc.mockResolvedValue({
      envelope: makeAdvertisingEnvelope({
        decisions: [makeAdvertisingDecision({ recommendationOnly: true })]
      })
    })
    await render()
    expect(container.querySelector('article')?.querySelectorAll('button')).toHaveLength(0)
  })

  it.each([
    ['null', { envelope: null }],
    ['malformed', { envelope: { status: 'ready', decisions: [] } }],
    ['missing wrapper', makeAdvertisingEnvelope()],
    [
      'blocked',
      { envelope: makeAdvertisingEnvelope({ status: 'blocked', reason: 'Source is stale.' }) }
    ],
    ['another routine', { envelope: makeAdvertisingEnvelope({ routineId: 'a-2' }) }],
    ['another run', { envelope: makeAdvertisingEnvelope({ runId: 'run-2' }) }],
    [
      'invalid confidence',
      {
        envelope: makeAdvertisingEnvelope({
          decisions: [makeAdvertisingDecision({ confidence: 1.5 })]
        })
      }
    ]
  ])('exposes no action for a %s envelope', async (_label, response) => {
    rpc.mockResolvedValue(response)
    await render()

    expect(container.querySelector('article')).toBeNull()
    expect([...container.querySelectorAll('button')].map((node) => node.textContent)).toEqual([
      'Refresh decisions'
    ])
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('requires a loaded preview and an explicit checkbox before confirmation', async () => {
    await render()
    expect(container.textContent).not.toContain('Confirm Pause')
    expect(container.querySelector('[role="checkbox"]')).toBeNull()
    await click('Preview Pause')

    expect(container.textContent).toContain('Native object: 12345 · Account: act_99999')
    expect(container.textContent).toContain('Status: active → paused')
    expect(container.textContent).toContain('I approve this exact action')
    expect(button('Confirm Pause').disabled).toBe(true)
    await click('Confirm Pause')
    expect(actionCalls('execute')).toHaveLength(0)
    await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click())
    expect(button('Confirm Pause').disabled).toBe(false)
    await click('Confirm Pause')

    expect(actionCalls('execute')).toHaveLength(1)
    expect(actionCalls('execute')[0][2]).toMatchObject({
      automationId: 'a-1',
      runId: 'run-1',
      decisionId: 'a'.repeat(64),
      previewId: `act_${'b'.repeat(32)}`,
      expectedRevision: 'c'.repeat(64),
      approved: true
    })
  })

  it.each(['accepted', 'unverified'] as const)(
    'does not claim success for an %s receipt until source verification',
    async (status) => {
      await render()
      await approvePreview()
      rpc.mockResolvedValueOnce({ receipt: makeAdvertisingReceipt(status) })
      await click('Confirm Pause')

      expect(container.textContent).toContain('Action unverified.')
      expect(container.querySelector('.text-status-success')).toBeNull()
      expect(container.textContent).not.toContain('Confirm Pause')
      await click('Check recorded action')

      expect(container.querySelector('.text-status-success')?.textContent).toBe(
        'Pause verified · Source: meta · Version: native-v2'
      )
      expect(actionCalls('execute')).toHaveLength(1)
      expect(actionCalls('verify')).toHaveLength(1)
    }
  )

  it('forwards source target, captured SSH owner and pairing revision on every operation', async () => {
    await render({ sourceTarget: remote, ownerRef: runtimeOwner })
    await approvePreview()
    await click('Confirm Pause')
    await click('Check recorded action')

    expect(rpc.mock.calls.map((call) => call[1])).toEqual([
      'automation.advertising.get',
      'automation.advertising.preview',
      'automation.advertising.execute',
      'automation.advertising.verify'
    ])
    for (const call of rpc.mock.calls) {
      expect(call[0]).toEqual(remote)
      expect(call[2]).toMatchObject({
        automationId: 'a-1',
        runId: 'run-1',
        expectedOwner: { selector: runtimeOwner.selector }
      })
      expect(call[3]?.expectedEnvironmentPairingRevision).toBe(4)
    }
  })

  it('blocks duplicate execute clicks and verification while execution is in flight', async () => {
    await render()
    await approvePreview()
    const pending = deferred()
    rpc.mockReturnValueOnce(pending.promise)
    const confirm = button('Confirm Pause')
    await act(async () => {
      confirm.click()
      confirm.click()
    })
    expect(actionCalls('execute')).toHaveLength(1)
    expect(button('Check recorded action').disabled).toBe(true)
    await click('Check recorded action')
    expect(actionCalls('verify')).toHaveLength(0)

    await act(async () => pending.resolve({ receipt: makeAdvertisingReceipt() }))
    expect(button('Check recorded action').disabled).toBe(false)
    expect(actionCalls('execute')).toHaveLength(1)
  })

  it('leaves only recorded-action recovery after an execute timeout without resending', async () => {
    await render()
    await approvePreview()
    const pending = deferred()
    rpc.mockReturnValueOnce(pending.promise)
    await click('Confirm Pause')
    await act(async () => pending.reject(new Error('RPC timed out')))

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Check the recorded action before taking another action.'
    )
    expect(
      [...container.querySelector('article')!.querySelectorAll('button')].map(
        (node) => node.textContent
      )
    ).toEqual(['Check recorded action'])
    expect(container.querySelector('.text-status-success')).toBeNull()
    await click('Check recorded action')
    expect(actionCalls('execute')).toHaveLength(1)
    expect(actionCalls('verify')).toHaveLength(1)
  })

  it.each(['native object', 'account', 'campaign'] as const)(
    'rejects a preview for a different %s',
    async (mismatch) => {
      await render()
      const preview = makeAdvertisingPreview()
      if (mismatch === 'native object') {
        preview.target.id = '67890'
        preview.snapshot.objectId = '67890'
      } else if (mismatch === 'account') {
        preview.snapshot.adAccountId = 'act_88888'
      } else {
        preview.snapshot.campaignId = '67890'
        preview.snapshot.parentId = '67890'
      }
      rpc.mockResolvedValueOnce({ preview })
      await click('Preview Pause')

      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      expect(container.querySelector('[role="checkbox"]')).toBeNull()
      expect(container.textContent).not.toContain('Confirm Pause')
      expect(actionCalls('execute')).toHaveLength(0)
    }
  )

  it('rejects a receipt claiming verified without source evidence', async () => {
    await render()
    await approvePreview()
    rpc.mockResolvedValueOnce({
      receipt: makeAdvertisingReceipt('accepted', { status: 'verified' })
    })
    await click('Confirm Pause')

    expect(container.querySelector('.text-status-success')).toBeNull()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(button('Check recorded action').disabled).toBe(false)
  })

  it.each(['account', 'preview ID'] as const)(
    'rejects an execute receipt with another %s',
    async (mismatch) => {
      await render()
      await approvePreview()
      const preview = makeAdvertisingPreview()
      if (mismatch === 'account') {
        preview.snapshot.adAccountId = 'act_88888'
      } else {
        preview.id = `act_${'d'.repeat(32)}`
      }
      rpc.mockResolvedValueOnce({
        receipt: makeAdvertisingReceipt('verified', { id: preview.id, preview })
      })
      await click('Confirm Pause')

      expect(container.querySelector('.text-status-success')).toBeNull()
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      expect(container.textContent).not.toContain('Confirm Pause')
      expect(actionCalls('execute')).toHaveLength(1)
    }
  )

  it('rejects read reconciliation reporting a verified action from another account', async () => {
    await render()
    const preview = makeAdvertisingPreview()
    preview.snapshot.adAccountId = 'act_88888'
    rpc.mockResolvedValueOnce({ receipt: makeAdvertisingReceipt('verified', { preview }) })
    await click('Check recorded action')

    expect(container.querySelector('.text-status-success')).toBeNull()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(actionCalls('execute')).toHaveLength(0)
  })

  it('keeps read reconciliation available while the owning host cannot execute', async () => {
    await render({
      runNowAvailability: {
        canRunNow: false,
        reason: 'runtime-unavailable',
        message: 'The owning host is offline.'
      }
    })
    expect(button('Preview Pause').disabled).toBe(true)
    expect(button('Check recorded action').disabled).toBe(false)
    await click('Preview Pause')
    expect(actionCalls('preview')).toHaveLength(0)
    expect(container.textContent).toContain('The owning host is offline.')
    await click('Check recorded action')
    expect(actionCalls('verify')).toHaveLength(1)
    expect(actionCalls('execute')).toHaveLength(0)
  })

  it('does not allow a stale preview-only receipt to unlock execution after a timeout', async () => {
    await render()
    await approvePreview()
    rpc.mockRejectedValueOnce(new Error('RPC timed out'))
    await click('Confirm Pause')
    rpc.mockResolvedValueOnce({ receipt: makeAdvertisingReceipt('preview', { execution: null }) })
    await click('Check recorded action')

    expect(
      [...container.querySelector('article')!.querySelectorAll('button')].map(
        (node) => node.textContent
      )
    ).toEqual(['Check recorded action'])
    expect(actionCalls('execute')).toHaveLength(1)
  })

  it('permits a new preview when read reconciliation finds only an unexecuted proposal', async () => {
    await render()
    rpc.mockResolvedValueOnce({ receipt: makeAdvertisingReceipt('preview', { execution: null }) })
    await click('Check recorded action')

    expect(button('Preview Pause').disabled).toBe(false)
    await approvePreview()
    await click('Confirm Pause')
    expect(actionCalls('execute')).toHaveLength(1)
  })

  it('refuses an already-expired preview without an approval control', async () => {
    await render()
    rpc.mockResolvedValueOnce({
      preview: makeAdvertisingPreview({
        expires_at: new Date(Date.now() - 1000).toISOString()
      })
    })
    await click('Preview Pause')

    expect(container.textContent).toContain('This preview expired.')
    expect(container.querySelector('[role="checkbox"]')).toBeNull()
    expect(button('Confirm Pause').disabled).toBe(true)
    await click('Confirm Pause')
    expect(actionCalls('execute')).toHaveLength(0)
  })

  it.each(['pairing revision', 'SSH generation'] as const)(
    'discards a late preview after changing the %s',
    async (changed) => {
      await render({ sourceTarget: remote, ownerRef: runtimeOwner })
      const pending = deferred()
      rpc.mockReturnValueOnce(pending.promise)
      await click('Preview Pause')
      const ownerRef: AutomationOwnerRef =
        changed === 'pairing revision'
          ? {
              ...runtimeOwner,
              authority: { kind: 'runtime', environmentId: 'remote-1', pairingRevision: 5 }
            }
          : { ...runtimeOwner, selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 10 } }
      await render({ sourceTarget: remote, ownerRef })
      await act(async () => pending.resolve({ preview: makeAdvertisingPreview() }))

      expect(actionCalls('get')).toHaveLength(2)
      expect(container.querySelector('[role="checkbox"]')).toBeNull()
      expect(container.textContent).not.toContain('Confirm Pause')
      expect(actionCalls('execute')).toHaveLength(0)
      expect(actionCalls('get').at(-1)?.[2]).toMatchObject({
        expectedOwner: { selector: ownerRef.selector }
      })
      expect(actionCalls('get').at(-1)?.[3]?.expectedEnvironmentPairingRevision).toBe(
        changed === 'pairing revision' ? 5 : 4
      )
    }
  )
})
