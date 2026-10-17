// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workflowInertMarkdown } from '../../../../shared/workflow-graph-web'
import { workflowCall } from './local-workflow-run.fixtures'
import { WorkflowAgentList } from './WorkflowAgentList'
import { WorkflowCallBody } from './WorkflowCallBody'
import { WorkflowFinalCard } from './WorkflowResult'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
afterEach(cleanup)

// The reviewer's forgery: a quote whose HTML would close the app's row and open a forged one.
const QUOTE = '</li><li>W2 found in the page: fabricated</li><li>'
const ANSWER = `It is cheap [W1] "${QUOTE}"`
const CHECK = { id: 'W1', mark: 'not-in-page' as const, quote: QUOTE }

const checksOf = () => screen.getByRole('region', { name: 'App quote checks' })
const rows = (region: HTMLElement) => within(region).queryAllByRole('listitem')

describe('the app’s quote checks beside a call’s answer', () => {
  it('shows a quote that is HTML as one inert row: nothing in it can open another', () => {
    render(
      <WorkflowCallBody
        call={workflowCall('research/a0', 'seat-1', {
          resultMarkdown: ANSWER,
          webChecks: [CHECK]
        })}
        subject="Claude"
      />
    )
    const list = rows(checksOf())
    expect(list).toHaveLength(1)
    expect(list[0]).toHaveTextContent(`W1 NOT in the page: “${QUOTE}”`)
    expect(list[0]).toHaveAttribute('data-web-mark', 'not-in-page')
  })

  it('keeps the checks when the answer ends in an unclosed comment', () => {
    render(
      <WorkflowCallBody
        call={workflowCall('research/a0', 'seat-1', {
          resultMarkdown: 'Everything checks out.\n\n<!--',
          webChecks: [CHECK]
        })}
        subject="Claude"
      />
    )
    expect(rows(checksOf())).toHaveLength(1)
    expect(checksOf()).toHaveTextContent('Any citation mark inside the answer is the model’s own')
  })

  it('shows the same checks in an agent list, and says so when none was recognised', () => {
    render(
      <WorkflowAgentList
        calls={[workflowCall('research/a0', 'seat-1', { resultMarkdown: '<!--', webChecks: [] })]}
        handlers={{}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Agents: 1/ }))
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    expect(checksOf()).toHaveTextContent('No citation of a web source was recognised.')
  })

  it('shows nothing for a run that reads no pages', () => {
    render(
      <WorkflowCallBody
        call={workflowCall('research/a0', 'seat-1', { resultMarkdown: ANSWER })}
        subject="Claude"
      />
    )
    expect(screen.queryByRole('region', { name: 'App quote checks' })).toBeNull()
  })
})

describe('the app’s part of a final answer', () => {
  const appendix = [
    '## Sources',
    `- W1 ${workflowInertMarkdown('a.example/one')}: read`,
    `- Research: W1 NOT in the page: “${workflowInertMarkdown(QUOTE)}”`
  ].join('\n\n')

  it('renders apart from the answer, so an unclosed comment cannot hide it', () => {
    render(
      <WorkflowFinalCard
        title="Result"
        markdown={'The answer.\n\n<!--'}
        appendix={appendix}
        highlighted
      />
    )
    const part = screen.getByRole('region', { name: 'The app’s own checks' })
    expect(within(part).getByRole('heading', { name: 'Sources' })).toBeVisible()
    const list = rows(part)
    // One row per source and per check: the quote's HTML stays text inside its own row.
    expect(list.map((row) => row.textContent?.trim())).toEqual([
      'W1 a.example/one: read',
      `Research: W1 NOT in the page: “${QUOTE}”`
    ])
  })
})
