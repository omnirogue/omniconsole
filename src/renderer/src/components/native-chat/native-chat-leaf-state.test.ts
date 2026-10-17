import { afterEach, expect, it } from 'vitest'
import {
  forgetNativeChatLeaf,
  setNativeChatLeaf,
  useNativeChatLeafState
} from './native-chat-leaf-state'

afterEach(() => useNativeChatLeafState.setState({ nativeChatLeafByTabId: {} }))

it('removes retained and null entries without reallocating for unknown tabs', () => {
  setNativeChatLeaf('closed', 'owner')
  setNativeChatLeaf('cleared', null)
  setNativeChatLeaf('survivor', 'other')
  const before = useNativeChatLeafState.getState()
  forgetNativeChatLeaf(['unknown'])
  expect(useNativeChatLeafState.getState()).toBe(before)
  forgetNativeChatLeaf(new Set(['closed', 'cleared']))
  expect(useNativeChatLeafState.getState().nativeChatLeafByTabId).toEqual({ survivor: 'other' })
  const after = useNativeChatLeafState.getState()
  forgetNativeChatLeaf(['closed', 'cleared'])
  expect(useNativeChatLeafState.getState()).toBe(after)
})
