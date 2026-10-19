// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OmniRogueAssetInspector } from './OmniRogueAssetInspector'
import type { OmniRogueAssetInspectorProps } from './OmniRogueAssetInspector'
import {
  OMNIROGUE_ASSET_INSPECTOR_LABELS, assetFileName, assetInspectorFields, formatAssetBytes,
  formatAssetCreatedAt, formatAssetCredits, formatAssetDimensions, formatAssetDuration,
  resolveAssetInspectorLabels, safeAssetPreviewUrl
} from './omnirogue-asset-inspector-helpers'
import type { OmniRogueInspectedAsset } from './omnirogue-asset-inspector-helpers'

const L = OMNIROGUE_ASSET_INSPECTOR_LABELS
const image: OmniRogueInspectedAsset = {
  id: 'asset-1', path: '/work/media/generated art.png', kind: 'image', aspectRatio: '4:5',
  previewUrl: 'blob:app://omni/1234', width: 1080, height: 1350, sizeBytes: 2_450_000,
  model: ' flux-pro ', prompt: '  A lighthouse at dusk  ', credits: 12.5, createdAt: '2026-10-16T12:00:00Z'
}
const video: OmniRogueInspectedAsset = {
  id: 'asset-2', path: 'C:\\media\\clip.mp4', kind: 'video', aspectRatio: '9:16',
  previewUrl: 'file:///C:/media/clip.mp4', durationSeconds: 75.4
}
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function mount(overrides: Partial<OmniRogueAssetInspectorProps> = {}) {
  const props: OmniRogueAssetInspectorProps = { asset: image, onCopy: vi.fn().mockResolvedValue(undefined), ...overrides }
  return { ...render(<OmniRogueAssetInspector {...props} />), props }
}
const button = (name: string) => screen.getByRole('button', { name })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('asset inspector labels and formatting', () => {
  it('merges non-blank label overrides without mutating defaults', () => {
    const labels = resolveAssetInspectorLabels({ title: 'Inspecteur', copyPath: '  ', reveal: '' })
    expect(labels.title).toBe('Inspecteur')
    expect(labels.copyPath).toBe(L.copyPath)
    expect(labels.reveal).toBe(L.reveal)
    labels.empty = 'changed'
    expect(resolveAssetInspectorLabels().empty).toBe(L.empty)
  })
  it('formats sizes, durations, dimensions, credits and dates', () => {
    expect(formatAssetBytes(0)).toBe('0 bytes')
    expect(formatAssetBytes(512)).toBe('512 bytes')
    expect(formatAssetBytes(2_450_000)).toBe('2.5 MB')
    expect(formatAssetDuration(75.4)).toBe('1:15')
    expect(formatAssetDuration(3_725)).toBe('1:02:05')
    expect(formatAssetDuration(0)).toBe('0:00')
    expect(formatAssetDimensions(1080, 1350)).toBe('1,080 × 1,350')
    expect(formatAssetCredits(12.5, 'cr')).toBe('12.5 cr')
    expect(formatAssetCreatedAt('2026-10-16T12:00:00Z')).toContain('2026')
    expect(formatAssetCreatedAt(Date.UTC(2026, 9, 16))).toContain('2026')
  })
  it.each([Number.NaN, Infinity, -1, undefined])('omits invalid numeric value %s', (value) => {
    expect(formatAssetBytes(value)).toBeNull()
    expect(formatAssetDuration(value)).toBeNull()
    expect(formatAssetCredits(value, 'cr')).toBeNull()
    expect(formatAssetDimensions(value, 100)).toBeNull()
    expect(formatAssetDimensions(100, value)).toBeNull()
  })
  it('rejects zero dimensions and unparseable dates', () => {
    expect(formatAssetDimensions(0, 100)).toBeNull()
    expect(formatAssetCreatedAt('not a date')).toBeNull()
    expect(formatAssetCreatedAt('')).toBeNull()
    expect(formatAssetCreatedAt(undefined)).toBeNull()
  })
  it('derives file names from POSIX and Windows paths', () => {
    expect(assetFileName('/work/media/generated art.png')).toBe('generated art.png')
    expect(assetFileName('C:\\media\\clip.mp4')).toBe('clip.mp4')
    expect(assetFileName('/work/media/')).toBe('media')
    expect(assetFileName('clip.mp4')).toBe('clip.mp4')
  })
  it.each([
    ['blob:app://omni/1234', 'image'], ['file:///tmp/a.png', 'image'], ['https://cdn.omnirogue.com/a.png', 'image'],
    ['data:image/png;base64,AAAA', 'image'], ['data:video/mp4;base64,AAAA', 'video']
  ] as const)('allows preview URL %s', (url, kind) => {
    expect(safeAssetPreviewUrl(url, kind)).toBe(url)
  })
  it.each([
    ['javascript:alert(1)', 'image'], ['http://example.com/a.png', 'image'], ['data:image/svg+xml;base64,AAAA', 'image'],
    ['data:text/html;base64,AAAA', 'image'], ['data:image/png;base64,AAAA', 'video'], ['/relative/a.png', 'image'],
    ['   ', 'image'], [undefined, 'image']
  ] as const)('rejects preview URL %s', (url, kind) => {
    expect(safeAssetPreviewUrl(url, kind)).toBeNull()
  })
  it('lists only known fields, with duration for video only', () => {
    const labels = resolveAssetInspectorLabels()
    expect(assetInspectorFields(image, labels).map((field) => field.key))
      .toEqual(['kind', 'aspectRatio', 'dimensions', 'size', 'model', 'credits', 'createdAt'])
    expect(assetInspectorFields({ ...image, kind: 'image', durationSeconds: 10 }, labels).some((field) => field.key === 'duration')).toBe(false)
    expect(assetInspectorFields(video, labels).map((field) => [field.key, field.value]))
      .toEqual([['kind', L.video], ['aspectRatio', '9:16'], ['duration', '1:15']])
    expect(assetInspectorFields({ ...image, model: '   ' }, labels).some((field) => field.key === 'model')).toBe(false)
  })
})

describe('asset inspector panel', () => {
  it('shows the empty state with a close control', () => {
    const onClose = vi.fn()
    mount({ asset: null, onClose })
    expect(screen.getByRole('region', { name: L.title })).toBeInTheDocument()
    expect(screen.getByText(L.empty)).toBeInTheDocument()
    fireEvent.click(button(L.close))
    expect(onClose).toHaveBeenCalledOnce()
  })
  it('renders the image preview, metadata, path and trimmed prompt', () => {
    mount()
    expect(screen.getByRole('heading', { name: 'generated art.png' })).toHaveAttribute('title', image.path)
    expect(screen.getByRole('img', { name: L.previewAlt })).toHaveAttribute('src', image.previewUrl)
    expect(screen.getByText(L.dimensions).nextElementSibling).toHaveTextContent('1,080 × 1,350')
    expect(screen.getByText(L.model).nextElementSibling).toHaveTextContent('flux-pro')
    expect(screen.getByText(L.credits).nextElementSibling).toHaveTextContent('12.5 cr')
    expect(screen.getByText(L.path).nextElementSibling).toHaveTextContent(image.path)
    expect(screen.getByText('A lighthouse at dusk')).toBeInTheDocument()
    expect(screen.queryByText(L.duration)).toBeNull()
    expect(screen.queryByRole('button', { name: L.reveal })).toBeNull()
    expect(screen.queryByRole('button', { name: L.insert })).toBeNull()
    expect(screen.queryByRole('button', { name: L.close })).toBeNull()
  })
  it('renders a muted video preview without autoplay', () => {
    const { container } = mount({ asset: video })
    const element = container.querySelector('video')
    expect(element).toHaveAttribute('src', video.previewUrl)
    expect(element).toHaveAttribute('aria-label', L.previewAlt)
    expect(element?.muted).toBe(true)
    expect(element).not.toHaveAttribute('autoplay')
    expect(screen.getByText(L.duration).nextElementSibling).toHaveTextContent('1:15')
    expect(screen.queryByRole('button', { name: L.copyPrompt })).toBeNull()
  })
  it('falls back when the preview URL is unsafe or fails to load', () => {
    const { rerender, props } = mount({ asset: { ...image, previewUrl: 'javascript:alert(1)' } })
    expect(screen.queryByRole('img', { name: L.previewAlt })).toBeNull()
    expect(screen.getByText(L.previewUnavailable)).toBeInTheDocument()
    rerender(<OmniRogueAssetInspector {...props} asset={image} />)
    fireEvent.error(screen.getByRole('img', { name: L.previewAlt }))
    expect(screen.getByText(L.previewUnavailable)).toBeInTheDocument()
    rerender(<OmniRogueAssetInspector {...props} asset={{ ...image, previewUrl: 'blob:app://omni/5678' }} />)
    expect(screen.getByRole('img', { name: L.previewAlt })).toHaveAttribute('src', 'blob:app://omni/5678')
  })
  it('uses label overrides for every visible control', () => {
    mount({ onReveal: vi.fn(), onInsert: vi.fn(), onClose: vi.fn(), labels: {
      title: 'Inspecteur', copyPath: 'Copier le chemin', copyPrompt: 'Copier le prompt', reveal: 'Afficher',
      insert: 'Insérer', close: 'Fermer', image: 'Photo', details: 'Détails'
    } })
    expect(screen.getByRole('region', { name: 'Inspecteur' })).toBeInTheDocument()
    for (const name of ['Copier le chemin', 'Copier le prompt', 'Afficher', 'Insérer', 'Fermer']) {
      expect(button(name)).toBeInTheDocument()
    }
    expect(screen.getAllByText('Photo')).toHaveLength(2)
    expect(screen.getByText('Détails')).toBeInTheDocument()
  })
  it('copies the path and prompt and announces the result', async () => {
    const { props } = mount()
    fireEvent.click(button(L.copyPath))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(L.copied))
    expect(props.onCopy).toHaveBeenCalledWith(image.path)
    fireEvent.click(button(L.copyPrompt))
    await waitFor(() => expect(props.onCopy).toHaveBeenLastCalledWith('A lighthouse at dusk'))
  })
  it('falls back to the system clipboard and reports failures', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { userAgent: navigator.userAgent, clipboard: { writeText } })
    mount({ onCopy: undefined })
    fireEvent.click(button(L.copyPath))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(L.copyFailed))
    expect(writeText).toHaveBeenCalledWith(image.path)
    expect(screen.getByRole('status')).toHaveClass('text-destructive')
  })
  it('blocks concurrent actions while one is pending', async () => {
    const pending = deferred()
    const onInsert = vi.fn(() => pending.promise)
    const onReveal = vi.fn()
    mount({ onInsert, onReveal })
    fireEvent.click(button(L.insert))
    await waitFor(() => expect(button(L.reveal)).toBeDisabled())
    fireEvent.click(button(L.insert))
    expect(onInsert).toHaveBeenCalledOnce()
    expect(onInsert).toHaveBeenCalledWith(image)
    pending.resolve()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(L.inserted))
    expect(button(L.reveal)).toBeEnabled()
  })
  it('reveals silently on success and reports reveal or insert failures', async () => {
    const onReveal = vi.fn().mockResolvedValue(undefined)
    const onInsert = vi.fn().mockRejectedValue(new Error('terminal gone'))
    mount({ onReveal, onInsert })
    fireEvent.click(button(L.reveal))
    await waitFor(() => expect(button(L.reveal)).toBeEnabled())
    expect(onReveal).toHaveBeenCalledWith(image)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    fireEvent.click(button(L.insert))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(L.insertFailed))
    onReveal.mockRejectedValueOnce(new Error('missing'))
    fireEvent.click(button(L.reveal))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(L.revealFailed))
  })
  it('drops a pending result when the selected asset changes', async () => {
    const pending = deferred()
    const onInsert = vi.fn(() => pending.promise)
    const { rerender, props } = mount({ onInsert })
    fireEvent.click(button(L.insert))
    await waitFor(() => expect(button(L.copyPath)).toBeDisabled())
    rerender(<OmniRogueAssetInspector {...props} onInsert={onInsert} asset={video} />)
    expect(screen.getByRole('heading', { name: 'clip.mp4' })).toBeInTheDocument()
    expect(button(L.copyPath)).toBeEnabled()
    pending.reject(new Error('late'))
    await pending.promise.catch(() => {})
    await waitFor(() => expect(screen.getByRole('status')).toBeEmptyDOMElement())
  })
  it('keeps action state when the same asset gains metadata', async () => {
    const { rerender, props } = mount()
    fireEvent.click(button(L.copyPath))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(L.copied))
    rerender(<OmniRogueAssetInspector {...props} asset={{ ...image, credits: 20 }} />)
    expect(screen.getByRole('status')).toHaveTextContent(L.copied)
    expect(screen.getByText(L.credits).nextElementSibling).toHaveTextContent('20 cr')
  })
})
