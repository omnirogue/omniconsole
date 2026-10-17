// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OmniRogueQuickGenerateModal } from './OmniRogueQuickGenerateModal'
import type { OmniRogueQuickGenerateModalProps } from './OmniRogueQuickGenerateModal'
import type { OmniRogueCreditBalance } from '../../../../shared/omnirogue-account'
import type { OmniRogueCreditsApi } from '../../../../preload/api/omnirogue-api'
import {
  QUICK_GENERATE_ASPECT_RATIOS,
  expandQuickGenerateRatios,
  formatQuickGenerateAssets,
  isQuickGenerateShortcut,
  isUsableQuickGenerateQuote,
  quickGenerateCreditGuard,
  sameQuickGenerateTerminal,
  validateQuickGenerateAssets
} from './omnirogue-quick-generate-helpers'
import type {
  OmniRogueQuickGenerateService,
  QuickGenerateAsset,
  QuickGenerateInsertion,
  QuickGenerateQuote,
  QuickGenerateRequest,
  QuickGenerateTerminal
} from './omnirogue-quick-generate-helpers'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const terminal: QuickGenerateTerminal = {
  sessionId: 'terminal-1',
  hostId: 'ssh:builder',
  shell: 'posix'
}
const asset: QuickGenerateAsset = {
  path: '/work/generated art.png',
  kind: 'image',
  aspectRatio: '1:1'
}
const balance = (availableCredits = 500): OmniRogueCreditBalance => ({
  availableCredits,
  updatedAt: '2026-10-16',
  lowBalanceThreshold: 100
})
const quote = (credits = 10): QuickGenerateQuote => ({
  id: 'quote-1',
  credits,
  expiresAt: Date.now() + 60_000
})
const request: QuickGenerateRequest = {
  prompt: 'A lighthouse',
  kind: 'image',
  aspectRatios: ['1:1'],
  terminal
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let service: OmniRogueQuickGenerateService
let creditsApi: OmniRogueCreditsApi
let balanceChanged: (value: OmniRogueCreditBalance | null) => void
let onInsert: ReturnType<typeof vi.fn<(insertion: QuickGenerateInsertion) => Promise<void>>>
let unsubscribe: ReturnType<typeof vi.fn<() => void>>
beforeEach(() => {
  unsubscribe = vi.fn<() => void>()
  onInsert = vi
    .fn<(insertion: QuickGenerateInsertion) => Promise<void>>()
    .mockResolvedValue(undefined)
  creditsApi = {
    getBalance: vi.fn().mockResolvedValue(balance()),
    refreshBalance: vi.fn().mockResolvedValue(balance()),
    openTopUp: vi.fn(),
    onBalanceChanged: vi.fn<
      (listener: (balance: OmniRogueCreditBalance | null) => void) => () => void
    >((listener) => {
      balanceChanged = listener
      return unsubscribe
    })
  }
  service = {
    quote: vi.fn(async (input: QuickGenerateRequest) =>
      quote(input.aspectRatios.length * (input.kind === 'image' ? 10 : 20))
    ),
    generate: vi.fn(async (input: QuickGenerateRequest) =>
      input.aspectRatios.map((ratio) => ({ ...asset, aspectRatio: ratio, kind: input.kind }))
    )
  }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function mount(overrides: Partial<OmniRogueQuickGenerateModalProps> = {}) {
  const props: OmniRogueQuickGenerateModalProps = {
    service,
    creditsApi,
    activeTerminal: terminal,
    onInsert,
    open: true,
    showTrigger: false,
    ...overrides
  }
  return { ...render(<OmniRogueQuickGenerateModal {...props} />), props }
}
async function ready() {
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'A lighthouse' } })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled())
}
async function choose(label: string, name: string) {
  fireEvent.keyDown(screen.getByRole('combobox', { name: label }), { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name }))
}
async function generate() {
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await screen.findByText('Assets ready to insert')
}

describe('batch and terminal formatting', () => {
  it.each(QUICK_GENERATE_ASPECT_RATIOS)('expands %s without changing it', (ratio) => {
    expect(expandQuickGenerateRatios(ratio)).toEqual([ratio])
  })
  it('expands multi-pack into all four ratios once', () => {
    expect(expandQuickGenerateRatios('multi-pack')).toEqual(['1:1', '4:5', '16:9', '9:16'])
  })
  it.each([Number.NaN, Infinity, -1])('fails closed for invalid price or balance %s', (value) => {
    expect(quickGenerateCreditGuard(balance(), value).allowed).toBe(false)
    expect(quickGenerateCreditGuard(balance(value), 10).allowed).toBe(false)
    expect(isUsableQuickGenerateQuote(quote(value))).toBe(false)
  })
  it('handles unknown, insufficient, exact, zero and low balances', () => {
    expect(quickGenerateCreditGuard(null, 10).status).toBe('unknown')
    expect(quickGenerateCreditGuard(balance(), null).allowed).toBe(false)
    expect(quickGenerateCreditGuard(balance(9), 10).status).toBe('insufficient')
    expect(quickGenerateCreditGuard(balance(10), 10)).toEqual({ allowed: true, status: 'low' })
    expect(quickGenerateCreditGuard(balance(0), 0).allowed).toBe(true)
    expect(quickGenerateCreditGuard(balance(110), 10).status).toBe('low')
  })
  it('rejects expired quotes, missing IDs and host/session/shell mismatches', () => {
    expect(isUsableQuickGenerateQuote({ ...quote(), expiresAt: Date.now() })).toBe(false)
    expect(isUsableQuickGenerateQuote({ ...quote(), id: ' ' })).toBe(false)
    for (const changed of [
      null,
      { ...terminal, hostId: 'local' },
      { ...terminal, sessionId: 'other' },
      { ...terminal, shell: 'cmd' as const }
    ]) {
      expect(sameQuickGenerateTerminal(terminal, changed)).toBe(false)
    }
  })
  it('quotes POSIX and PowerShell paths without expanding shell syntax', () => {
    const path = "/tmp/it's $(whoami); `id`.png"
    expect(formatQuickGenerateAssets([{ ...asset, path }], 'path', 'posix')).toBe(
      "'/tmp/it'\\''s $(whoami); `id`.png'"
    )
    expect(formatQuickGenerateAssets([{ ...asset, path }], 'path', 'powershell')).toBe(
      "'/tmp/it''s $(whoami); `id`.png'"
    )
    expect(
      formatQuickGenerateAssets(
        [{ ...asset, path: 'C:\\assets\\x\u2019;Write-Output 123;#a.png' }],
        'path',
        'powershell'
      )
    ).toBe("'C:\\assets\\x\u2019\u2019;Write-Output 123;#a.png'")
    expect(formatQuickGenerateAssets([asset, asset], 'path', 'posix')).toBe(
      "'/work/generated art.png' '/work/generated art.png'"
    )
  })
  it('quotes cmd paths and refuses expansion or quote characters', () => {
    expect(formatQuickGenerateAssets([asset], 'path', 'cmd')).toBe('"/work/generated art.png"')
    for (const path of ['C:\\%TEMP%\\x.png', 'C:\\a!b.png', 'C:\\a"b.png']) {
      expect(() => formatQuickGenerateAssets([{ ...asset, path }], 'path', 'cmd')).toThrow(
        'cmd.exe'
      )
    }
  })
  it.each(['', ' ', 'a\nb', 'a\rb', 'a\u0000b', 'a\u001bb', 'a\u007fb', 'a\u2028b'])(
    'rejects unsafe path %j',
    (path) => {
      expect(() => formatQuickGenerateAssets([{ ...asset, path }], 'path', 'posix')).toThrow(
        'invalid path'
      )
    }
  )
  it('encodes Markdown destinations and video attributes', () => {
    expect(formatQuickGenerateAssets([asset], 'markdown', 'posix')).toBe(
      '![Generated image](</work/generated%20art.png>)'
    )
    expect(
      formatQuickGenerateAssets([{ ...asset, path: '/tmp/a\\b.png' }], 'markdown', 'posix')
    ).toBe('![Generated image](</tmp/a%5Cb.png>)')
    expect(
      formatQuickGenerateAssets(
        [{ ...asset, kind: 'video', path: 'C:\\a &"<b>.mp4' }],
        'markdown',
        'powershell'
      )
    ).toBe('<video controls src="C:/a%20&amp;%22%3Cb%3E.mp4"></video>')
    expect(
      formatQuickGenerateAssets([{ ...asset, path: 'a%20[1].png' }], 'markdown', 'posix')
    ).toContain('a%2520%5B1%5D.png')
    expect(() =>
      formatQuickGenerateAssets([{ ...asset, path: 'javascript:alert(1)' }], 'markdown', 'posix')
    ).toThrow('saved asset path')
  })
  it('rejects missing, duplicate or wrong-kind batch outputs', () => {
    for (const assets of [[], [asset, asset], [{ ...asset, kind: 'video' as const }]]) {
      expect(() => validateQuickGenerateAssets(assets, request)).toThrow('incomplete batch')
    }
    expect(() => formatQuickGenerateAssets([], 'path', 'posix')).toThrow('No generated assets')
  })
})

describe('quick generation flow', () => {
  it.each([true, false])(
    'opens via the platform shortcut (Mac: %s) and cleans up',
    async (isMac) => {
      vi.stubGlobal('navigator', { userAgent: isMac ? 'Macintosh' : 'Windows' })
      const onOpenChange = vi.fn()
      const view = mount({ open: undefined, showTrigger: true, onOpenChange })
      expect(screen.queryByRole('dialog')).toBeNull()
      fireEvent.keyDown(window, { key: 'g', shiftKey: true, metaKey: isMac, ctrlKey: !isMac })
      expect(await screen.findByRole('dialog')).toBeInTheDocument()
      view.unmount()
      fireEvent.keyDown(window, { key: 'g', shiftKey: true, metaKey: isMac, ctrlKey: !isMac })
      expect(onOpenChange).toHaveBeenCalledTimes(1)
      expect(unsubscribe).toHaveBeenCalledOnce()
    }
  )
  it('opens from Quick Generate and supports disabling the shortcut', () => {
    mount({ open: undefined, showTrigger: true, shortcutEnabled: false })
    fireEvent.keyDown(window, { key: 'g', shiftKey: true, ctrlKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Quick Generate' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(service.quote).not.toHaveBeenCalled()
  })
  it.each([
    { repeat: true },
    { isComposing: true },
    { altKey: true },
    { metaKey: true },
    { shiftKey: false }
  ])('ignores unrelated shortcuts %j', (extra) => {
    expect(
      isQuickGenerateShortcut(
        new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, shiftKey: true, ...extra }),
        false
      )
    ).toBe(false)
  })
  it('quotes and generates one multi-pack video batch', async () => {
    mount()
    await ready()
    await choose('Media type', 'Video')
    await choose('Aspect ratio', 'Multi-pack (all 4 ratios)')
    await screen.findByText('Batch cost: 80 cr')
    await generate()
    expect(service.generate).toHaveBeenCalledExactlyOnceWith(
      { ...request, kind: 'video', aspectRatios: [...QUICK_GENERATE_ASPECT_RATIOS] },
      { quoteId: 'quote-1', signal: expect.any(AbortSignal) }
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    expect(onInsert).not.toHaveBeenCalled()
  })
  it('warns at low balance and disables on live insufficient or unknown balance', async () => {
    mount()
    await ready()
    act(() => balanceChanged(balance(110)))
    expect(screen.getByText('Low credit balance after generation.')).toBeInTheDocument()
    act(() => balanceChanged(balance(9)))
    expect(screen.getByText('Insufficient credits for this batch.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
    act(() => balanceChanged(null))
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
  })
  it('uses a newer balance event instead of a stale initial refresh', async () => {
    const pending = deferred<OmniRogueCreditBalance | null>()
    vi.mocked(creditsApi.refreshBalance).mockReturnValueOnce(pending.promise)
    mount()
    act(() => balanceChanged(balance(1)))
    await act(async () => pending.resolve(balance()))
    expect(screen.getByText('Available credits: 1')).toBeInTheDocument()
  })
  it.each([null, balance(1)])('rechecks balance before any generation', async (fresh) => {
    mount()
    await ready()
    vi.mocked(creditsApi.refreshBalance).mockResolvedValue(fresh)
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable or insufficient')
    expect(service.generate).not.toHaveBeenCalled()
  })
  it('handles balance refresh rejection and permits a manual retry', async () => {
    vi.mocked(creditsApi.refreshBalance).mockRejectedValueOnce(new Error('offline'))
    mount()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'A lighthouse' } })
    await screen.findByText('Batch cost: 10 cr')
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh credits' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled())
  })
  it('ignores out-of-order quotes after changing the prompt', async () => {
    const old = deferred<QuickGenerateQuote>()
    vi.mocked(service.quote).mockReturnValueOnce(old.promise)
    mount()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Old' } })
    await waitFor(() => expect(service.quote).toHaveBeenCalledOnce())
    await ready()
    await act(async () => old.resolve(quote(999)))
    expect(screen.getByText('Batch cost: 10 cr')).toBeInTheDocument()
    expect(vi.mocked(service.quote).mock.calls[0][1].signal.aborted).toBe(true)
  })
  it('shows quote failures and recovers on refresh', async () => {
    vi.mocked(service.quote).mockRejectedValueOnce(new Error('offline'))
    mount()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'A lighthouse' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the credit cost')
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh credits' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled())
  })
  it('refuses a quote that expires while refreshing balance', async () => {
    const now = Date.now(),
      pending = deferred<OmniRogueCreditBalance | null>()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    mount()
    await ready()
    vi.mocked(creditsApi.refreshBalance).mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    vi.mocked(Date.now).mockReturnValue(now + 60_001)
    await act(async () => pending.resolve(balance()))
    expect(await screen.findByRole('alert')).toHaveTextContent('quote expired')
    expect(service.generate).not.toHaveBeenCalled()
  })
  it('blocks duplicate generation and closing during a pending batch', async () => {
    const pending = deferred<readonly QuickGenerateAsset[]>()
    vi.mocked(service.generate).mockReturnValueOnce(pending.promise)
    mount()
    await ready()
    const button = screen.getByRole('button', { name: 'Generate' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(service.generate).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
    await act(async () => pending.resolve([asset]))
    expect(await screen.findByText('Assets ready to insert')).toBeInTheDocument()
  })
  it('inserts escaped paths without Enter only after explicit confirmation', async () => {
    mount()
    await ready()
    await generate()
    fireEvent.click(screen.getByRole('button', { name: 'Insert into terminal' }))
    await waitFor(() =>
      expect(onInsert).toHaveBeenCalledExactlyOnceWith({
        terminal,
        format: 'path',
        text: "'/work/generated art.png'",
        appendEnter: false
      })
    )
    await waitFor(() => expect(screen.queryByText('Assets ready to insert')).toBeNull())
  })
  it.each(['image', 'video'] as const)('inserts a %s Markdown embed', async (kind) => {
    mount()
    await ready()
    if (kind === 'video') {
      await choose('Media type', 'Video')
      await screen.findByText('Batch cost: 20 cr')
    }
    await generate()
    await choose('Insert as', 'Markdown embed')
    fireEvent.click(screen.getByRole('button', { name: 'Insert into terminal' }))
    await waitFor(() => expect(onInsert).toHaveBeenCalledOnce())
    expect(onInsert.mock.calls[0][0]).toMatchObject({
      format: 'markdown',
      appendEnter: false,
      text:
        kind === 'image'
          ? '![Generated image](</work/generated%20art.png>)'
          : '<video controls src="/work/generated%20art.png"></video>'
    })
  })
  it('retains assets after insertion failure without regenerating', async () => {
    onInsert.mockRejectedValueOnce(new Error('Terminal unavailable'))
    mount()
    await ready()
    await generate()
    fireEvent.click(screen.getByRole('button', { name: 'Insert into terminal' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Terminal unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Insert into terminal' }))
    await waitFor(() => expect(onInsert).toHaveBeenCalledTimes(2))
    expect(service.generate).toHaveBeenCalledOnce()
  })
  it('prevents duplicate insertion while the terminal callback is pending', async () => {
    const pending = deferred<void>()
    onInsert.mockReturnValueOnce(pending.promise)
    mount()
    await ready()
    await generate()
    const button = screen.getByRole('button', { name: 'Insert into terminal' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onInsert).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Inserting…' })).toBeDisabled()
    await act(async () => pending.resolve(undefined))
    expect(screen.queryByText('Assets ready to insert')).toBeNull()
  })
  it('invalidates the quote when the provider adapter changes', async () => {
    const view = mount()
    await ready()
    const pending = deferred<QuickGenerateQuote>()
    view.rerender(
      <OmniRogueQuickGenerateModal
        {...view.props}
        service={{ ...service, quote: () => pending.promise }}
      />
    )
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
    await act(async () => pending.resolve(quote(600)))
    expect(screen.getByText('Insufficient credits for this batch.')).toBeInTheDocument()
    expect(service.generate).not.toHaveBeenCalled()
  })
  it('blocks insertion into a different terminal or execution host', async () => {
    const view = mount()
    await ready()
    await generate()
    view.rerender(
      <OmniRogueQuickGenerateModal
        {...view.props}
        activeTerminal={{ ...terminal, hostId: 'local' }}
      />
    )
    expect(screen.getByRole('button', { name: 'Insert into terminal' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('original terminal')
    expect(onInsert).not.toHaveBeenCalled()
  })
  it('blocks generation when the terminal changes during the balance check', async () => {
    const pending = deferred<OmniRogueCreditBalance | null>()
    const view = mount()
    await ready()
    vi.mocked(creditsApi.refreshBalance).mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    view.rerender(<OmniRogueQuickGenerateModal {...view.props} activeTerminal={null} />)
    await act(async () => pending.resolve(balance()))
    expect(service.generate).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent('active terminal changed')
  })
  it('aborts callbacks and ignores a late result after unmount', async () => {
    const pending = deferred<readonly QuickGenerateAsset[]>()
    vi.mocked(service.generate).mockReturnValueOnce(pending.promise)
    const view = mount()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(service.generate).toHaveBeenCalledOnce())
    const signal = vi.mocked(service.generate).mock.calls[0][1].signal
    view.unmount()
    await act(async () => pending.resolve([asset]))
    expect(signal.aborted).toBe(true)
    expect(onInsert).not.toHaveBeenCalled()
  })
  it.each(['failure', 'partial'])(
    'shows %s generation errors without inserting or retrying',
    async (mode) => {
      if (mode === 'failure') {
        vi.mocked(service.generate).mockRejectedValueOnce(new Error('Provider unavailable'))
      } else {
        vi.mocked(service.generate).mockResolvedValueOnce([])
      }
      mount()
      await ready()
      fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(
        mode === 'failure' ? 'Provider unavailable' : 'incomplete batch'
      )
      expect(service.generate).toHaveBeenCalledOnce()
      expect(onInsert).not.toHaveBeenCalled()
    }
  )
  it('requires a terminal and a nonempty prompt', async () => {
    const view = mount()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: '  ' } })
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
    expect(service.quote).not.toHaveBeenCalled()
    view.rerender(<OmniRogueQuickGenerateModal {...view.props} activeTerminal={null} />)
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'A lighthouse' } })
    expect(service.quote).not.toHaveBeenCalled()
    expect(screen.getByText('Select an active terminal to generate media.')).toBeInTheDocument()
  })
})
