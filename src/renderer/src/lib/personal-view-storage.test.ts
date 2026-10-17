import { beforeEach, describe, expect, it, vi } from 'vitest'
const { state } = vi.hoisted(() => ({
  state: {
    activeOrcaProfileId: 'profile',
    orcaProfileAuthStatus: { state: 'connected', cloud: { userId: 'sal', activeOrgId: 'company' } },
    settings: {
      backofficeEnv: 'production',
      backofficeProductionUrl: 'https://console.test',
      backofficeLocalUrl: ''
    }
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
import { personalViewStorageKey, readPersonalView } from './personal-view-storage'
import { createLocalSessionSidebarViewStorage } from './session-sidebar-view-storage'
import { createLocalSessionArchivedStorage } from './session-sidebar-archive-storage'
import { createSessionSidebarViewStore } from '../store/session-sidebar-view'

let data: Map<string, string>
const storage = {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => {
    data.set(key, value)
  }
}
beforeEach(() => {
  data = new Map()
  state.orcaProfileAuthStatus.state = 'connected'
  state.orcaProfileAuthStatus.cloud.userId = 'sal'
})
describe('personal sidebar persistence', () => {
  it('persists hiding, company restoration and order through store recreation and isolates people', () => {
    const source = createLocalSessionSidebarViewStorage(() => storage)
    const archives = createLocalSessionArchivedStorage(() => storage)
    const first = createSessionSidebarViewStore(source, archives)
    first.getState().setHidden('conversation:c1', true)
    first.getState().setHidden('session:s1', true)
    first.getState().setCompanyVisible('co_other', true)
    first.getState().moveRow('c2', 'c1', ['c1', 'c2'])
    const second = createSessionSidebarViewStore(source, archives)
    second.getState().load()
    // Why: since #135 Sessions and Conversations share one organizer, so a Sessions hide is saved
    // as the one shared conversation mark.
    expect(second.getState().view).toMatchObject({
      hidden: ['conversation:c1', 'conversation:s1'],
      rowOrder: ['c2', 'c1'],
      companyVisibility: { co_other: true }
    })
    state.orcaProfileAuthStatus.cloud.userId = 'colleague'
    second.getState().load()
    expect(second.getState().view.hidden).toEqual([])
    state.orcaProfileAuthStatus.cloud.userId = 'sal'
    second.getState().load()
    second.getState().setHidden('conversation:c1', false)
    expect(source.load().hidden).toEqual(['conversation:s1'])
  })
  it('keeps the same preferences while the same account reconnects', () => {
    const key = personalViewStorageKey('view')
    state.orcaProfileAuthStatus.state = 'reconnect-required'
    expect(personalViewStorageKey('view')).toBe(key)
  })
  it('migrates legacy presentation once without handing it to another person', () => {
    storage.setItem('view', '{"old":true}')
    expect(readPersonalView(storage, 'view')).toBe('{"old":true}')
    state.orcaProfileAuthStatus.cloud.userId = 'colleague'
    expect(readPersonalView(storage, 'view')).toBeNull()
  })
})
