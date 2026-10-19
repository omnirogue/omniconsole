// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvolveRunRecord } from '../../../../shared/evolve-workflow'
import { createEvolveDraft } from '../../../../shared/evolve-workflow-draft'
import { EvolveWarmStartModal, type EvolveWarmStartModalProps } from './EvolveWarmStartModal'
import {
  createEvolveWarmStartDraft,
  defaultEvolveWarmStartLabels as labels,
  findEvolveWarmStartWinner
} from './evolve-warm-start-helpers'
import { evolveRunFixture } from './evolve-run.fixtures'

afterEach(cleanup)

const worktreeId = 'folder::/workspace'
const draft = createEvolveDraft()
const context = { ...draft, worktreeId }

function completedRun(patch: Partial<EvolveRunRecord> = {}) {
  return evolveRunFixture({ state: 'done', worktreeId, ...patch })
}

function renderModal(patch: Partial<EvolveWarmStartModalProps> = {}) {
  const props: EvolveWarmStartModalProps = {
    open: true,
    worktreeId,
    runs: [completedRun()],
    draft,
    onOpenChange: vi.fn(),
    onConfirm: vi.fn(),
    ...patch
  }
  return { props, ...render(<EvolveWarmStartModal {...props} />) }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('warm-start selection', () => {
  it('uses the highest completed local or fleet score without changing the input order', () => {
    const lower = completedRun({ id: 'lower' })
    const higher = completedRun({
      id: 'higher',
      ledger: {
        ...lower.ledger!,
        summary: { best_candidate_id: 'champion', best_combined_score: 0.92 }
      }
    })
    const runs = [lower, higher]
    expect(findEvolveWarmStartWinner(runs, context)).toMatchObject({
      runId: 'higher',
      candidateId: 'champion',
      bestScore: 0.92,
      seedValue: draft.target
    })
    expect(runs.map((run) => run.id)).toEqual(['lower', 'higher'])
  })

  it('does not fall back across workspaces, targets, hosted runs or incomplete runs', () => {
    const request = completedRun().request
    const runs = [
      completedRun({ worktreeId: 'other' }),
      completedRun({ request: { ...request, target: 'ads' } }),
      completedRun({ request: { ...request, runsOn: 'hosted' } }),
      completedRun({ request: { ...request, executionTier: 'hosted_pro' } }),
      completedRun({ cloudRunId: 'cloud-run' }),
      completedRun({ state: 'running' }),
      completedRun({ state: 'failed' }),
      completedRun({ ledger: undefined })
    ]
    expect(findEvolveWarmStartWinner(runs, context)).toBeUndefined()
  })

  it('matches a custom spec path and keeps its run ID as the seed', () => {
    const specDraft = {
      ...draft,
      target: 'spec' as const,
      specPath: 'specs/one.yaml'
    }
    const wrong = completedRun({
      request: { target: 'spec', specPath: 'specs/two.yaml' }
    })
    const matching = completedRun({
      request: { target: 'spec', specPath: specDraft.specPath }
    })
    expect(findEvolveWarmStartWinner([wrong], { ...specDraft, worktreeId })).toBeUndefined()
    expect(
      findEvolveWarmStartWinner([wrong, matching], {
        ...specDraft,
        worktreeId
      })
    ).toMatchObject({
      runId: matching.id,
      seedValue: matching.id
    })
  })

  it('rejects non-finite scores and blank candidates but allows an unknown score', () => {
    const ledger = completedRun().ledger!
    const badScore = completedRun({
      ledger: {
        ...ledger,
        best_so_far: { ...ledger.best_so_far!, combined_score: Number.NaN }
      }
    })
    const blank = completedRun({
      ledger: {
        ...ledger,
        best_so_far: { ...ledger.best_so_far!, candidate_id: ' ' }
      }
    })
    const unknown = completedRun({
      ledger: {
        ...ledger,
        best_so_far: { ...ledger.best_so_far!, combined_score: null }
      }
    })
    expect(findEvolveWarmStartWinner([badScore, blank], context)).toBeUndefined()
    expect(findEvolveWarmStartWinner([unknown], context)?.bestScore).toBeNull()
  })

  it('preserves the draft settings, clears fleet routing and recomputes the hosted estimate', () => {
    const original = {
      ...draft,
      executionTier: 'hosted_pro' as const,
      iterations: '4',
      usdCap: '2',
      runsOnHost: 'fleet-host',
      runsOnHostId: 'ssh:fleet-host',
      estimatedCredits: 999
    }
    const winner = findEvolveWarmStartWinner([completedRun()], context)!
    expect(createEvolveWarmStartDraft(original, winner)).toMatchObject({
      target: draft.target,
      iterations: '4',
      usdCap: '2',
      runsOn: 'hosted',
      executionTier: 'hosted_pro',
      estimatedCredits: 65,
      runsOnHost: undefined,
      runsOnHostId: undefined,
      seedFrom: draft.target,
      seedFromRunId: winner.runId
    })
    expect(original.runsOnHost).toBe('fleet-host')
    expect(original.estimatedCredits).toBe(999)
  })
})

describe('EvolveWarmStartModal', () => {
  it('renders nothing while closed', () => {
    renderModal({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the source, score, hosted tier and credit estimate before confirmation', () => {
    renderModal()
    expect(screen.getByRole('dialog', { name: labels.title })).toBeVisible()
    expect(screen.getByText('run_7f3a')).toBeVisible()
    expect(screen.getByText('cand_best')).toBeVisible()
    expect(screen.getByText('0.8123')).toBeVisible()
    expect(screen.getByText(labels.hostedSuperIntelligence)).toBeVisible()
    expect(screen.getByText('338')).toBeVisible()
    expect(screen.getByText(labels.auditHint)).toBeVisible()
  })

  it('disables submission without a matching winner', () => {
    const { props } = renderModal({ runs: [] })
    expect(screen.getByRole('status')).toHaveTextContent(labels.empty)
    expect(screen.getByRole('button', { name: labels.confirm })).toBeDisabled()
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('confirms the seeded draft once, blocks dismissal while pending, then closes', async () => {
    const task = deferred()
    const { props } = renderModal({ onConfirm: vi.fn(() => task.promise) })
    fireEvent.click(screen.getByRole('button', { name: labels.confirm }))
    expect(screen.getByRole('button', { name: labels.pending })).toBeDisabled()
    expect(screen.getByRole('button', { name: labels.cancel })).toBeDisabled()
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(props.onOpenChange).not.toHaveBeenCalled()
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        runsOn: 'hosted',
        executionTier: 'hosted_super_intelligence',
        seedFrom: draft.target,
        seedFromRunId: completedRun().id,
        estimatedCredits: 338
      })
    )
    await act(async () => task.resolve())
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows a retryable failure without dismissing the modal', async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error('failure'))
      .mockResolvedValueOnce(undefined)
    const { props } = renderModal({ onConfirm })
    fireEvent.click(screen.getByRole('button', { name: labels.confirm }))
    expect(await screen.findByRole('alert')).toHaveTextContent(labels.error)
    expect(props.onOpenChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: labels.confirm }))
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false))
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })

  it('cancels without starting a run', () => {
    const { props } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: labels.cancel }))
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores a stale %s after closing and reopening',
    async (settle) => {
      const task = deferred()
      const { props, rerender } = renderModal({
        onConfirm: vi.fn(() => task.promise)
      })
      fireEvent.click(screen.getByRole('button', { name: labels.confirm }))
      rerender(<EvolveWarmStartModal {...props} open={false} />)
      rerender(<EvolveWarmStartModal {...props} />)
      await act(async () => {
        if (settle === 'resolve') {
          task.resolve()
        } else {
          task.reject(new Error('stale failure'))
        }
      })
      expect(props.onOpenChange).not.toHaveBeenCalled()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByRole('button', { name: labels.confirm })).toBeEnabled()
    }
  )

  it('accepts translated text and number formatters through props', () => {
    const translated = Object.fromEntries(
      Object.entries(labels).map(([key, value]) => [
        key,
        typeof value === 'string' ? `translated:${key}` : value
      ])
    ) as typeof labels
    const { props } = renderModal({
      labels: {
        ...translated,
        formatScore: () => 'score-value',
        formatCount: () => 'count-value'
      }
    })
    expect(screen.getByRole('dialog', { name: translated.title })).toBeVisible()
    expect(screen.getByText('score-value')).toBeVisible()
    expect(screen.getAllByText('count-value')).toHaveLength(2)
    for (const value of Object.values(labels)) {
      if (typeof value === 'string') {
        expect(screen.queryByText(value, { exact: true })).toBeNull()
      }
    }
    fireEvent.click(screen.getByRole('button', { name: translated.cancel }))
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })
})
