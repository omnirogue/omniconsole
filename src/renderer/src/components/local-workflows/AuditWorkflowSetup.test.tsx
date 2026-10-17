// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuditWorkflowSetup } from './AuditWorkflowSetup'
import { createLocalWorkflowAuditDraft } from '../../../../shared/workflow-audit-draft'
import { workflowCatalog, workflowDraft } from './local-workflow-ui.fixtures'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, options?: Record<string, string>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => options?.[key] ?? key)
}))
afterEach(cleanup)

function readyDraft() {
  const draft = createLocalWorkflowAuditDraft('Find repeated friction')
  draft.audit!.sourceFile = '/corpus/records.jsonl'
  return draft
}

describe('Audit setup', () => {
  it.each(['gpt-6-luna', 'gpt-5.6-luna'])(
    'starts a new Audit with only native Codex %s on the selected account',
    async (model) => {
      const catalog = workflowCatalog.map((entry) =>
        entry.agent === 'codex'
          ? {
              ...entry,
              models: [
                ...entry.models,
                {
                  resolvedModelId: model,
                  lineage: 'openai' as const,
                  catalog: { id: model, label: 'Luna', isDefault: false, options: [] }
                }
              ]
            }
          : entry
      )
      const start = vi.fn().mockResolvedValue(undefined)
      render(
        <AuditWorkflowSetup
          draft={readyDraft()}
          team={workflowDraft().seats}
          catalog={catalog}
          maxConcurrency={4}
          onChange={vi.fn()}
          onStart={start}
        />
      )
      expect(screen.getByRole('checkbox', { name: 'Use Codex' })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: 'Use Claude' })).not.toBeChecked()
      expect(screen.getByRole('checkbox', { name: 'Use Grok' })).not.toBeChecked()
      expect(screen.getByLabelText('Codex')).toHaveTextContent('Luna')
      fireEvent.click(screen.getByRole('button', { name: 'Run Audit' }))
      await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
      expect(start.mock.calls[0][0].seats).toEqual([
        { ...workflowDraft().seats[1], model, effort: undefined }
      ])
    }
  )

  it('requires an explicit API-route selection when no native account is available', async () => {
    const seat = { id: 'api', agent: 'openrouter' as const, accountId: 'system:openrouter' }
    const catalog = [
      {
        ...workflowCatalog[1],
        agent: seat.agent,
        accountId: seat.accountId,
        models: [
          {
            resolvedModelId: 'openai/gpt-6-luna',
            lineage: 'openai' as const,
            catalog: {
              id: 'openai/gpt-6-luna',
              label: 'Luna via OpenRouter',
              isDefault: true,
              options: []
            }
          }
        ]
      }
    ]
    const start = vi.fn().mockResolvedValue(undefined)
    function Setup() {
      const [draft, change] = useState(readyDraft())
      return (
        <AuditWorkflowSetup
          draft={draft}
          team={[seat]}
          catalog={catalog}
          maxConcurrency={1}
          onChange={change}
          onStart={start}
        />
      )
    }
    render(<Setup />)
    expect(screen.getByRole('checkbox', { name: 'Use OpenRouter' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Run Audit' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use OpenRouter' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run Audit' }))
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    expect(start.mock.calls[0][0].seats).toEqual([{ ...seat, model: 'openai/gpt-6-luna' }])
  })

  it('requires explicit provider selection when no native Luna model is advertised', () => {
    render(
      <AuditWorkflowSetup
        draft={readyDraft()}
        team={workflowDraft().seats}
        catalog={workflowCatalog}
        maxConcurrency={4}
        onChange={vi.fn()}
        onStart={vi.fn()}
      />
    )
    expect(screen.getByRole('checkbox', { name: 'Use Codex' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Use Claude' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Use Grok' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Run Audit' })).toBeDisabled()
  })

  it('requires a question and source, then starts with the displayed host models and local access', async () => {
    const start = vi.fn().mockResolvedValue(undefined)
    function Setup() {
      const draft = createLocalWorkflowAuditDraft()
      draft.seats = workflowDraft().seats
      const [current, change] = useState(draft)
      return (
        <AuditWorkflowSetup
          draft={current}
          team={workflowDraft().seats}
          catalog={workflowCatalog}
          maxConcurrency={4}
          onChange={change}
          onStart={start}
        />
      )
    }
    render(<Setup />)
    expect(start).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Run Audit' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('What should the audit find out?'), {
      target: { value: 'Find repeated friction' }
    })
    expect(screen.getByRole('button', { name: 'Run Audit' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Records file'), {
      target: { value: '/corpus/records.jsonl' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Run Audit' }))
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    expect(start.mock.calls[0][0]).toMatchObject({
      prompt: 'Find repeated friction',
      audit: { version: 1, sourceFile: '/corpus/records.jsonl', format: 'sources-jsonl' },
      access: 'frozen',
      runsOn: 'local',
      concurrency: 4,
      seats: workflowDraft().seats
    })
    expect(start.mock.calls[0][0].graph).toBeUndefined()
  })

  it('locks an uncertain Start and retries the exact persisted draft', async () => {
    const draft = readyDraft()
    draft.seats = workflowDraft().seats
    draft.concurrency = 3
    const start = vi.fn().mockResolvedValue(undefined)
    render(
      <AuditWorkflowSetup
        draft={draft}
        team={[]}
        catalog={workflowCatalog}
        maxConcurrency={1}
        recoveringStart
        onChange={vi.fn()}
        onStart={start}
      />
    )
    expect(screen.getByLabelText('Records file')).toBeDisabled()
    expect(screen.getByLabelText('What should the audit find out?')).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Use Claude' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry Start' }))
    await waitFor(() => expect(start).toHaveBeenCalledWith(draft))
    expect(start.mock.calls[0][0]).toBe(draft)
  })

  it('keeps launch errors visible and prevents duplicate submissions while one is pending', async () => {
    let reject!: (error: Error) => void
    const start = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        })
    )
    render(
      <AuditWorkflowSetup
        draft={{ ...readyDraft(), seats: workflowDraft().seats }}
        team={workflowDraft().seats}
        catalog={workflowCatalog}
        maxConcurrency={4}
        onChange={vi.fn()}
        onStart={start}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run Audit' }))
    expect(screen.getByRole('button', { name: 'Run Audit' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Run Audit' }))
    expect(start).toHaveBeenCalledTimes(1)
    reject(new Error('The records file could not be read.'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The records file could not be read.'
    )
    expect(screen.getByLabelText('Records file')).not.toBeDisabled()
  })

  it('requires a model choice when the host has no default instead of choosing the first', () => {
    const catalog = workflowCatalog.map((entry) => ({
      ...entry,
      models: entry.models.map((model) => ({
        ...model,
        catalog: { ...model.catalog, isDefault: false }
      }))
    }))
    render(
      <AuditWorkflowSetup
        draft={readyDraft()}
        team={[{ id: 'claude', agent: 'claude', accountId: 'claude-work' }]}
        catalog={catalog}
        maxConcurrency={4}
        onChange={vi.fn()}
        onStart={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Run Audit' })).toBeDisabled()
    expect(screen.getByText('Choose a model')).toBeVisible()
  })

  it('starts with only the selected OpenRouter seat and its chosen model', async () => {
    const openrouter = {
      id: 'openrouter-seat',
      agent: 'openrouter' as const,
      accountId: 'openrouter-work',
      model: 'anthropic/claude-sonnet-4.5'
    }
    const catalog = [
      ...workflowCatalog,
      {
        agent: 'openrouter' as const,
        accountId: 'openrouter-work',
        accountLabel: 'OpenRouter',
        accountHome: '/accounts/openrouter',
        policyRevision: 'fixture-v1',
        models: [
          {
            resolvedModelId: 'anthropic/claude-sonnet-4.5',
            lineage: 'anthropic' as const,
            catalog: {
              id: openrouter.model,
              label: 'Claude Sonnet 4.5',
              isDefault: true,
              options: []
            }
          },
          {
            resolvedModelId: 'meta-llama/llama-3.3-70b-instruct:free',
            lineage: 'anthropic' as const,
            catalog: {
              id: 'meta-llama/llama-3.3-70b-instruct:free',
              label: 'Llama 3.3 70B Free',
              isDefault: false,
              options: []
            }
          }
        ]
      }
    ]
    const start = vi.fn().mockResolvedValue(undefined)
    function Setup() {
      const [draft, change] = useState({
        ...readyDraft(),
        seats: [workflowDraft().seats[0], openrouter]
      })
      return (
        <AuditWorkflowSetup
          draft={draft}
          team={[workflowDraft().seats[0], openrouter]}
          catalog={catalog}
          maxConcurrency={4}
          onChange={change}
          onStart={start}
        />
      )
    }
    render(<Setup />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use Claude' }))
    fireEvent.click(screen.getByLabelText('OpenRouter'))
    fireEvent.click(screen.getByRole('option', { name: 'Llama 3.3 70B Free' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run Audit' }))
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    expect(start.mock.calls[0][0].seats).toEqual([
      { ...openrouter, model: 'meta-llama/llama-3.3-70b-instruct:free' }
    ])
  })

  it('keeps one provider selected and disables Start for a model outside the catalog', () => {
    const draft = readyDraft()
    draft.seats = [
      { id: 'claude', agent: 'claude', accountId: 'claude-work', model: 'stale-model' }
    ]
    render(
      <AuditWorkflowSetup
        draft={draft}
        team={[{ id: 'claude', agent: 'claude', accountId: 'claude-work' }]}
        catalog={workflowCatalog}
        maxConcurrency={4}
        onChange={vi.fn()}
        onStart={vi.fn()}
      />
    )
    expect(screen.getByRole('checkbox', { name: 'Use Claude' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run Audit' })).toBeDisabled()
  })
})
