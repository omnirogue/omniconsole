// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import type { WorkflowWebTrail } from '../../../../shared/workflow-web-trail'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { WorkflowGraphRunView } from './WorkflowGraphRunView'
import { WorkflowWebSources } from './WorkflowWebSources'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span data-agent-icon={agent} />
}))
vi.mock('./WorkflowStepDetail', () => ({ WorkflowStepDetail: () => null }))
afterEach(cleanup)

const TRAIL: WorkflowWebTrail = {
  read: 2,
  sources: [
    {
      id: 'W1',
      address: 'example.com/pricing',
      state: 'read',
      readAt: '2026-09-24T10:12:00.000Z',
      removedLines: 2
    },
    {
      id: 'W2',
      address: 'blocked.example',
      state: 'unreadable',
      reason: { code: 'status', status: 403 }
    },
    {
      id: 'W3',
      address: 'example.org/doc',
      state: 'read',
      readAt: '2026-09-24T10:12:00.000Z',
      truncated: true
    },
    { id: 'W4', address: 'gone.example', state: 'not-kept' }
  ]
}

const rows = () => within(screen.getByRole('region', { name: 'Sources' })).getAllByRole('listitem')

describe('the Sources panel', () => {
  it('counts the pages read and lists one row per page', () => {
    render(<WorkflowWebSources trail={TRAIL} />)
    expect(screen.getByText('Sources (2 of 4 read)')).toBeInTheDocument()
    expect(rows()).toHaveLength(4)
    expect(rows()[0]).toHaveTextContent(
      /^W1 · example\.com\/pricing · read .+ · 2 lines removed that read as instructions to AI$/
    )
    expect(rows()[2]).toHaveTextContent('cut to its first 60,000 characters')
  })

  it('shows an unreadable page in the warning tone with its reason, never as a success', () => {
    render(<WorkflowWebSources trail={TRAIL} />)
    for (const row of [rows()[1]!, rows()[3]!]) {
      expect(row).toHaveClass('text-status-warning')
      expect(row.querySelector('[data-web-icon="warning"]')).not.toBeNull()
      expect(row.querySelector('.lucide-circle-check, .lucide-check')).toBeNull()
      expect(row.outerHTML).not.toContain('status-success')
    }
    expect(rows()[1]).toHaveTextContent(
      'W2 · blocked.example · could not be read: the site refused (403)'
    )
    expect(rows()[3]).toHaveTextContent('not read: the app holds no checked copy of it')
    // A read page is plain, not a green tick either.
    expect(rows()[0]).not.toHaveClass('text-status-warning')
    expect(rows()[0]!.outerHTML).not.toContain('status-success')
  })

  it('shows in the run view of a run that reads pages', () => {
    const spec = normalizeWorkflowSpec({
      title: 'Research',
      steps: [
        {
          id: 'research',
          kind: 'do',
          title: 'Research',
          agents: [{}],
          web: { urls: ['https://example.com/pricing'] }
        }
      ]
    })
    const view = {
      executionId: 'run',
      state: 'completed',
      calls: [],
      stages: [],
      graphRun: {
        spec,
        levels: { research: 0 },
        steps: [{ id: 'research', state: 'done', agents: [], rounds: [] }],
        web: TRAIL,
        gaps: [],
        notes: []
      }
    } as unknown as LocalWorkflowView
    render(<WorkflowGraphRunView view={view} handlers={{} as never} />)
    expect(screen.getByText('Sources (2 of 4 read)')).toBeInTheDocument()
  })
})
