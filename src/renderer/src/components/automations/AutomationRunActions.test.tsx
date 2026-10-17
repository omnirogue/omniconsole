// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationRunActions } from './AutomationRunActions'
import { TypesafeAdvertisingActions } from './TypesafeAdvertisingActions'
import { TypesafeClassificationResult } from './TypesafeClassificationResult'
import { makeAutomation, makeRun } from './automations-page-fixtures'
import { runAutomationNowForTarget } from './automation-host-client'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { AutomationStructuredOutput } from '../../../../shared/automation-structured-output'
import { parseAutomationActions } from '../../../../shared/automation-actions'

vi.mock('./automation-host-client', () => ({ runAutomationNowForTarget: vi.fn() }))
vi.mock('./TypesafeAdvertisingActions', () => ({
  TypesafeAdvertisingActions: vi.fn(() => <div>Typesafe advertising unavailable</div>)
}))
vi.mock('./TypesafeClassificationResult', () => ({
  TypesafeClassificationResult: vi.fn(() => <div>Advisory result</div>)
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? key))
}))
const entries = [
  { id: 'a1', kind: 'pause', nativeId: '123', label: 'Pause first' },
  { id: 'a2', kind: 'pause', nativeId: '456', label: 'Pause second' },
  { id: 'a3', kind: 'activate', nativeId: '789', label: 'Activate third' }
]
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.mocked(TypesafeAdvertisingActions).mockClear()
  vi.mocked(TypesafeClassificationResult).mockClear()
  vi.mocked(runAutomationNowForTarget).mockReset()
  vi.mocked(runAutomationNowForTarget).mockResolvedValue(makeRun({ runNumber: 9 }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
async function render(runs: AutomationRun[] = [], blocked = false) {
  await act(async () =>
    root.render(
      <AutomationRunActions
        automation={makeAutomation()}
        run={makeRun({ error: `\`\`\`omni-actions\n${JSON.stringify(entries)}\n\`\`\`` })}
        runs={runs}
        runNowAvailability={
          blocked ? { canRunNow: false, reason: 'runtime-unavailable', message: 'Offline' } : null
        }
      />
    )
  )
}
function buttons(label: string) {
  return [...container.querySelectorAll('button')].filter((button) => button.textContent === label)
}

describe('AutomationRunActions', () => {
  it('renders recommendations and sends a single pause with the native ID', async () => {
    await render()
    expect(container.textContent).toContain('Recommended actions')
    expect(container.textContent).toContain('Activate third')
    expect(buttons('Pause')).toHaveLength(2)
    await act(async () => buttons('Pause')[0].click())
    expect(runAutomationNowForTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a-1' }),
      undefined,
      expect.objectContaining({ prompt: expect.stringMatching(/^APPLY:/), titleSuffix: 'apply a1' })
    )
    const prompt = vi.mocked(runAutomationNowForTarget).mock.calls[0][2]!.prompt!
    expect(parseAutomationActions(prompt).actions).toEqual([entries[0]])
    // One click must leave the other recommendations in reach (Sal, 2026-09-20).
    expect(container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true')
    expect(buttons('Pause sent · verifying…')[0].disabled).toBe(true)
    expect(buttons('Pause')).toHaveLength(1)
    expect(buttons('Turn on')).toHaveLength(1)
    expect(container.textContent).toContain('3 · 1 sent')
  })
  it('batches only pauses', async () => {
    await render()
    await act(async () => buttons('Apply all pauses (2)')[0].click())
    const options = vi.mocked(runAutomationNowForTarget).mock.calls[0][2]!
    expect(parseAutomationActions(options.prompt!).actions).toEqual(entries.slice(0, 2))
    expect(options.titleSuffix).toBe('apply a1,a2')
  })
  it('reads each sent action outcome from its apply run, never showing ids or code', async () => {
    const applied = `Confirmed act_1 / 123 ACTIVE → PAUSED; effective_status PAUSED.`
    await render([
      makeRun({
        id: 'later',
        createdAt: 20,
        title: 'Nightly run 2 · apply a1',
        runNumber: 2,
        outputSnapshot: { format: 'plain_text', content: applied, capturedAt: 1, truncated: false }
      }),
      makeRun({
        id: 'failed',
        createdAt: 25,
        title: 'Nightly run 3 · apply a2',
        runNumber: 3,
        status: 'dispatch_failed',
        error: 'Codex could not continue in this pane: its conversation is open in another app.'
      }),
      makeRun({
        id: 'running',
        createdAt: 30,
        title: 'Nightly run 4 · apply a3',
        runNumber: 4,
        status: 'dispatched'
      }),
      makeRun({ id: 'another', createdAt: 40, title: 'Nightly run 5 · apply a20', runNumber: 5 })
    ])
    // Every action is sent, so the card folds to its summary — and reopens on the header.
    expect(container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('3 · 3 sent')
    await act(async () => (container.querySelector('[aria-expanded]') as HTMLButtonElement).click())
    expect(container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true')
    expect(buttons('Paused ✓')[0].disabled).toBe(true)
    expect(
      buttons(
        'Failed: Codex could not continue in this pane: its conversation is open in another app.'
      )
    ).toHaveLength(1)
    expect(buttons('Turn-on sent · verifying…')).toHaveLength(1)
    expect(container.textContent).not.toContain('a1')
    expect(container.textContent).not.toContain('{')
  })
  it('shows a plain unreadable line instead of code for a scraped or broken block', async () => {
    const scrape = `  Worked for 8m 30s · done 4:08 PM\n■ Conversation interrupted\n\`\`\`omni-actions\n[{"id":"a1"\n\`\`\``
    await act(async () =>
      root.render(
        <AutomationRunActions
          automation={makeAutomation()}
          run={makeRun({ error: scrape })}
          runs={[]}
          runNowAvailability={null}
        />
      )
    )
    expect(container.textContent).toBe('Recommendations could not be read from this run.')
  })
  it('disables actions when the host cannot run', async () => {
    await render([], true)
    expect(
      [...container.querySelectorAll('button:not([aria-expanded])')].every(
        (button) => (button as HTMLButtonElement).disabled
      )
    ).toBe(true)
    expect(container.textContent).toContain('Offline')
  })
})

describe('AutomationRunActions structured output routing', () => {
  const advertising: AutomationStructuredOutput = {
    provider: 'typesafe',
    contract: 'advertising.v1',
    advertising: { company: 'omnirogue', accountId: 'act_12345' }
  }

  it.each([false, true])(
    'never falls back to legacy actions without a native envelope (host unavailable: %s)',
    async (blocked) => {
      const automation = makeAutomation({ structuredOutput: advertising })
      const run = makeRun({ error: `\`\`\`omni-actions\n${JSON.stringify(entries)}\n\`\`\`` })
      const sourceTarget = { kind: 'environment' as const, environmentId: 'remote-1' }
      const runNowAvailability = blocked
        ? { canRunNow: false as const, reason: 'runtime-unavailable' as const, message: 'Offline' }
        : null
      await act(async () =>
        root.render(
          <AutomationRunActions
            automation={automation}
            run={run}
            runs={[]}
            sourceTarget={sourceTarget}
            runNowAvailability={runNowAvailability}
          />
        )
      )

      expect(container.textContent).toBe('Typesafe advertising unavailable')
      expect(container.textContent).not.toContain('Recommended actions')
      expect(buttons('Pause')).toHaveLength(0)
      expect(buttons('Turn on')).toHaveLength(0)
      expect(buttons('Apply all pauses (2)')).toHaveLength(0)
      expect(runAutomationNowForTarget).not.toHaveBeenCalled()
      expect(vi.mocked(TypesafeAdvertisingActions).mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ automation, run, sourceTarget, runNowAvailability })
      )
    }
  )

  it('still renders native advertising actions when the run has no legacy recommendations', async () => {
    await act(async () =>
      root.render(
        <AutomationRunActions
          automation={makeAutomation({ structuredOutput: advertising })}
          run={makeRun()}
          runs={[]}
          runNowAvailability={null}
        />
      )
    )

    expect(container.textContent).toBe('Typesafe advertising unavailable')
    expect(runAutomationNowForTarget).not.toHaveBeenCalled()
  })

  it('shows only advisory output for classification even when prose contains actions', async () => {
    await act(async () =>
      root.render(
        <AutomationRunActions
          automation={makeAutomation({
            structuredOutput: { provider: 'typesafe', contract: 'classification.v1' }
          })}
          run={makeRun({ error: `\`\`\`omni-actions\n${JSON.stringify(entries)}\n\`\`\`` })}
          runs={[]}
          runNowAvailability={null}
        />
      )
    )
    expect(container.textContent).toBe('Advisory result')
    expect(TypesafeAdvertisingActions).not.toHaveBeenCalled()
    expect(TypesafeClassificationResult).toHaveBeenCalled()
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(runAutomationNowForTarget).not.toHaveBeenCalled()
  })

  it('preserves legacy APPLY actions when structured output is off', async () => {
    await render()
    expect(TypesafeAdvertisingActions).not.toHaveBeenCalled()
    expect(TypesafeClassificationResult).not.toHaveBeenCalled()
    expect(buttons('Pause')).toHaveLength(2)
    await act(async () => buttons('Pause')[0].click())
    expect(runAutomationNowForTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a-1' }),
      undefined,
      expect.objectContaining({ prompt: expect.stringMatching(/^APPLY:/), titleSuffix: 'apply a1' })
    )
  })
})
