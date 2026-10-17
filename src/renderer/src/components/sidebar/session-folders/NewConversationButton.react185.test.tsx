/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { mountOnRealStore, resetRealStore, type RealStoreMount } from '@/test/mount-on-real-store'
import { NewConversationButton } from './NewConversationButton'

/**
 * Why this test exists: the button shipped selecting an OBJECT built inside a
 * `useAppStore` selector. Every read was therefore a new snapshot, React's store
 * check re-rendered without end, and the sidebar died with minified React #185 the
 * moment the app launched with no workspace open.
 *
 * It has to mount on the REAL store. A test that mocks `@/store` with a plain
 * selector call cannot see snapshot identity at all, which is exactly why the unit
 * tests for this component were green while the app crashed.
 *
 * Note the repo gate does NOT cover this: `check-use-shallow-fresh-references`
 * only inspects `useShallow(` callbacks, and this selector never used `useShallow`.
 */
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: vi.fn(() => null) }))

let mounted: RealStoreMount | null = null

beforeEach(() => {
  resetRealStore()
})

afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  resetRealStore()
  document.body.replaceChildren()
})

describe('the New chat button on the real store', () => {
  it('renders with no workspace open instead of looping the renderer', async () => {
    useAppStore.setState({ activeWorktreeId: null })
    mounted = await mountOnRealStore(<NewConversationButton />, { windowApi: 'pending' })
    const button = mounted.container.querySelector('[data-new-conversation]')
    expect(button).not.toBeNull()
    // Why: no workspace means the control must refuse, and say so, rather than crash.
    expect((button as HTMLButtonElement).textContent).toContain('New conversation')
  })

  it('survives a settled mount and a store write without re-render churn', async () => {
    useAppStore.setState({ activeWorktreeId: null })
    mounted = await mountOnRealStore(<NewConversationButton />, {
      windowApi: 'pending',
      settle: 60
    })
    // Why: a fresh-object selector throws on the NEXT store write, not on mount, so the
    // write is the part that matters.
    useAppStore.setState({ activeWorktreeId: null })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(mounted.container.querySelector('[data-new-conversation]')).not.toBeNull()
  })
})
