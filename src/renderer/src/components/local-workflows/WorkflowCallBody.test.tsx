// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workflowCall } from './local-workflow-run.fixtures'
import { activityLine, callEndedText, WorkflowCallBody } from './WorkflowCallBody'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
afterEach(cleanup)

/**
 * Why these tests exist: every wait read "Waiting for a free slot…" even when a Codex call was
 * held by its account lock, raw codes reached the main path, and Details dumped per-token NDJSON.
 */
describe('what a waiting call waits for', () => {
  it('names the provider account when the account is busy, and a slot otherwise', () => {
    const waiting = (reason?: 'slot' | 'account') =>
      workflowCall('verify/f1/correctness', 'seat-2', {
        state: 'queued',
        live: { phase: 'waiting', ...(reason ? { reason } : {}) }
      })
    expect(activityLine(waiting('account'))).toBe('Waiting for the Codex account…')
    expect(activityLine(waiting('slot'))).toBe('Waiting for a free slot…')
    // Older hosts send no reason: a slot, as before.
    expect(activityLine(waiting())).toBe('Waiting for a free slot…')
    const grok = workflowCall('find/r1/0/security', 'seat-3', {
      state: 'queued',
      live: { phase: 'waiting', reason: 'account' }
    })
    expect(activityLine(grok)).toBe('Waiting for the Grok account…')
    expect(activityLine({ ...grok, agent: undefined })).toBe('Waiting for its account to be free…')
  })

  it('shows the account wait on the call itself', () => {
    render(
      <WorkflowCallBody
        call={workflowCall('answer/seat-2', 'seat-2', {
          state: 'queued',
          live: { phase: 'waiting', reason: 'account' }
        })}
        subject="GPT-5.6 Sol"
      />
    )
    expect(screen.getByText('Waiting for the Codex account…')).toBeVisible()
  })
})

describe('the live tail', () => {
  it('shows Codex reasoning headings in weight, never with raw ** markers', () => {
    render(
      <WorkflowCallBody
        call={workflowCall('answer/seat-2', 'seat-2', {
          state: 'running',
          live: {
            phase: 'running',
            tail: '**Identifying concurrency flaws**\n\nI see a race in `save`.'
          }
        })}
        subject="GPT-5.6 Sol"
      />
    )
    expect(screen.getByText('Identifying concurrency flaws').tagName).toBe('STRONG')
    expect(screen.getByText('save').tagName).toBe('CODE')
    expect(screen.queryByText(/\*\*/)).toBeNull()
  })
})

describe('why a call ended', () => {
  it('reads a raw code as plain words and keeps the original in Details', async () => {
    const call = workflowCall('answer/seat-2', 'seat-2', {
      state: 'failed',
      error: 'agent_prompt_stalled'
    })
    expect(callEndedText(call, 'GPT-5.6 Sol')).toBe(
      "GPT-5.6 Sol didn't finish: The agent stopped responding before it started the task."
    )
    const onReadCall = vi.fn().mockResolvedValue({ stdout: '', stderr: '', outputTruncated: false })
    render(<WorkflowCallBody call={call} subject="GPT-5.6 Sol" onReadCall={onReadCall} />)
    expect(screen.queryByText(/agent_prompt_stalled/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(await screen.findByText('Reported: agent_prompt_stalled')).toBeVisible()
  })
})

describe('Details', () => {
  const stream = [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'Th' } } },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }] }
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Found the bug.' }] } }
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')

  it('lists what the agent did and keeps the raw stream behind a toggle', async () => {
    const onReadCall = vi.fn().mockResolvedValue({
      stdout: stream,
      stderr: '',
      outputTruncated: false
    })
    render(
      <WorkflowCallBody
        call={workflowCall('answer/seat-1', 'seat-1', { resultMarkdown: 'Found the bug.' })}
        subject="Claude Opus 5"
        onReadCall={onReadCall}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    const activity = await screen.findByRole('list', { name: 'Activity' })
    expect(within(activity).getByText('Read src/a.ts')).toBeVisible()
    expect(within(activity).getByText('Found the bug.')).toBeVisible()
    expect(screen.queryByText(/content_block_delta/)).toBeNull()
    expect(screen.queryByRole('region', { name: 'stdout' })).toBeNull()
    const raw = screen.getByRole('button', { name: 'Raw output' })
    expect(raw).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(raw)
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'stdout' })).toHaveTextContent(
        'content_block_delta'
      )
    )
  })
})
