// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { DaemonVersionDriftNotice } from './DaemonVersionDriftNotice'

let agentStatusByPaneKey: Record<string, Pick<AgentStatusEntry, 'state'>> = {}

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { agentStatusByPaneKey: unknown }) => unknown) =>
    selector({ agentStatusByPaneKey })
}))

let container: HTMLDivElement
let root: Root

function stubDaemonVersion(daemonAppVersion: string | null, appVersion = '1.9.4'): void {
  Object.assign(window, {
    api: {
      pty: {
        management: {
          daemonVersion: vi.fn(async () => ({ daemonAppVersion, appVersion }))
        }
      }
    }
  })
}

async function render(onRestartDaemon = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  await act(async () => {
    root.render(<DaemonVersionDriftNotice onRestartDaemon={onRestartDaemon} />)
  })
  return onRestartDaemon
}

beforeEach(() => {
  agentStatusByPaneKey = {}
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'api')
})

it('names the daemon version and offers a restart when the daemon lags the app', async () => {
  stubDaemonVersion('1.9.0')
  const onRestartDaemon = await render()

  const notice = container.querySelector('[data-daemon-version-drift-notice]')
  expect(notice?.textContent).toContain(
    'Terminal daemon is from 1.9.0; restart it when your sessions are idle to apply updates'
  )
  const button = notice?.querySelector('button')
  expect(button?.disabled).toBe(false)
  await act(async () => {
    button?.click()
  })
  expect(onRestartDaemon).toHaveBeenCalledTimes(1)
})

it('renders nothing when the daemon matches the app or its version is unknown', async () => {
  stubDaemonVersion('1.9.4')
  await render()
  expect(container.querySelector('[data-daemon-version-drift-notice]')).toBeNull()

  stubDaemonVersion(null)
  await act(async () => {
    root.render(<DaemonVersionDriftNotice key="fresh" onRestartDaemon={vi.fn()} />)
  })
  expect(container.querySelector('[data-daemon-version-drift-notice]')).toBeNull()
})

it('disables the restart while any PTY is busy and explains why', async () => {
  agentStatusByPaneKey = { 'tab-1:leaf-1': { state: 'working' }, 'tab-2:leaf-1': { state: 'done' } }
  stubDaemonVersion('1.9.0')
  const onRestartDaemon = await render()

  const notice = container.querySelector('[data-daemon-version-drift-notice]')
  const button = notice?.querySelector('button')
  expect(button?.disabled).toBe(true)
  expect(button?.parentElement?.getAttribute('title')).toBe('Wait until every terminal is idle')
  await act(async () => {
    button?.click()
  })
  expect(onRestartDaemon).not.toHaveBeenCalled()
})
