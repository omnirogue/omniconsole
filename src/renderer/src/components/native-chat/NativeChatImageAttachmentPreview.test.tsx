// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetLocalImageSrcStateForTests } from '@/components/editor/useLocalImageSrc'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogContent: ({ children }: { children: ReactNode }) => children,
  DialogDescription: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => children
}))

const localPath = '/private/var/tmp/omni-paste-retained.png'
const grants = new Set<string>()
const authorizeExternalPath = vi.fn()
const readFile = vi.fn()
let root: Root | null = null
let container: HTMLDivElement
let previousApi: Window['api']

async function renderPreview(path = localPath, connectionId?: string): Promise<void> {
  root ??= createRoot(container)
  await act(async () => {
    root?.render(
      createElement(NativeChatImageAttachmentPreview, {
        attachment: { id: 'retained-image', path, connectionId },
        onRemove: () => {}
      })
    )
  })
}

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  grants.clear()
  authorizeExternalPath.mockReset().mockImplementation(async ({ targetPath }) => {
    grants.add(targetPath)
  })
  readFile.mockReset().mockImplementation(async ({ filePath, connectionId }) => {
    if (!connectionId && !grants.has(filePath)) {
      throw new Error('Access denied: path resolves outside allowed directories')
    }
    return { content: 'AA==', isBinary: true, mimeType: 'image/png' }
  })
  previousApi = window.api
  window.api = { fs: { authorizeExternalPath, readFile } } as unknown as Window['api']
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:retained-image')
  vi.spyOn(URL, 'revokeObjectURL').mockReset()
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
  resetLocalImageSrcStateForTests()
  window.api = previousApi
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('retained composer attachment previews', () => {
  it('renews the exact local image grant after restart discards grants and the image cache', async () => {
    await renderPreview()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:retained-image')
    expect(authorizeExternalPath).toHaveBeenCalledExactlyOnceWith({ targetPath: localPath })
    expect(readFile).toHaveBeenCalledExactlyOnceWith({
      filePath: localPath,
      connectionId: undefined
    })

    await act(async () => root?.unmount())
    root = null
    grants.clear()
    resetLocalImageSrcStateForTests()
    await renderPreview()

    expect(authorizeExternalPath).toHaveBeenCalledTimes(2)
    expect(readFile).toHaveBeenCalledTimes(2)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:retained-image')
    expect([...grants]).toEqual([localPath])
  })

  it('reads an SSH attachment from its owner without granting a client-local path', async () => {
    await renderPreview('/tmp/omni-paste-remote.png', 'ssh-owner')
    expect(authorizeExternalPath).not.toHaveBeenCalled()
    expect(readFile).toHaveBeenCalledExactlyOnceWith({
      filePath: '/tmp/omni-paste-remote.png',
      connectionId: 'ssh-owner'
    })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:retained-image')
  })

  it('does not read before authorization or bypass a rejected grant', async () => {
    let rejectGrant: (error: Error) => void = () => {}
    authorizeExternalPath.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectGrant = reject
      })
    )
    await renderPreview()
    expect(readFile).not.toHaveBeenCalled()
    await act(async () => rejectGrant(new Error('File unavailable')))
    expect(readFile).not.toHaveBeenCalled()
    expect(container.querySelector('img')).toBeNull()
  })

  it('ignores a completed grant for an attachment that has since changed', async () => {
    const pending = new Map<string, () => void>()
    authorizeExternalPath.mockImplementation(
      ({ targetPath }) =>
        new Promise<void>((resolve) => {
          pending.set(targetPath, () => {
            grants.add(targetPath)
            resolve()
          })
        })
    )
    await renderPreview()
    const replacement = '/private/var/tmp/omni-paste-replacement.png'
    await renderPreview(replacement)
    await act(async () => pending.get(localPath)?.())
    expect(readFile).not.toHaveBeenCalled()
    await act(async () => pending.get(replacement)?.())
    expect(readFile).toHaveBeenCalledExactlyOnceWith({
      filePath: replacement,
      connectionId: undefined
    })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:retained-image')
  })
})
