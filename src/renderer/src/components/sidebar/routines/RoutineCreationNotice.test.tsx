// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { makeAutomation } from '@/components/automations/automations-page-fixtures'
import { isRoutineBackedSession } from '@/lib/routine-backed-session'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { RoutineCreationNotice } from './RoutineCreationNotice'
import { useRoutineSessionCatalog } from './routine-session-catalog'

vi.mock('@/components/automations/automation-host-client', () => ({
  getAutomationHostTargetKey: () => 'local'
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_: string, text: string, params: { name: string }) =>
    text.replace('{{name}}', params.name)
}))

it.each(['terminal', 'structured'] as const)(
  'shows the creation system line while the creating %s chat stays free-standing',
  async (kind) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const automation = makeAutomation({
      name: 'Briefing',
      executionTargetType: 'local',
      createdFromSession: {
        tabId: 'creating-chat',
        paneKey: kind === 'structured' ? 'creating-chat:synthetic-native-pane' : null
      }
    })
    const owner = { automation, sourceTarget: { kind: 'local' as const } }
    const session = {
      tabId: 'creating-chat',
      paneKey: null,
      sessionKey: null,
      hostId: 'local',
      kind
    } as SidebarSession
    useRoutineSessionCatalog.setState({ owners: [owner] })
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => root.render(<RoutineCreationNotice session={session} />))
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        "Routine 'Briefing' created. Open it from Conversations."
      )
      expect(isRoutineBackedSession(session, [owner])).toBe(false)
      expect(automation.conversation).toBeUndefined()
    } finally {
      await act(async () => root.unmount())
      useRoutineSessionCatalog.setState({ owners: [] })
    }
  }
)
