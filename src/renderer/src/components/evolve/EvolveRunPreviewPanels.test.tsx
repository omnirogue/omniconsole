// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EvolveRunPreviewPanels } from './EvolveRunPreviewPanels'
import { evolveRunFixture } from './evolve-run.fixtures'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
const state = { settings: { experimentalOmniSiPreviews: false } }

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))

const hostedRun = () => evolveRunFixture({ cloudRunId: 'cloud-run-1' })
const judgment = {
  id: 'j1',
  judgeLabel: 'GPT-6 Astra',
  judgeFamily: 'openai',
  candidateFamily: 'anthropic',
  shownFirst: 'candidate',
  verdict: 'candidate',
  swappedVerdict: 'candidate'
}

beforeEach(() => {
  vi.clearAllMocks()
  state.settings.experimentalOmniSiPreviews = true
})
afterEach(cleanup)

describe('EvolveRunPreviewPanels', () => {
  it('renders nothing while OmniSI previews are off', () => {
    state.settings.experimentalOmniSiPreviews = false
    const { container } = render(<EvolveRunPreviewPanels run={hostedRun()} />)
    expect(container).toBeEmptyDOMElement()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('shows the quality-cost card and reads the hosted audit bundle by record id', async () => {
    mocks.rpc.mockResolvedValue({ bundle: { judgments: [judgment, { id: 'bad' }] } })
    const run = hostedRun()
    render(<EvolveRunPreviewPanels run={run} />)
    expect(screen.getByText('Quality and cost')).toBeInTheDocument()
    expect(await screen.findByTestId('evolve-judgment-j1')).toBeInTheDocument()
    expect(screen.queryByTestId('evolve-judgment-bad')).toBeNull()
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'evolve.auditBundle', { id: run.id })
  })

  it('reports an unavailable audit bundle instead of an empty audit', async () => {
    mocks.rpc.mockRejectedValue(new Error('Hosted Evolve audit bundle request failed (HTTP 404).'))
    render(<EvolveRunPreviewPanels run={hostedRun()} />)
    expect(
      await screen.findByText(
        'Judge audit unavailable: Hosted Evolve audit bundle request failed (HTTP 404).'
      )
    ).toBeInTheDocument()
  })

  it('skips the judge audit for runs on this computer or the fleet', () => {
    render(<EvolveRunPreviewPanels run={evolveRunFixture()} />)
    expect(screen.getByText('Quality and cost')).toBeInTheDocument()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
