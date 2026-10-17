// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readNativeChatComposerStorage,
  writeNativeChatComposerStorage
} from './native-chat-composer-storage'
import {
  readNativeChatDraftCache,
  writeNativeChatDraftCache,
  clearNativeChatDraftCacheForTests
} from './native-chat-draft-cache'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
})

describe('native composer restart storage', () => {
  it('restores unsent text after the renderer module is replaced', async () => {
    writeNativeChatDraftCache('account:tab:leaf', 'Unsent request')
    vi.resetModules()
    const restored = await import('./native-chat-draft-cache')
    expect(restored.readNativeChatDraftCache('account:tab:leaf')).toBe('Unsent request')
    expect(restored.readNativeChatDraftCache('account:tab:sibling')).toBe('')
    expect(restored.readNativeChatDraftCache('other-account:tab:leaf')).toBe('')
    restored.writeNativeChatDraftCache('account:tab:leaf', '')
    expect(readNativeChatComposerStorage('text', 'account:tab:leaf')).toBeUndefined()
  })

  it('retains image and file-reference source connections without copying image bytes', async () => {
    const images = [{ id: 'image-1', path: '/workspace/result.png', connectionId: 'ssh-owner' }]
    const references = [{ id: 'file-1', path: '/workspace/notes.md', connectionId: 'ssh-owner' }]
    writeNativeChatComposerStorage('images', 'account:tab:leaf', images)
    writeNativeChatComposerStorage('references', 'account:tab:leaf', references)
    vi.resetModules()
    const restored = await import('./native-chat-composer-storage')
    expect(restored.readNativeChatComposerStorage('images', 'account:tab:leaf')).toEqual(images)
    expect(restored.readNativeChatComposerStorage('references', 'account:tab:leaf')).toEqual(
      references
    )
    expect(restored.readNativeChatComposerStorage('images', 'account:tab:sibling')).toBeUndefined()
  })

  it('persists clearing and refuses to publish an unsaved change when storage fails', () => {
    writeNativeChatDraftCache('scope', 'saved')
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Storage refused')
    })
    expect(() => writeNativeChatDraftCache('scope', 'unsaved')).toThrow('Storage refused')
    write.mockRestore()
    expect(readNativeChatDraftCache('scope')).toBe('saved')
    writeNativeChatDraftCache('scope', '')
    expect(readNativeChatComposerStorage('text', 'scope')).toBeUndefined()
  })
})
