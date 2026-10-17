// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationRunMessage } from './AutomationRunMessage'
import { readAutomationApplyOutcomes } from './automation-apply-outcome'
import { makeRun } from './automations-page-fixtures'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? key))
}))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <pre data-markdown>{content}</pre>
}))

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const snapshot = (content: string) => ({
  format: 'plain_text' as const,
  content,
  capturedAt: 1,
  truncated: false
})
async function render(content: string, cardShown = true) {
  await act(async () =>
    root.render(
      <AutomationRunMessage
        run={makeRun({ outputSnapshot: snapshot(content) })}
        cardShown={cardShown}
      />
    )
  )
  return container.querySelector('[data-markdown]')?.textContent ?? ''
}

describe('AutomationRunMessage', () => {
  it('renders an empty block as "No changes recommended" and never as []', async () => {
    const markdown = await render('Report\n\n```omni-actions\n[]\n```')
    expect(markdown).toBe('Report')
    expect(container.textContent).toContain('No changes recommended.')
    expect(container.textContent).not.toContain('[]')
  })
  it('removes a readable block when the card shows it, and counts it when the card cannot', async () => {
    const content =
      'Report\n\n```omni-actions\n[{"id":"a1","kind":"pause","label":"Pause X","nativeId":"1"}]\n```'
    expect(await render(content)).toBe('Report')
    expect(container.textContent).not.toContain('omni-actions')
    await render(content, false)
    expect(container.textContent).toContain('1 recommendations')
  })
  it('strips terminal chrome from a scraped run and says so', async () => {
    const markdown = await render(
      '│ >_ OpenAI Codex (v0.155.1)\n  Spend is $421.89\n  Worked for 8m 30s · done 4:08 PM\n■ Conversation interrupted - R to Retry'
    )
    expect(markdown).toBe('Spend is $421.89')
    expect(container.textContent).toContain('Shown from the terminal screen')
  })
})

describe('readAutomationApplyOutcomes', () => {
  it('marks a scraped apply run as unknown rather than applied', () => {
    const report = makeRun({ id: 'rep', createdAt: 1 })
    const outcomes = readAutomationApplyOutcomes(
      report,
      [
        makeRun({
          id: 'apply',
          createdAt: 2,
          runNumber: 8,
          title: 'Advertising run 8 · apply a1,a2',
          outputSnapshot: snapshot(
            '  Worked for 8m 30s · done 4:08 PM\n■ Conversation interrupted - R to Retry'
          )
        })
      ],
      [{ id: 'a1', kind: 'pause', label: 'Pause', nativeId: '1' }]
    )
    expect([...outcomes]).toEqual([['a1', { state: 'unknown', runNumber: 8 }]])
  })
})
