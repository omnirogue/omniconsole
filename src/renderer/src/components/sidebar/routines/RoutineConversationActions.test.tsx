// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAutomation, makeRun } from '@/components/automations/automations-page-fixtures'
import { listAutomationRunsForTarget } from '@/components/automations/automation-host-client'
import { TypesafeAdvertisingActions } from '@/components/automations/TypesafeAdvertisingActions'
import { TypesafeClassificationResult } from '@/components/automations/TypesafeClassificationResult'
import { AUTOMATIONS_CHANGED_EVENT } from '@/lib/automations-changed-window-event'
import { latestRunWithActions, RoutineConversationActions } from './RoutineConversationActions'
import { readStructuredRoutineConversation } from './structured-routine-conversation'
import type { RoutineConversation } from './routine-conversation-state'
import type { AutomationRun } from '../../../../../shared/automations-types'
import type { AutomationOwnerRef } from '../../../../../shared/automation-owner-ref'

vi.mock('@/components/automations/automation-host-client', () => ({
  listAutomationRunsForTarget: vi.fn(),
  runAutomationNowForTarget: vi.fn()
}))
vi.mock('./structured-routine-conversation', () => ({ readStructuredRoutineConversation: vi.fn() }))
vi.mock('@/components/automations/TypesafeAdvertisingActions', () => ({
  TypesafeAdvertisingActions: vi.fn(({ run }: { run: AutomationRun }) => (
    <div>Native advertising result: {run.id}</div>
  ))
}))
vi.mock('@/components/automations/TypesafeClassificationResult', () => ({
  TypesafeClassificationResult: vi.fn(({ run }: { run: AutomationRun }) => (
    <div>Advisory result: {run.id}</div>
  ))
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? key))
}))

const block = (entries: unknown[]) => `\`\`\`omni-actions\n${JSON.stringify(entries)}\n\`\`\``
const report = (overrides: Partial<AutomationRun> = {}, entries: unknown[] = []) =>
  makeRun({
    status: 'completed',
    outputSnapshot: {
      format: 'plain_text',
      content: `Report\n\n${block(entries)}`,
      capturedAt: 1,
      truncated: false
    },
    ...overrides
  })
const pauseEntry = { id: 'a1', kind: 'pause', nativeId: '123', label: 'Pause first' }

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.mocked(listAutomationRunsForTarget).mockReset()
  vi.mocked(readStructuredRoutineConversation).mockReset()
  vi.mocked(TypesafeAdvertisingActions).mockClear()
  vi.mocked(TypesafeClassificationResult).mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render() {
  await act(async () =>
    root.render(
      <RoutineConversationActions
        routine={{
          automation: makeAutomation(),
          sourceTarget: { kind: 'local' }
        }}
      />
    )
  )
}

describe('latestRunWithActions', () => {
  it('picks the newest completed report that carries a block', () => {
    const older = report({ id: 'old', createdAt: 1 }, [pauseEntry])
    const newer = report({ id: 'new', createdAt: 2 }, [{ ...pauseEntry, id: 'b1' }])
    expect(latestRunWithActions([older, newer])?.id).toBe('new')
  })
  it('looks past an apply run to the report it answered', () => {
    const answered = report({ id: 'rep', createdAt: 1 }, [pauseEntry])
    const apply = report({ id: 'apply', createdAt: 2, title: 'Advertising run 3 · apply a1' })
    expect(latestRunWithActions([answered, apply])?.id).toBe('rep')
  })
  it('looks past a scraped apply run and a scraped report to the last readable report', () => {
    // Runs 8–10 of the Advertising routine on 2026-09-20: Codex screen text, no message.
    const scrape = (id: string, createdAt: number, title = 'Advertising run 9') =>
      report({
        id,
        createdAt,
        title,
        outputSnapshot: {
          format: 'plain_text',
          content: `│ >_ OpenAI Codex (v0.155.1)\n  [\n    {"id": "a1"}\n  ]\n  Worked for 8m 30s · done 4:08 PM\n■ Conversation interrupted - R to Retry`,
          capturedAt: 1,
          truncated: false
        }
      })
    const answered = report({ id: 'rep', createdAt: 1 }, [pauseEntry])
    expect(
      latestRunWithActions([
        answered,
        scrape('apply', 2, 'Advertising run 8 · apply a1'),
        scrape('scheduled', 3, 'Advertising run 10')
      ])?.id
    ).toBe('rep')
  })
  it('shows nothing once the newest ordinary report has no block', () => {
    const older = report({ id: 'old', createdAt: 1 }, [pauseEntry])
    const quiet = report({ id: 'quiet', createdAt: 2 })
    expect(latestRunWithActions([older, quiet])).toBeNull()
  })
})

describe('RoutineConversationActions', () => {
  it('renders the latest report actions above the conversation and refreshes on change events', async () => {
    vi.mocked(listAutomationRunsForTarget).mockResolvedValueOnce([
      report({ id: 'rep', createdAt: 1 }, [pauseEntry])
    ])
    await render()
    expect(container.textContent).toContain('Recommended actions')
    expect(container.textContent).toContain('Pause first')
    vi.mocked(listAutomationRunsForTarget).mockResolvedValueOnce([
      report({ id: 'quiet', createdAt: 2 })
    ])
    await act(async () => {
      window.dispatchEvent(new CustomEvent(AUTOMATIONS_CHANGED_EVENT, { detail: {} }))
    })
    expect(container.textContent).not.toContain('Recommended actions')
    expect(listAutomationRunsForTarget).toHaveBeenCalledTimes(2)
  })
})

const sourceTarget = { kind: 'environment', environmentId: 'remote-1' } as const
const ownerRef: AutomationOwnerRef = {
  authority: { kind: 'runtime', environmentId: 'remote-1', pairingRevision: 4 },
  selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 9 }
}

function nativeRoutine(
  contract: 'advertising.v1' | 'classification.v1' = 'advertising.v1',
  overrides: Partial<RoutineConversation> = {}
): RoutineConversation {
  return {
    automation: makeAutomation({
      structuredOutput:
        contract === 'advertising.v1'
          ? {
              provider: 'typesafe',
              contract,
              advertising: { company: 'omnirogue', accountId: 'act_12345' }
            }
          : { provider: 'typesafe', contract }
    }),
    sourceTarget,
    ownerRef,
    tabId: 'tab',
    paneKey: null,
    ...overrides
  }
}

async function renderRoutine(routine: RoutineConversation) {
  await act(async () => root.render(<RoutineConversationActions routine={routine} />))
}

function deferredRead() {
  let resolve!: (value: Awaited<ReturnType<typeof readStructuredRoutineConversation>>) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Awaited<ReturnType<typeof readStructuredRoutineConversation>>>(
    (yes, no) => {
      resolve = yes
      reject = no
    }
  )
  return { promise, resolve, reject }
}

describe('native routine conversation results', () => {
  it.each([
    null,
    {
      format: 'plain_text' as const,
      content: 'No recommendations.',
      capturedAt: 2,
      truncated: false
    }
  ])('selects the latest native report without requiring an action block: %j', (outputSnapshot) => {
    const latest = makeRun({ id: 'native', createdAt: 2, outputSnapshot })
    expect(latestRunWithActions([report({ createdAt: 1 }, [pauseEntry]), latest], true)).toBe(
      latest
    )
  })

  it('ignores newer apply and unfinished runs when selecting a native report', () => {
    const latest = makeRun({ id: 'native', createdAt: 1 })
    expect(
      latestRunWithActions(
        [
          latest,
          report({ id: 'apply-title', createdAt: 2, title: 'Advertising · apply a1' }),
          report({ id: 'apply-prompt', createdAt: 3, promptOverride: 'APPLY: pause a1' }),
          report({ id: 'pending', createdAt: 4, status: 'dispatched' }, [pauseEntry])
        ],
        true
      )
    ).toBe(latest)
  })

  it.each(['advertising.v1', 'classification.v1'] as const)(
    'renders %s without a snapshot and forwards the resolved owner and source',
    async (contract) => {
      const routine = nativeRoutine(contract)
      const run = makeRun({ id: 'native', outputSnapshot: null })
      const resolvedSource = { kind: 'environment', environmentId: 'resolved-host' } as const
      const resolvedOwner: AutomationOwnerRef = {
        ...ownerRef,
        authority: { kind: 'runtime', environmentId: 'resolved-host', pairingRevision: 7 }
      }
      vi.mocked(readStructuredRoutineConversation).mockResolvedValue({
        runs: [run],
        ownerRef: resolvedOwner,
        sourceTarget: resolvedSource
      })
      await renderRoutine(routine)

      const panel =
        contract === 'advertising.v1' ? TypesafeAdvertisingActions : TypesafeClassificationResult
      expect(vi.mocked(panel).mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          automation: routine.automation,
          run,
          runs: [run],
          ownerRef: resolvedOwner,
          sourceTarget: resolvedSource
        })
      )
      expect(readStructuredRoutineConversation).toHaveBeenCalledWith(
        routine.automation,
        sourceTarget,
        expect.any(AbortSignal),
        ownerRef
      )
      expect(container.textContent).toContain(
        contract === 'advertising.v1'
          ? 'Native advertising result: native'
          : 'Advisory result: native'
      )
      expect(container.textContent).not.toContain('Recommended actions')
      expect(container.querySelectorAll('[data-routine-conversation-actions] button')).toHaveLength(
        0
      )
      expect(listAutomationRunsForTarget).not.toHaveBeenCalled()
    }
  )

  it.each(['advertising.v1', 'classification.v1'] as const)(
    'does not fall back to embedded legacy actions for %s',
    async (contract) => {
      vi.mocked(readStructuredRoutineConversation).mockResolvedValue({
        runs: [report({}, [pauseEntry])],
        ownerRef,
        sourceTarget
      })
      await renderRoutine(nativeRoutine(contract))

      expect(container.textContent).toContain(
        contract === 'advertising.v1'
          ? 'Native advertising result: run-1'
          : 'Advisory result: run-1'
      )
      expect(container.textContent).not.toContain('Pause first')
      expect(container.textContent).not.toContain('Recommended actions')
      expect(container.querySelectorAll('[data-routine-conversation-actions] button')).toHaveLength(
        0
      )
      expect(listAutomationRunsForTarget).not.toHaveBeenCalled()
    }
  )

  it('uses the newest native report even when its terminal output is scraped', async () => {
    const latest = report(
      {
        id: 'scraped',
        createdAt: 2,
        outputSnapshot: {
          format: 'plain_text',
          content: 'Worked for 8m 30s · done 4:08 PM\n■ Conversation interrupted',
          capturedAt: 2,
          truncated: false
        }
      },
      [pauseEntry]
    )
    vi.mocked(readStructuredRoutineConversation).mockResolvedValue({
      runs: [report({ id: 'older', createdAt: 1 }, [pauseEntry]), latest],
      ownerRef,
      sourceTarget
    })
    await renderRoutine(nativeRoutine())

    expect(container.querySelector('[data-routine-conversation-actions]')?.textContent).toBe(
      'Native advertising result: scraped'
    )
    expect(container.textContent).not.toContain('Pause first')
    expect(listAutomationRunsForTarget).not.toHaveBeenCalled()
  })

  it('shows an empty state when only apply or unfinished runs exist', async () => {
    vi.mocked(readStructuredRoutineConversation).mockResolvedValue({
      runs: [
        report({ title: 'Advertising · apply a1' }),
        report({ status: 'dispatched' }, [pauseEntry])
      ],
      ownerRef,
      sourceTarget
    })
    await renderRoutine(nativeRoutine())
    expect(container.textContent).toContain('This routine has no completed report yet.')
    expect(TypesafeAdvertisingActions).not.toHaveBeenCalled()
    expect(listAutomationRunsForTarget).not.toHaveBeenCalled()
  })

  it('clears legacy actions while native results load and when the owning host fails', async () => {
    vi.mocked(listAutomationRunsForTarget).mockResolvedValue([report({}, [pauseEntry])])
    await render()
    expect(container.textContent).toContain('Pause first')
    vi.mocked(listAutomationRunsForTarget).mockClear()
    const pending = deferredRead()
    vi.mocked(readStructuredRoutineConversation).mockReturnValue(pending.promise)
    await renderRoutine(nativeRoutine())

    expect(container.textContent).toContain('Loading routine results…')
    expect(container.textContent).not.toContain('Pause first')
    await act(async () => pending.reject(new Error('owner offline')))
    expect(container.textContent).toContain('Routine results are unavailable from the owning host.')
    expect(container.textContent).not.toContain('Recommended actions')
    expect(container.querySelectorAll('[data-routine-conversation-actions] button')).toHaveLength(0)
    expect(listAutomationRunsForTarget).not.toHaveBeenCalled()
  })

  it.each(['source host', 'routine'] as const)(
    'ignores a stale history read after changing the %s',
    async (changed) => {
      const pending = deferredRead()
      vi.mocked(readStructuredRoutineConversation).mockReturnValueOnce(pending.promise)
      await renderRoutine(nativeRoutine())
      const oldSignal = vi.mocked(readStructuredRoutineConversation).mock.calls[0][2]
      const next = nativeRoutine()
      if (changed === 'source host') {
        next.sourceTarget = { kind: 'environment', environmentId: 'remote-2' }
        next.ownerRef = {
          ...ownerRef,
          authority: { kind: 'runtime', environmentId: 'remote-2', pairingRevision: 1 }
        }
      } else {
        next.automation = { ...next.automation, id: 'a-2' }
      }
      const run = makeRun({ id: 'new-report', automationId: next.automation.id })
      vi.mocked(readStructuredRoutineConversation).mockResolvedValueOnce({
        runs: [run],
        ownerRef: next.ownerRef!,
        sourceTarget: next.sourceTarget
      })
      await renderRoutine(next)
      expect(oldSignal.aborted).toBe(true)
      expect(container.querySelector('[data-routine-conversation-actions]')?.textContent).toBe(
        'Native advertising result: new-report'
      )

      await act(async () =>
        pending.resolve({ runs: [makeRun({ id: 'old-report' })], ownerRef, sourceTarget })
      )
      expect(container.querySelector('[data-routine-conversation-actions]')?.textContent).toBe(
        'Native advertising result: new-report'
      )
      expect(listAutomationRunsForTarget).not.toHaveBeenCalled()
    }
  )
})
