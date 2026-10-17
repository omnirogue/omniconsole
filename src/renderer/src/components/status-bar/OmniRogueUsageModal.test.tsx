// @vitest-environment happy-dom

import type { ComponentProps, ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OmniRogueCreditBalance } from '../../../../shared/omnirogue-account'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children, ...props }: ComponentProps<'div'>) => (
    <div {...props}>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>
}))

import { OmniRogueUsageModal } from './OmniRogueUsageModal'
import {
  buildOmniRogueUsageCsv,
  buildOmniRogueUsageCsvFilename,
  escapeCsvField,
  formatOmniRogueCredits,
  formatOmniRogueShare,
  normalizeOmniRogueModelKey,
  resolveOmniRogueLowBalance,
  resolveOmniRogueModelLabel,
  summarizeOmniRogueUsage,
  type OmniRogueUsageEntry
} from './omnirogue-usage-helpers'

const ENTRIES: OmniRogueUsageEntry[] = [
  {
    id: 'rcpt_1',
    occurredAt: '2026-10-16T09:00:00.000Z',
    capability: 'llm-gateway',
    model: 'claude-opus-5-5',
    description: 'Refactor',
    credits: 600,
    cacheSavedCredits: 150,
    promptTokens: 10_000,
    cachedPromptTokens: 7_500
  },
  {
    id: 'rcpt_2',
    occurredAt: '2026-10-15T09:00:00.000Z',
    capability: 'llm-gateway',
    model: 'gpt-6-astra',
    credits: 200,
    cacheSavedCredits: 50,
    promptTokens: 4_000,
    cachedPromptTokens: 1_000
  },
  {
    id: 'rcpt_3',
    occurredAt: '2026-10-14T09:00:00.000Z',
    capability: 'media-generation',
    model: null,
    description: 'Hero video',
    credits: 100
  },
  {
    id: 'rcpt_4',
    occurredAt: '2026-10-13T09:00:00.000Z',
    capability: 'hosted-evolve-si',
    model: 'gemini-4-argon',
    credits: 50,
    promptTokens: 1_000,
    cachedPromptTokens: 0
  },
  {
    id: 'rcpt_5',
    occurredAt: '2026-10-12T09:00:00.000Z',
    capability: 'discover-si',
    model: 'moonshotai/kimi-k3',
    description: 'Market scan, "deep"\nmode',
    credits: 50
  }
]

function balanceOf(availableCredits: number, lowBalanceThreshold?: number): OmniRogueCreditBalance {
  return { availableCredits, lowBalanceThreshold, updatedAt: '2026-10-16T09:00:00.000Z' }
}

function renderModal(props: Partial<ComponentProps<typeof OmniRogueUsageModal>> = {}) {
  const onOpenChange = vi.fn()
  const view = render(
    <OmniRogueUsageModal
      open
      onOpenChange={onOpenChange}
      entries={ENTRIES}
      now={() => new Date('2026-10-16T12:00:00.000Z')}
      {...props}
    />
  )
  return { ...view, onOpenChange }
}

function rowTexts(testId: string): string[] {
  return screen.getAllByTestId(testId).map((row) => row.textContent ?? '')
}

describe('summarizeOmniRogueUsage', () => {
  it('breaks spend down by every capability in a fixed order with shares of the total', () => {
    const summary = summarizeOmniRogueUsage(ENTRIES)

    expect(summary.totalCredits).toBe(1000)
    expect(summary.entryCount).toBe(5)
    expect(summary.byCapability.map((row) => [row.label, row.credits, row.count])).toEqual([
      ['LLM Gateway', 800, 2],
      ['Media Generation', 100, 1],
      ['Hosted Evolve SI', 50, 1],
      ['Discover SI', 50, 1]
    ])
    expect(summary.byCapability.map((row) => row.share)).toEqual([0.8, 0.1, 0.05, 0.05])
  })

  it('breaks spend down by model with readable labels, largest first, shares of model spend', () => {
    const { byModel } = summarizeOmniRogueUsage(ENTRIES)

    expect(byModel.map((row) => [row.key, row.label, row.credits])).toEqual([
      ['claude-opus-5-5', 'Claude Opus 5.5', 600],
      ['gpt-6-astra', 'GPT-6 Astra', 200],
      ['gemini-4-argon', 'Gemini 4 Argon', 50],
      ['kimi-k3', 'Kimi K3', 50]
    ])
    expect(byModel[0].share).toBeCloseTo(600 / 900)
    expect(byModel.reduce((total, row) => total + row.share, 0)).toBeCloseTo(1)
  })

  it('reports prompt-cache savings and the cache hit ratio across prompt tokens', () => {
    const { cache } = summarizeOmniRogueUsage(ENTRIES)

    expect(cache.savedCredits).toBe(200)
    expect(cache.promptTokens).toBe(15_000)
    expect(cache.cachedPromptTokens).toBe(8_500)
    expect(cache.hitRatio).toBeCloseTo(8_500 / 15_000)
  })

  it('returns zeroed rows and no hit ratio for an empty period', () => {
    const summary = summarizeOmniRogueUsage([])

    expect(summary.totalCredits).toBe(0)
    expect(summary.byCapability).toHaveLength(4)
    expect(summary.byCapability.every((row) => row.credits === 0 && row.share === 0)).toBe(true)
    expect(summary.byModel).toEqual([])
    expect(summary.cache.hitRatio).toBeNull()
  })

  it('ignores non-finite and negative charges and caps cached tokens at prompt tokens', () => {
    const summary = summarizeOmniRogueUsage([
      { id: 'a', occurredAt: '', capability: 'llm-gateway', credits: Number.NaN },
      { id: 'b', occurredAt: '', capability: 'llm-gateway', credits: -20 },
      { id: 'c', occurredAt: '', capability: 'llm-gateway', credits: Number.POSITIVE_INFINITY },
      {
        id: 'd',
        occurredAt: '',
        capability: 'discover-si',
        credits: 10,
        promptTokens: 100,
        cachedPromptTokens: 500
      }
    ])

    expect(summary.totalCredits).toBe(10)
    expect(summary.byCapability[3].share).toBe(1)
    expect(summary.cache.hitRatio).toBe(1)
  })

  it('merges spellings of the same model and keeps unknown models by their id', () => {
    const { byModel } = summarizeOmniRogueUsage([
      { id: 'a', occurredAt: '', capability: 'llm-gateway', model: 'claude-opus-5.5', credits: 1 },
      {
        id: 'b',
        occurredAt: '',
        capability: 'llm-gateway',
        model: 'anthropic/CLAUDE-OPUS-5-5',
        credits: 2
      },
      { id: 'c', occurredAt: '', capability: 'media-generation', model: 'seedance-2.5', credits: 1 }
    ])

    expect(byModel.map((row) => [row.label, row.credits, row.count])).toEqual([
      ['Claude Opus 5.5', 3, 2],
      ['seedance-2.5', 1, 1]
    ])
    expect(normalizeOmniRogueModelKey(' moonshotai/Kimi-K3 ')).toBe('kimi-k3')
    expect(resolveOmniRogueModelLabel('moonshot-ai/kimi-k3')).toBe('Kimi K3')
  })
})

describe('usage formatting', () => {
  it('formats shares as percentages with a floor for tiny non-zero shares', () => {
    expect(formatOmniRogueShare(0)).toBe('0%')
    expect(formatOmniRogueShare(Number.NaN)).toBe('0%')
    expect(formatOmniRogueShare(0.0004)).toBe('<0.1%')
    expect(formatOmniRogueShare(0.5)).toBe('50%')
    expect(formatOmniRogueShare(2 / 3)).toBe('66.7%')
    expect(formatOmniRogueShare(1)).toBe('100%')
  })

  it('formats credit totals with grouping and up to two decimals', () => {
    expect(formatOmniRogueCredits(1234)).toBe('1,234')
    expect(formatOmniRogueCredits(1234.5)).toBe('1,234.5')
    expect(formatOmniRogueCredits(0.256)).toBe('0.26')
  })
})

describe('resolveOmniRogueLowBalance', () => {
  it('warns at or below the account threshold', () => {
    expect(resolveOmniRogueLowBalance(balanceOf(100, 100))).toEqual({
      isLow: true,
      threshold: 100,
      availableCredits: 100
    })
    expect(resolveOmniRogueLowBalance(balanceOf(101, 100))?.isLow).toBe(false)
  })

  it('prefers a configured threshold, then the account threshold, then the default', () => {
    expect(resolveOmniRogueLowBalance(balanceOf(150, 100), 200)).toMatchObject({
      isLow: true,
      threshold: 200
    })
    expect(resolveOmniRogueLowBalance(balanceOf(150, 100), -5)?.threshold).toBe(100)
    expect(resolveOmniRogueLowBalance(balanceOf(150, 100), Number.NaN)?.threshold).toBe(100)
    expect(resolveOmniRogueLowBalance(balanceOf(80))).toMatchObject({ isLow: true, threshold: 100 })
  })

  it('has nothing to say without a usable balance', () => {
    expect(resolveOmniRogueLowBalance(null)).toBeNull()
    expect(resolveOmniRogueLowBalance(undefined)).toBeNull()
    expect(resolveOmniRogueLowBalance(balanceOf(Number.NaN))).toBeNull()
  })
})

describe('buildOmniRogueUsageCsv', () => {
  it('writes an RFC 4180 receipt: header, chronological CRLF records and a total row', () => {
    const lines = buildOmniRogueUsageCsv(ENTRIES).split('\r\n')

    expect(lines).toEqual([
      'Receipt ID,Date (UTC),Capability,Model,Description,Credits,Prompt-cache saved credits,Prompt tokens,Cached prompt tokens',
      'rcpt_5,2026-10-12T09:00:00.000Z,Discover SI,Kimi K3,"Market scan, ""deep""\nmode",50,,,',
      'rcpt_4,2026-10-13T09:00:00.000Z,Hosted Evolve SI,Gemini 4 Argon,,50,,1000,0',
      'rcpt_3,2026-10-14T09:00:00.000Z,Media Generation,,Hero video,100,,,',
      'rcpt_2,2026-10-15T09:00:00.000Z,LLM Gateway,GPT-6 Astra,,200,50,4000,1000',
      'rcpt_1,2026-10-16T09:00:00.000Z,LLM Gateway,Claude Opus 5.5,Refactor,600,150,10000,7500',
      'Total,,,,,1000,200,15000,8500',
      ''
    ])
  })

  it('keeps every record at the header width', () => {
    const csv = buildOmniRogueUsageCsv([ENTRIES[0], ENTRIES[2]])
    const widths = csv
      .trimEnd()
      .split('\r\n')
      .map((line) => line.split(',').length)

    expect(new Set(widths)).toEqual(new Set([9]))
  })

  it('neutralises spreadsheet formulas in text cells but not numeric cells', () => {
    const csv = buildOmniRogueUsageCsv([
      {
        id: '@id',
        occurredAt: '2026-10-16T00:00:00.000Z',
        capability: 'llm-gateway',
        description: '=HYPERLINK("http://example.test")',
        credits: -5
      },
      {
        id: 'r2',
        occurredAt: '2026-10-16T01:00:00.000Z',
        capability: 'llm-gateway',
        description: '+1',
        credits: 10
      }
    ])
    const [, first, second, total] = csv.split('\r\n')

    expect(first).toBe(
      `'@id,2026-10-16T00:00:00.000Z,LLM Gateway,,"'=HYPERLINK(""http://example.test"")",-5,,,`
    )
    expect(second).toContain(",'+1,10,")
    expect(total).toBe('Total,,,,,5,0,0,0')
  })

  it('quotes only fields that need it', () => {
    expect(escapeCsvField('plain')).toBe('plain')
    expect(escapeCsvField('a,b')).toBe('"a,b"')
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvField('line\r\nbreak')).toBe('"line\r\nbreak"')
  })

  it('names the receipt by its UTC date', () => {
    expect(buildOmniRogueUsageCsvFilename(new Date('2026-10-16T23:30:00.000Z'))).toBe(
      'omnirogue-usage-receipt-2026-10-16.csv'
    )
  })
})

describe('OmniRogueUsageModal', () => {
  const originalCreateObjectUrl = URL.createObjectURL
  const originalRevokeObjectUrl = URL.revokeObjectURL

  beforeEach(() => {
    URL.createObjectURL = vi.fn((_blob: Blob) => 'blob:omnirogue-receipt')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    cleanup()
    URL.createObjectURL = originalCreateObjectUrl
    URL.revokeObjectURL = originalRevokeObjectUrl
    vi.restoreAllMocks()
  })

  it('renders nothing while closed', () => {
    renderModal({ open: false })

    expect(screen.queryByTestId('omnirogue-usage-modal')).toBeNull()
  })

  it('shows spend by capability with credits and percentages', () => {
    renderModal()

    expect(screen.getByTestId('omnirogue-usage-total').textContent).toBe('1,000')
    const rows = rowTexts('omnirogue-usage-capability-row')
    expect(rows).toHaveLength(4)
    expect(rows[0]).toContain('LLM Gateway')
    expect(rows[0]).toContain('800 cr')
    expect(rows[0]).toContain('80%')
    expect(rows[1]).toContain('Media Generation')
    expect(rows[1]).toContain('10%')
    expect(rows[2]).toContain('Hosted Evolve SI')
    expect(rows[3]).toContain('Discover SI')
    expect(rows[3]).toContain('5%')
  })

  it('shows spend by model largest first', () => {
    renderModal()

    const shares = screen
      .getAllByTestId('omnirogue-usage-model-row-share')
      .map((cell) => cell.textContent)
    const labels = ['Claude Opus 5.5', 'GPT-6 Astra', 'Gemini 4 Argon', 'Kimi K3']
    const rows = rowTexts('omnirogue-usage-model-row')
    expect(rows.map((row, index) => row.startsWith(labels[index]))).toEqual([
      true,
      true,
      true,
      true
    ])
    expect(shares).toEqual(['66.7%', '22.2%', '5.6%', '5.6%'])
  })

  it('shows the prompt-cache savings badge with saved credits and hit ratio', () => {
    renderModal()

    expect(screen.getByTestId('omnirogue-usage-cache-saved').textContent).toBe('Saved 200 cr')
    expect(screen.getByTestId('omnirogue-usage-cache-ratio').textContent).toBe('56.7% cache hits')
  })

  it('shows a dash for the hit ratio when no prompt tokens were reported', () => {
    renderModal({ entries: [ENTRIES[2]] })

    expect(screen.getByTestId('omnirogue-usage-cache-ratio').textContent).toBe('— cache hits')
    expect(screen.getByText('No model-billed usage yet.')).toBeTruthy()
  })

  it('warns when spendable credits are at the threshold and offers a top-up', () => {
    const onTopUp = vi.fn()
    renderModal({ balance: balanceOf(100, 100), onTopUp })

    const banner = screen.getByTestId('omnirogue-usage-low-balance')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain(
      '100 spendable credits left. You are warned at 100 credits or fewer.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Top Up' }))
    expect(onTopUp).toHaveBeenCalledTimes(1)
  })

  it('stays quiet above the threshold', () => {
    renderModal({ balance: balanceOf(101, 100) })

    expect(screen.queryByTestId('omnirogue-usage-low-balance')).toBeNull()
  })

  it('uses the configured threshold over the account one', () => {
    renderModal({ balance: balanceOf(400, 100), lowBalanceThreshold: 500 })

    expect(screen.getByTestId('omnirogue-usage-low-balance').textContent).toContain(
      'warned at 500 credits'
    )
  })

  it('exports the CSV receipt through the callback in one click', () => {
    const onExportCsv = vi.fn()
    renderModal({ onExportCsv })

    fireEvent.click(screen.getByTestId('omnirogue-usage-export'))

    expect(onExportCsv).toHaveBeenCalledWith(
      buildOmniRogueUsageCsv(ENTRIES),
      'omnirogue-usage-receipt-2026-10-16.csv'
    )
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('downloads the CSV receipt when no callback is given', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderModal()

    fireEvent.click(screen.getByTestId('omnirogue-usage-export'))

    expect(click).toHaveBeenCalledTimes(1)
    const anchor = click.mock.contexts[0] as HTMLAnchorElement
    expect(anchor.download).toBe('omnirogue-usage-receipt-2026-10-16.csv')
    expect(anchor.href).toBe('blob:omnirogue-receipt')
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob
    expect(blob.type).toBe('text/csv;charset=utf-8')
    expect(await blob.text()).toContain('Total,,,,,1000,200,15000,8500')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:omnirogue-receipt')
  })

  it('shows an empty state and disables export when there is no usage', () => {
    renderModal({ entries: [] })

    expect(screen.getByTestId('omnirogue-usage-empty')).toBeTruthy()
    expect(screen.queryByTestId('omnirogue-usage-capability-row')).toBeNull()
    expect(screen.getByTestId('omnirogue-usage-export').hasAttribute('disabled')).toBe(true)
  })

  it('shows a loading state without stale totals', () => {
    renderModal({ loading: true })

    expect(screen.getByTestId('omnirogue-usage-loading')).toBeTruthy()
    expect(screen.getByTestId('omnirogue-usage-total').textContent).toBe('—')
    expect(screen.queryByTestId('omnirogue-usage-cache-badge')).toBeNull()
    expect(screen.getByTestId('omnirogue-usage-export').hasAttribute('disabled')).toBe(true)
  })

  it('names the period and closes from the footer', () => {
    const { onOpenChange } = renderModal({ periodLabel: 'October 2026' })

    expect(screen.getByText('Credit spend for October 2026')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
