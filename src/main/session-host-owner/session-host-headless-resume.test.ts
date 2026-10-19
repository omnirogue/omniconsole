import { describe, expect, it, vi } from 'vitest'
import { sidebarRow } from '../session-manage/session-manage-test-fixtures'
import { headlessSessionResume } from './session-host-headless-resume'
import type { HostSessionInventory } from './host-session-inventory'

const resumeConversation = vi.hoisted(() => vi.fn())
vi.mock('../session-manage/session-manage-resume', () => ({ resumeConversation }))
vi.mock('../session-manage/session-manage-resume-runtime', () => ({
  runtimeResumeDeps: () => ({})
}))

describe('restart with no window', () => {
  it('names the pane its own resume confirmed, so the restart proof can read it', async () => {
    resumeConversation.mockResolvedValue({
      outcome: 'resumed',
      summary: 'Reopened it: the same conversation, confirmed by its agent.',
      tabId: 'tab-7',
      paneKey: 'tab-7:leaf-7'
    })
    const inventory = {
      rows: async () => ({
        rows: [sidebarRow({ paneKey: 'tab-2:leaf-2', providerSessionId: 'sess-1' })]
      })
    } as unknown as HostSessionInventory
    const resume = headlessSessionResume({} as never, inventory, '/tmp/user-data')
    expect(await resume({ paneKey: 'tab-2:leaf-2' })).toEqual({
      summary: 'Reopened it: the same conversation, confirmed by its agent.',
      tabId: 'tab-7',
      paneKey: 'tab-7:leaf-7'
    })
  })
})
