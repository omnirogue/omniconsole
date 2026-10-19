// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OmniRogueBrandKitDrawer } from './OmniRogueBrandKitDrawer'
import type { OmniRogueBrandKitDrawerProps } from './OmniRogueBrandKitDrawer'
import {
  DEFAULT_BRAND_KIT_LABELS, brandKitToForm, filterBrandKits, hasBrandKitChanges,
  normalizeBrandKitColor, safeBrandKitLogoUrl, validateBrandKitForm
} from './omnirogue-brand-kit-helpers'
import type { OmniRogueBrandKit, OmniRogueBrandKitService } from './omnirogue-brand-kit-helpers'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const kit: OmniRogueBrandKit = {
  id: 'kit-1', name: 'Harbor', logoUrl: '', colors: ['#112233'], fonts: ['Geist'],
  voice: 'Calm and direct', guidelines: 'Use generous spacing.'
}
const otherKit: OmniRogueBrandKit = { ...kit, id: 'kit-2', name: 'Lighthouse' }
const labels = DEFAULT_BRAND_KIT_LABELS
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

let service: OmniRogueBrandKitService
let onApply: ReturnType<typeof vi.fn<OmniRogueBrandKitDrawerProps['onApply']>>
let onOpenChange: ReturnType<typeof vi.fn<OmniRogueBrandKitDrawerProps['onOpenChange']>>
function mount(overrides: Partial<OmniRogueBrandKitDrawerProps> = {}) {
  const props: OmniRogueBrandKitDrawerProps = {
    open: true, contextKey: 'account-a', service, onApply, onOpenChange, ...overrides
  }
  return { ...render(<OmniRogueBrandKitDrawer {...props} />), props }
}
async function selectKit() {
  fireEvent.click(await screen.findByRole('button', { name: kit.name }))
}
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

beforeEach(() => {
  service = {
    list: vi.fn().mockResolvedValue([kit, otherKit]),
    save: vi.fn().mockImplementation(async (draft, options) => ({ ...draft, id: options.id ?? 'kit-new' }))
  }
  onApply = vi.fn().mockResolvedValue(undefined)
  onOpenChange = vi.fn()
})
afterEach(cleanup)

describe('brand kit validation', () => {
  it('normalizes, deduplicates, and preserves the source kit', () => {
    const result = validateBrandKitForm({ ...brandKitToForm(kit), name: ' Harbor ', colors: '#abc, #AABBCC\n#123456', fonts: ' Geist, Geist ' })
    expect(result.errors).toEqual({})
    expect(result.draft).toMatchObject({ name: 'Harbor', colors: ['#AABBCC', '#123456'], fonts: ['Geist'] })
    expect(kit.colors).toEqual(['#112233'])
    expect(normalizeBrandKitColor('red')).toBeNull()
    expect(hasBrandKitChanges(brandKitToForm(kit), kit)).toBe(false)
  })
  it('rejects invalid colors, excessive lists, and unsafe logo URLs', () => {
    expect(validateBrandKitForm({ ...brandKitToForm(), name: ' ', colors: 'red', logoUrl: 'javascript:alert(1)' }).errors)
      .toMatchObject({ name: 'nameRequired', colors: 'invalidColors', logoUrl: 'invalidLogoUrl' })
    expect(validateBrandKitForm({ ...brandKitToForm(kit), colors: Array.from({ length: 9 }, () => '#abc').join(',') }).draft).toBeNull()
    expect(validateBrandKitForm({ ...brandKitToForm(kit), fonts: 'a,b,c,d,e' }).errors.fonts).toBe('invalidFonts')
    expect(validateBrandKitForm({ ...brandKitToForm(kit), guidelines: 'x'.repeat(2001) }).errors.guidelines).toBe('textTooLong')
    for (const url of ['http://example.com/logo.png', 'https://user:secret@example.com/logo.png', 'data:image/png;base64,abc']) {
      expect(safeBrandKitLogoUrl(url)).toBeNull()
    }
    expect(safeBrandKitLogoUrl('https://example.com/logo.png')).toBe('https://example.com/logo.png')
  })
  it('filters by name without changing the saved collection', () => {
    const kits = [kit, otherKit]
    expect(filterBrandKits(kits, ' HARB ')).toEqual([kit])
    expect(filterBrandKits(kits, 'unknown')).toEqual([])
    expect(kits).toEqual([kit, otherKit])
  })
})

describe('OmniRogueBrandKitDrawer', () => {
  it('does not load while closed', () => {
    mount({ open: false })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(service.list).not.toHaveBeenCalled()
  })
  it('loads, searches, and applies the chosen kit', async () => {
    mount()
    expect(screen.getByRole('status')).toHaveTextContent(labels.loading)
    await screen.findByRole('button', { name: kit.name })
    expect(screen.getByRole('button', { name: labels.apply })).toBeDisabled()
    change(labels.search, 'harb')
    expect(screen.queryByRole('button', { name: otherKit.name })).not.toBeInTheDocument()
    await selectKit()
    expect(screen.getByLabelText(labels.voice)).toHaveValue(kit.voice)
    fireEvent.click(screen.getByRole('button', { name: labels.apply }))
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(kit, { signal: expect.any(AbortSignal) }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(service.save).not.toHaveBeenCalled()
  })
  it('shows a retry after a failed load and recovers', async () => {
    vi.mocked(service.list).mockRejectedValueOnce(new Error('Unavailable'))
    mount()
    expect(await screen.findByRole('alert')).toHaveTextContent(labels.loadFailed)
    fireEvent.click(screen.getByRole('button', { name: labels.retry }))
    expect(await screen.findByRole('button', { name: kit.name })).toBeEnabled()
    expect(service.list).toHaveBeenCalledTimes(2)
  })
  it('creates a validated kit from the empty state', async () => {
    vi.mocked(service.list).mockResolvedValue([])
    mount()
    expect(await screen.findByText(labels.empty)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: labels.newKit }))
    fireEvent.click(screen.getByRole('button', { name: labels.save }))
    expect(await screen.findByRole('alert')).toHaveTextContent(labels.nameRequired)
    expect(screen.getByLabelText(labels.name)).toHaveAttribute('aria-invalid', 'true')
    expect(service.save).not.toHaveBeenCalled()
    change(labels.name, '  Studio  ')
    change(labels.colors, '#abc, #123456')
    change(labels.fonts, 'Geist, Georgia')
    fireEvent.click(screen.getByRole('button', { name: labels.save }))
    await waitFor(() => expect(service.save).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Studio', colors: ['#AABBCC', '#123456'], fonts: ['Geist', 'Georgia']
    }), { id: undefined, signal: expect.any(AbortSignal) }))
    expect(await screen.findByRole('button', { name: 'Studio' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: labels.apply })).toBeEnabled()
  })
  it('keeps dirty edits until saved or explicitly discarded', async () => {
    mount()
    await selectKit()
    change(labels.voice, 'Playful')
    expect(screen.getByRole('button', { name: labels.apply })).toBeDisabled()
    expect(screen.getByRole('button', { name: otherKit.name })).toBeDisabled()
    expect(screen.getByRole('button', { name: labels.close })).toBeDisabled()
    fireEvent.keyDown(screen.getByLabelText(labels.voice), { key: 'Escape' })
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: labels.discard }))
    expect(screen.getByLabelText(labels.voice)).toHaveValue(kit.voice)
    expect(screen.getByRole('button', { name: labels.apply })).toBeEnabled()
  })
  it('updates the existing id and suppresses duplicate saves', async () => {
    const pending = deferred<OmniRogueBrandKit>()
    vi.mocked(service.save).mockReturnValueOnce(pending.promise)
    mount()
    await selectKit()
    change(labels.name, 'Harbor updated')
    fireEvent.click(screen.getByRole('button', { name: labels.save }))
    fireEvent.click(screen.getByRole('button', { name: labels.saving }))
    expect(service.save).toHaveBeenCalledOnce()
    expect(service.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Harbor updated' }), { id: kit.id, signal: expect.any(AbortSignal) })
    expect(screen.getByRole('button', { name: labels.close })).toBeDisabled()
    await act(async () => pending.resolve({ ...kit, name: 'Harbor updated' }))
    expect(screen.queryByRole('button', { name: kit.name })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: labels.save })).toBeDisabled()
  })
  it('retains edits after a save failure and permits retry', async () => {
    vi.mocked(service.save).mockRejectedValueOnce(new Error('Private backend details'))
    mount()
    await selectKit()
    change(labels.voice, 'Playful')
    fireEvent.click(screen.getByRole('button', { name: labels.save }))
    expect(await screen.findByRole('alert')).toHaveTextContent(labels.saveFailed)
    expect(screen.getByLabelText(labels.voice)).toHaveValue('Playful')
    fireEvent.click(screen.getByRole('button', { name: labels.save }))
    await waitFor(() => expect(screen.getByRole('button', { name: labels.apply })).toBeEnabled())
  })
  it('reports an apply failure without closing or silently retrying', async () => {
    onApply.mockRejectedValueOnce(new Error('Apply failed'))
    mount({ selectedKitId: kit.id })
    await screen.findByLabelText(labels.name)
    fireEvent.click(screen.getByRole('button', { name: labels.apply }))
    expect(await screen.findByRole('alert')).toHaveTextContent(labels.applyFailed)
    expect(onApply).toHaveBeenCalledOnce()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
  it('aborts an old load when the context changes and ignores its late result', async () => {
    const pending = deferred<readonly OmniRogueBrandKit[]>()
    vi.mocked(service.list).mockReturnValueOnce(pending.promise)
    const view = mount()
    await waitFor(() => expect(service.list).toHaveBeenCalledOnce())
    const signal = vi.mocked(service.list).mock.calls[0][0].signal
    view.rerender(<OmniRogueBrandKitDrawer {...view.props} contextKey="account-b" />)
    await screen.findByRole('button', { name: kit.name })
    await act(async () => pending.resolve([{ ...kit, name: 'Stale account' }]))
    expect(signal.aborted).toBe(true)
    expect(screen.queryByRole('button', { name: 'Stale account' })).not.toBeInTheDocument()
  })
  it('ignores a late save after changing adapters', async () => {
    const pending = deferred<OmniRogueBrandKit>()
    vi.mocked(service.save).mockReturnValueOnce(pending.promise)
    const view = mount()
    await selectKit()
    change(labels.voice, 'Playful')
    fireEvent.click(screen.getByRole('button', { name: labels.save }))
    const signal = vi.mocked(service.save).mock.calls[0][1].signal
    const nextService: OmniRogueBrandKitService = { ...service, list: vi.fn().mockResolvedValue([otherKit]) }
    view.rerender(<OmniRogueBrandKitDrawer {...view.props} service={nextService} />)
    await screen.findByRole('button', { name: otherKit.name })
    await act(async () => pending.resolve({ ...kit, name: 'Late save' }))
    expect(signal.aborted).toBe(true)
    expect(screen.queryByRole('button', { name: 'Late save' })).not.toBeInTheDocument()
  })
  it('aborts a pending apply on unmount and does not close the replacement', async () => {
    const pending = deferred<void>()
    onApply.mockReturnValueOnce(pending.promise)
    const view = mount()
    await selectKit()
    fireEvent.click(screen.getByRole('button', { name: labels.apply }))
    const signal = onApply.mock.calls[0][1].signal
    view.unmount()
    await act(async () => pending.resolve())
    expect(signal.aborted).toBe(true)
    expect(onOpenChange).not.toHaveBeenCalled()
  })
  it('accepts translated labels for fields, actions, and validation', async () => {
    mount({ labels: { title: 'Identité', name: 'Nom', save: 'Enregistrer', nameRequired: 'Nom requis' } })
    expect(screen.getByRole('dialog', { name: 'Identité' })).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: labels.newKit }))
    expect(screen.getByLabelText('Nom')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Nom requis')
  })
})
