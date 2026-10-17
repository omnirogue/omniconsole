// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalWorkflowExecutionView } from './LocalWorkflowExecutionView'
import { workflowView } from './local-workflow-ui.fixtures'
import { createHash } from 'node:crypto'
import { localWorkflowFollowUpPrompt } from '@/lib/local-workflow-follow-up-prompt'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span data-agent-icon={agent} />
}))
afterEach(cleanup)

function completedWithResult(markdown = 'Accepted answer') {
  const view = workflowView()
  view.state = 'completed'
  view.actions = []
  view.result = { markdown, sources: [], coverage: [] }
  return view
}

describe('workflow run frame', () => {
  it('keeps a finished duration fixed and never invents one without a finish time', () => {
    const view = workflowView()
    view.state = 'completed'
    view.startedAt = 1_000_000
    view.finishedAt = 1_066_000
    const { rerender } = render(<LocalWorkflowExecutionView view={view} />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Done')
    expect(status).toHaveTextContent('1:06')
    rerender(<LocalWorkflowExecutionView view={{ ...view, finishedAt: undefined }} />)
    expect(screen.getByRole('status')).not.toHaveTextContent('1:06')
  })

  it('sends controls, but only the host projection changes the shown state', async () => {
    const view = workflowView()
    const onControl = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<LocalWorkflowExecutionView view={view} onControl={onControl} />)
    expect(screen.getByRole('status')).toHaveTextContent('Working')
    expect(screen.getByRole('status')).toHaveTextContent('1 working · 0 done')
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(onControl).toHaveBeenCalledWith('pause'))
    expect(screen.getByRole('status')).toHaveTextContent('Working')
    rerender(
      <LocalWorkflowExecutionView
        view={{ ...view, state: 'pausing', actions: ['stop'] }}
        onControl={onControl}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Pausing')
    rerender(
      <LocalWorkflowExecutionView
        view={{ ...view, connection: 'disconnected' }}
        onControl={onControl}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Connection lost · status unknown')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('offers Retry when the host allows it and shows a failed run without blanking', async () => {
    const view = workflowView()
    view.state = 'failed'
    view.actions = ['retry']
    view.error = 'The chairman did not answer.'
    view.calls = [{ ...view.calls[0], state: 'failed', error: 'timed out after 15:00' }]
    const onControl = vi.fn().mockResolvedValue(undefined)
    render(<LocalWorkflowExecutionView view={view} onControl={onControl} />)
    expect(screen.getByRole('alert')).toHaveTextContent('The chairman did not answer.')
    expect(screen.getByText("Claude didn't finish: timed out after 15:00")).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onControl).toHaveBeenCalledWith('retry'))
  })

  it('names older stages by position and keeps call logs behind Details', () => {
    render(<LocalWorkflowExecutionView view={workflowView()} />)
    const rail = screen.getByRole('list', { name: 'Stages' })
    expect(within(rail).getByText('First opinions')).toBeVisible()
    expect(within(rail).getByText('Peer rankings')).toBeVisible()
    expect(within(rail).getByText("Chairman's answer")).toBeVisible()
    expect(screen.queryByRole('region', { name: 'stdout' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByRole('region', { name: 'stdout' })).toHaveTextContent('Unicode café')
    expect(screen.queryByText(/Headless call/)).toBeNull()
  })

  it('renders captured logs safely and copies only what is displayed', async () => {
    const view = workflowView()
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    Object.assign(window, { api: { ui: { writeClipboardText } } })
    view.calls[0].stdout += '\u001b]52;c;c2VjcmV0\u0007\u001b[31mVisible\u001b[0m'
    view.calls[0].outputTruncated = true
    render(<LocalWorkflowExecutionView view={view} />)
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByRole('alert')).toHaveTextContent('capture is incomplete')
    expect(screen.getByText('A diagnostic warning')).toBeVisible()
    expect(screen.queryByText(/c2VjcmV0/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy stdout' }))
    await waitFor(() =>
      expect(writeClipboardText).toHaveBeenCalledWith(
        'First line\nUnicode café 🧭\nLast lineVisible'
      )
    )
    fireEvent.change(screen.getByLabelText('Search captured output'), { target: { value: 'café' } })
    expect(screen.getByText('Unicode café 🧭')).toBeVisible()
    expect(screen.queryByText('First line')).toBeNull()
    expect(screen.getByText('No matches.')).toBeVisible()
  })

  it('saves a finished answer and shows where it went', async () => {
    const view = completedWithResult()
    const onSaveResult = vi.fn().mockResolvedValue({
      saved: true,
      filePath: '/tmp/accepted-result.md',
      executionId: view.executionId,
      sha256: 'abc123'
    })
    render(<LocalWorkflowExecutionView view={view} onSaveResult={onSaveResult} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save as file…' }))
    await waitFor(() => expect(onSaveResult).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Saved to /tmp/accepted-result.md')).toBeVisible()
    expect(screen.queryByText(/SHA-256/)).toBeNull()
  })

  it('does not show an earlier execution receipt after the execution changes', async () => {
    const first = completedWithResult('First answer')
    let resolveSave!: (value: {
      saved: true
      filePath: string
      executionId: string
      sha256: string
    }) => void
    const onSaveResult = vi.fn(
      () =>
        new Promise<{ saved: true; filePath: string; executionId: string; sha256: string }>(
          (resolve) => {
            resolveSave = resolve
          }
        )
    )
    const { rerender } = render(
      <LocalWorkflowExecutionView view={first} onSaveResult={onSaveResult} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save as file…' }))
    rerender(
      <LocalWorkflowExecutionView
        view={{ ...first, executionId: 'execution-2' }}
        onSaveResult={onSaveResult}
      />
    )
    resolveSave({
      saved: true,
      filePath: '/tmp/first.md',
      executionId: first.executionId,
      sha256: 'a'
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save as file…' })).toBeEnabled())
    expect(screen.queryByText(/Saved to \/tmp\/first.md/)).toBeNull()
  })

  it('keeps legacy Discover evidence and the answer of an older one-stage projection', () => {
    const view = completedWithResult('No findings in the inspected scope.')
    view.preset = 'discover'
    view.stages = [{ id: 'discover', label: 'Discover', completed: 3, total: 3, failed: 0 }]
    view.findings = [
      {
        id: 'filtered-1',
        label: 'Possible retry issue',
        disposition: 'below threshold',
        markdown: 'Retained source evidence.',
        sources: [],
        verdicts: []
      }
    ]
    render(<LocalWorkflowExecutionView view={view} />)
    expect(screen.getByRole('list', { name: 'Stages' })).toHaveTextContent('Find')
    expect(
      within(screen.getByRole('region', { name: 'Report' })).getByText(
        'No findings in the inspected scope.'
      )
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Filtered 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Possible retry issue · below threshold' }))
    expect(screen.getByText('Retained source evidence.')).toBeVisible()
  })

  it("reads an older council's ballots as reviews, not raw data", () => {
    const view = workflowView()
    view.stages = view.stages.map((stage) =>
      stage.id === 'peer' ? { ...stage, completed: 1 } : stage
    )
    view.calls = [
      ...view.calls,
      {
        ...view.calls[0],
        id: 'peer/seat-1',
        stageId: 'peer',
        state: 'completed',
        resultMarkdown: '{"ranking":["Response B","Response C"]}'
      }
    ]
    view.council = {
      reviews: [
        {
          reviewer: 'Claude',
          ranking: ['Response B', 'Response C'],
          assessments: [
            { label: 'Response B', strengths: 'Names the retry path.', weaknesses: 'No tests.' }
          ]
        }
      ],
      ranking: [{ label: 'Response B', model: 'Codex', score: 0.25, votes: 2 }]
    }
    render(<LocalWorkflowExecutionView view={view} />)
    expect(screen.getByText('Claude assessed the other two answers')).toBeVisible()
    expect(screen.getByText(/Names the retry path\./)).toBeVisible()
    const table = screen.getByRole('region', { name: 'Combined peer ranking' })
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Response BCodex0.252')
    expect(screen.queryByText(/"ranking"/)).toBeNull()
  })

  it('follows up with the saved receipt when the answer is too long to inline', async () => {
    const view = completedWithResult('finding '.repeat(3_000))
    view.preset = 'discover'
    view.stages = [{ id: 'rank', label: 'Rank', completed: 1, total: 1, failed: 0 }]
    const receipt = {
      saved: true as const,
      filePath: '/tmp/discover-result.md',
      executionId: view.executionId,
      sha256: createHash('sha256').update(view.result!.markdown).digest('hex')
    }
    const onSaveResult = vi.fn().mockResolvedValue(receipt)
    let packet = ''
    const onFollowUp = vi.fn(
      async (prompt: string, saved?: Parameters<typeof localWorkflowFollowUpPrompt>[2]) => {
        packet = localWorkflowFollowUpPrompt(view, prompt, saved)
      }
    )
    render(
      <LocalWorkflowExecutionView view={view} onSaveResult={onSaveResult} onFollowUp={onFollowUp} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save as file…' }))
    await waitFor(() => expect(screen.getByText('Saved to /tmp/discover-result.md')).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: 'Ask a follow-up' }))
    fireEvent.change(screen.getByLabelText('Follow up with Discover'), {
      target: { value: 'Explain the top finding' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send follow-up' }))
    await waitFor(() => expect(onFollowUp).toHaveBeenCalledWith('Explain the top finding', receipt))
    expect(packet).toContain('/tmp/discover-result.md')
  })

  it('offers to ask again after a run that ended without an answer', async () => {
    const view = workflowView()
    view.state = 'cancelled'
    view.actions = []
    const onNewTurn = vi.fn().mockResolvedValue(undefined)
    render(<LocalWorkflowExecutionView view={view} onNewTurn={onNewTurn} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask the council again' }))
    await waitFor(() => expect(onNewTurn).toHaveBeenCalledTimes(1))
  })
})

/**
 * Why: live acceptance found runs recorded by an earlier build as "Needs you · 0 agents" under
 * "Workflow evidence requires recovery.", with no reason and nothing to do about it.
 */
describe('a run this version cannot reopen', () => {
  const unreadable = () => ({
    ...workflowView(),
    state: 'cancelled' as const,
    prompt: 'What are the riskiest defects?',
    actions: [],
    stages: [],
    calls: [],
    unreadable: 'earlier-version' as const,
    error: 'Workflow recovery is blocked'
  })

  it('keeps the question, says why in plain words and reads as stopped', () => {
    render(<LocalWorkflowExecutionView view={unreadable()} onRunAgain={vi.fn()} />)
    expect(screen.getByLabelText('Your request')).toHaveTextContent(
      'What are the riskiest defects?'
    )
    expect(screen.getByRole('status')).toHaveTextContent('Stopped')
    expect(screen.getByRole('status')).not.toHaveTextContent('Needs you')
    expect(screen.getByRole('status')).not.toHaveTextContent('0 agents')
    expect(
      screen.getByText(
        "This run was recorded by an earlier version and can't be reopened. Start it again to get a fresh result."
      )
    ).toBeVisible()
    expect(screen.queryByText(/recovery is blocked/)).toBeNull()
  })

  it('keeps the raw error behind Details and offers Run again', () => {
    const onRunAgain = vi.fn()
    render(<LocalWorkflowExecutionView view={unreadable()} onRunAgain={onRunAgain} />)
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('Reported: Workflow recovery is blocked')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }))
    expect(onRunAgain).toHaveBeenCalledTimes(1)
  })

  it('shows no empty request bubble without a question, and still offers Run again', () => {
    // Why: the conversation reruns with the tab's own copy of the question when the run lost it.
    const onRunAgain = vi.fn()
    render(
      <LocalWorkflowExecutionView view={{ ...unreadable(), prompt: '' }} onRunAgain={onRunAgain} />
    )
    expect(screen.queryByLabelText('Your request')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }))
    expect(onRunAgain).toHaveBeenCalledTimes(1)
  })

  it('says damaged records are damaged, not that an earlier version wrote them', () => {
    render(
      <LocalWorkflowExecutionView
        view={{
          ...unreadable(),
          unreadable: 'damaged',
          error: 'Workflow result integrity failure: answer/seat-1'
        }}
        onRunAgain={vi.fn()}
      />
    )
    expect(
      screen.getByText(
        "This run's saved records are damaged, so it can't be reopened. Start it again to get a fresh result."
      )
    ).toBeVisible()
    expect(screen.queryByText(/earlier version/)).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Stopped')
    expect(screen.getByRole('button', { name: 'Run again' })).toBeVisible()
  })
})
