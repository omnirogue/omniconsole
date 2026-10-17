// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getByRole } from '@testing-library/dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AutomationNotificationFields } from './AutomationNotificationFields'
import { buildAutomationEditDraft } from './automation-edit-draft'
import { makeAutomation } from './automations-page-fixtures'
const status = vi.fn()
const listChannels = vi.fn()
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ openSettingsPage: vi.fn() }) } }))
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { alerts: { slack: { status, listChannels } } }
  })
  listChannels.mockResolvedValue([{ id: 'C1', name: 'test-alerts' }])
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
function Harness() {
  const [draft, setDraft] = useState(
    buildAutomationEditDraft(
      makeAutomation({
        notify: {
          onFinish: true,
          onlyWhenNotable: true,
          channels: [
            { kind: 'desktop' },
            { kind: 'slack-channel', channelId: 'C1', channelName: 'test-alerts' }
          ]
        }
      })
    )
  )
  return (
    <TooltipProvider>
      <AutomationNotificationFields draft={draft} onDraftChange={setDraft} />
    </TooltipProvider>
  )
}
it.each([
  [{ authenticated: false, connection: null }, 'Sign in to your company account'],
  [{ authenticated: true, connection: null }, 'Slack is not connected on the hub'],
  [{ authenticated: true, connection: { id: 'T1', title: 'Company' } }, 'Slack: Company']
])('renders the account connection state', async (value, message) => {
  status.mockResolvedValue(value)
  await act(async () => {
    root.render(<Harness />)
  })
  expect(container.textContent).toContain(message)
  const dm = Array.from(container.querySelectorAll('label'))
    .find((label) => label.textContent?.includes('Slack direct message'))
    ?.querySelector('button')
  expect(dm?.disabled).toBe(!value.authenticated || !value.connection)
})
it('shows the configured searchable channel list and refresh action', async () => {
  status.mockResolvedValue({ authenticated: true, connection: { id: 'T1', title: 'Company' } })
  await act(async () => {
    root.render(<Harness />)
  })
  expect(container.textContent).toContain('#test-alerts')
  await act(async () => {
    getByRole(container, 'combobox', { name: 'Choose Slack channels' }).click()
  })
  expect(document.body.textContent).toContain('Refresh channels')
  expect(document.body.querySelector('[placeholder="Search or type #channel"]')).not.toBeNull()
})
