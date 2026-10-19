// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EvolveJudgeAuditInspector } from './EvolveJudgeAuditInspector'
import {
  DEFAULT_JUDGE_AUDIT_LABELS,
  familyList,
  flagKeys,
  formatShare,
  interpolate,
  isFlagged,
  judgmentFlags,
  resolveJudgeAuditLabels,
  summarizeJudgeAudit,
  swapState,
  type EvolveJudgment
} from './evolve-judge-audit-helpers'

afterEach(cleanup)

function judgment(id: string, overrides: Partial<EvolveJudgment> = {}): EvolveJudgment {
  return {
    id,
    judgeLabel: `${id} judge`,
    judgeFamily: 'openai',
    candidateFamily: 'anthropic',
    shownFirst: 'baseline',
    verdict: 'candidate',
    swappedVerdict: 'candidate',
    confidence: 0.8,
    rationale: `${id} rationale`,
    ...overrides
  }
}

// An Anthropic candidate: three independent judges, one same-family judge, one order-dependent one.
function panel(): EvolveJudgment[] {
  return [
    judgment('astra', { judgeFamily: 'openai', confidence: 0.82 }),
    judgment('argon', { judgeFamily: 'google', shownFirst: 'candidate' }),
    judgment('grok', {
      judgeFamily: 'xai',
      verdict: 'baseline',
      swappedVerdict: null,
      confidence: null,
      rationale: null
    }),
    judgment('opus', { judgeFamily: 'anthropic' }),
    judgment('kimi', { judgeFamily: 'moonshot', swappedVerdict: 'baseline' })
  ]
}

describe('judgment flags', () => {
  it('flags a judge from the candidate family and a verdict that follows the blind order', () => {
    expect(judgmentFlags(judgment('a', { judgeFamily: 'anthropic' }))).toEqual({
      selfPreference: true,
      positionFlip: false
    })
    expect(judgmentFlags(judgment('b', { swappedVerdict: 'tie' }))).toEqual({
      selfPreference: false,
      positionFlip: true
    })
    expect(isFlagged(judgment('c'))).toBe(false)
    expect(
      flagKeys(judgment('d', { judgeFamily: 'anthropic', swappedVerdict: 'baseline' }))
    ).toEqual(['selfPreference', 'positionFlip'])
  })

  it('treats a missing swap probe as not probed rather than consistent', () => {
    expect(swapState(judgment('a', { swappedVerdict: null }))).toBe('notProbed')
    expect(swapState(judgment('b', { swappedVerdict: undefined }))).toBe('notProbed')
    expect(swapState(judgment('c'))).toBe('consistent')
    expect(swapState(judgment('d', { swappedVerdict: 'baseline' }))).toBe('flipped')
    expect(judgmentFlags(judgment('e', { swappedVerdict: null })).positionFlip).toBe(false)
  })
})

describe('summarizeJudgeAudit', () => {
  it('counts only independent, order-consistent verdicts', () => {
    const summary = summarizeJudgeAudit(panel())
    expect(summary).toMatchObject({
      total: 5,
      counted: 3,
      candidate: 2,
      baseline: 1,
      tie: 0,
      selfPreference: 1,
      positionFlips: 1,
      independentFamilies: ['openai', 'google', 'xai'],
      majority: 'candidate',
      status: 'passed'
    })
    expect(summary.agreement).toBeCloseTo(2 / 3)
  })

  it('fails a level split, because the incumbent keeps the title on a tie', () => {
    const summary = summarizeJudgeAudit([
      judgment('a', { judgeFamily: 'openai', verdict: 'candidate', swappedVerdict: 'candidate' }),
      judgment('b', { judgeFamily: 'google', verdict: 'baseline', swappedVerdict: 'baseline' })
    ])
    expect(summary.status).toBe('failed')
    expect(summary.majority).toBeNull()
    expect(summary.agreement).toBeNull()
  })

  it('fails when the judges only call ties', () => {
    const ties = ['openai', 'google', 'xai'] as const
    const summary = summarizeJudgeAudit(
      ties.map((family) =>
        judgment(family, { judgeFamily: family, verdict: 'tie', swappedVerdict: 'tie' })
      )
    )
    expect(summary).toMatchObject({ majority: 'tie', agreement: 1, status: 'failed' })
  })

  it('is inconclusive below the required number of independent families', () => {
    const sameFamily = [judgment('a'), judgment('b')]
    expect(summarizeJudgeAudit(sameFamily).status).toBe('inconclusive')
    expect(summarizeJudgeAudit(sameFamily, 1).status).toBe('passed')
    expect(summarizeJudgeAudit(sameFamily, 0).status).toBe('passed')
  })

  it('is inconclusive when every verdict is excluded, and not run when there are none', () => {
    const excluded = summarizeJudgeAudit([judgment('self', { judgeFamily: 'anthropic' })])
    expect(excluded).toMatchObject({ counted: 0, majority: null, status: 'inconclusive' })
    expect(summarizeJudgeAudit([])).toMatchObject({ total: 0, status: 'not_run' })
  })
})

describe('formatting helpers', () => {
  it('formats shares and clamps them to 0–100%', () => {
    expect(formatShare(2 / 3)).toBe('67%')
    expect(formatShare(1.4)).toBe('100%')
    expect(formatShare(null)).toBe('—')
    expect(formatShare(Number.NaN)).toBe('—')
  })

  it('interpolates only own values', () => {
    expect(interpolate('{{a}} and {{b}}', { a: 1, b: 'two' })).toBe('1 and two')
    expect(interpolate('{{missing}}|{{constructor}}', {})).toBe('|')
  })

  it('lists family names, or a dash when none counted', () => {
    const names = DEFAULT_JUDGE_AUDIT_LABELS.family
    expect(familyList(['openai', 'xai'], names)).toBe('OpenAI, xAI')
    expect(familyList([], names)).toBe('—')
  })

  it('merges label overrides key by key without touching the defaults', () => {
    const labels = resolveJudgeAuditLabels({ title: 'Audit', status: { passed: 'OK' } })
    expect(labels.title).toBe('Audit')
    expect(labels.status).toEqual({ ...DEFAULT_JUDGE_AUDIT_LABELS.status, passed: 'OK' })
    expect(labels.columns).toEqual(DEFAULT_JUDGE_AUDIT_LABELS.columns)
    expect(DEFAULT_JUDGE_AUDIT_LABELS.status.passed).toBe('Passed')
  })
})

describe('EvolveJudgeAuditInspector', () => {
  it('shows the status, the summary and every judgment with its flags', () => {
    render(<EvolveJudgeAuditInspector judgments={panel()} />)
    const region = screen.getByRole('region', { name: 'Judge audit' })
    expect(region).toHaveAttribute('data-status', 'passed')
    expect(screen.getByTestId('evolve-judge-audit-status')).toHaveTextContent('Passed')
    const summary = within(screen.getByRole('list', { name: 'Audit summary' }))
    expect(summary.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Candidate 2 · Baseline 1 · Tie 0 (3 of 5 counted)',
      'Agreement 67%',
      'Independent families: OpenAI, Google, xAI',
      '1 same-family, 1 order-dependent'
    ])
    const table = screen.getByRole('table', { name: 'Blind judge verdicts' })
    expect(within(table).getAllByRole('row')).toHaveLength(6)

    const opus = screen.getByTestId('evolve-judgment-opus')
    expect(opus).toHaveAttribute('data-flagged', 'true')
    expect(within(opus).getByText('Same family')).toBeInTheDocument()
    const kimi = screen.getByTestId('evolve-judgment-kimi')
    expect(within(kimi).getByText('Order-dependent')).toBeInTheDocument()
    expect(within(kimi).getByText('Flipped')).toHaveAttribute('data-swap', 'flipped')
    const grok = screen.getByTestId('evolve-judgment-grok')
    expect(grok).toHaveAttribute('data-flagged', 'false')
    expect(within(grok).getByText('Not probed')).toBeInTheDocument()
    expect(within(grok).getByText('—')).toBeInTheDocument()
    expect(within(grok).getByText('Baseline')).toBeInTheDocument()
    const argon = screen.getByTestId('evolve-judgment-argon')
    expect(within(argon).getByText('A = candidate')).toBeInTheDocument()
    expect(within(argon).getByText('None')).toBeInTheDocument()
  })

  it('filters to flagged judgments and says so when none are flagged', () => {
    const { rerender } = render(<EvolveJudgeAuditInspector judgments={panel()} />)
    const flaggedOnly = screen.getByRole('button', { name: 'Flagged only' })
    expect(flaggedOnly).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(flaggedOnly)
    expect(flaggedOnly).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('evolve-judgment-astra')).toBeNull()
    expect(screen.getByTestId('evolve-judgment-opus')).toBeInTheDocument()
    expect(screen.getByTestId('evolve-judgment-kimi')).toBeInTheDocument()

    rerender(
      <EvolveJudgeAuditInspector
        judgments={[judgment('a'), judgment('b', { judgeFamily: 'xai' })]}
      />
    )
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('No judgment is flagged.')
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByTestId('evolve-judgment-a')).toBeInTheDocument()
  })

  it('opens one rationale at a time and falls back when a judge gave none', () => {
    render(<EvolveJudgeAuditInspector judgments={panel()} />)
    const astraToggle = within(screen.getByTestId('evolve-judgment-astra')).getByRole('button')
    expect(astraToggle).toHaveTextContent('Show rationale')
    expect(astraToggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(astraToggle)
    const rationale = screen.getByTestId('evolve-judgment-rationale-astra')
    expect(astraToggle).toHaveAttribute('aria-expanded', 'true')
    expect(astraToggle).toHaveTextContent('Hide rationale')
    expect(astraToggle.getAttribute('aria-controls')).toBe(rationale.id)
    expect(rationale).toHaveTextContent('Rationale from astra judge')
    expect(rationale).toHaveTextContent('astra rationale')

    fireEvent.click(within(screen.getByTestId('evolve-judgment-grok')).getByRole('button'))
    expect(screen.queryByTestId('evolve-judgment-rationale-astra')).toBeNull()
    expect(screen.getByTestId('evolve-judgment-rationale-grok')).toHaveTextContent(
      'This judge gave no rationale.'
    )
    fireEvent.click(within(screen.getByTestId('evolve-judgment-grok')).getByRole('button'))
    expect(screen.queryByTestId('evolve-judgment-rationale-grok')).toBeNull()
  })

  it('shows the not-run state without a table', () => {
    render(<EvolveJudgeAuditInspector judgments={[]} />)
    expect(screen.getByTestId('evolve-judge-audit-status')).toHaveTextContent('Not run')
    expect(screen.getByRole('status')).toHaveTextContent('No judge has audited this run yet.')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('explains an inconclusive audit with the required family count', () => {
    render(
      <EvolveJudgeAuditInspector
        judgments={[judgment('a'), judgment('b')]}
        minIndependentFamilies={3}
      />
    )
    expect(screen.getByTestId('evolve-judge-audit-status')).toHaveTextContent('Inconclusive')
    expect(screen.getByRole('note')).toHaveTextContent(
      'Needs verdicts from at least 3 independent families.'
    )
  })

  it('renders caller labels over the defaults', () => {
    render(
      <EvolveJudgeAuditInspector
        judgments={panel()}
        labels={{
          title: 'Auditoría de jueces',
          status: { passed: 'Aprobada' },
          columns: { judge: 'Juez' },
          family: { openai: 'OpenAI (ES)' }
        }}
      />
    )
    expect(screen.getByRole('region', { name: 'Auditoría de jueces' })).toBeInTheDocument()
    expect(screen.queryByText('Judge audit')).toBeNull()
    expect(screen.getByTestId('evolve-judge-audit-status')).toHaveTextContent('Aprobada')
    expect(screen.getByRole('columnheader', { name: 'Juez' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Verdict' })).toBeInTheDocument()
    expect(
      within(screen.getByTestId('evolve-judgment-astra')).getByText('OpenAI (ES)')
    ).toBeInTheDocument()
  })
})
