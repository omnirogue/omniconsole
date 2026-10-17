/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getSetupScriptPromptDismissalKey } from '@/lib/setup-script-prompt'
import { useAppStore } from '@/store'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { getDefaultUIState } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Why: the card decides visibility from the real store (active repo, dismissals,
// persisted UI hydration). Only the host calls it makes are stubbed.
const hooksCheck = vi.fn()
const inspectImports = vi.fn()
const uiSet = vi.fn()
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('./setup-script-prompt-exposure-telemetry', () => ({
  trackSetupScriptPromptExposure: vi.fn()
}))
import SetupScriptPromptCard from './SetupScriptPromptCard'

const samRepo: Repo = {
  id: 'repo-sal',
  path: '/Users/me/omni-ide-worktrees/sal',
  displayName: 'sal',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local'
}
const otherRepo: Repo = {
  id: 'repo-other',
  path: '/Users/me/other',
  displayName: 'other',
  badgeColor: '#000',
  addedAt: 2,
  executionHostId: 'local'
}

const initialState = useAppStore.getInitialState()
let root: Root | null = null

beforeEach(() => {
  hooksCheck.mockReset().mockResolvedValue({ status: 'ok', hasHooks: false, hooks: null })
  inspectImports.mockReset().mockResolvedValue([
    {
      provider: 'package-manager',
      label: 'pnpm',
      files: ['pnpm-lock.yaml'],
      setup: 'pnpm install'
    }
  ])
  uiSet.mockReset().mockResolvedValue(undefined)
  ;(window as unknown as { api: unknown }).api = {
    hooks: { check: hooksCheck, inspectSetupScriptImports: inspectImports },
    ui: { set: uiSet }
  }
  useAppStore.setState(initialState, true)
  useAppStore.setState({
    sidebarOpen: true,
    repos: [samRepo, otherRepo],
    activeRepoId: samRepo.id,
    activeWorktreeId: null
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  useAppStore.setState(initialState, true)
  document.body.replaceChildren()
  delete (window as unknown as { api?: unknown }).api
})

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

async function mountCard(): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  const mounted = createRoot(container)
  root = mounted
  await act(async () => {
    mounted.render(
      <TooltipProvider>
        <SetupScriptPromptCard />
      </TooltipProvider>
    )
  })
  await settle()
  return container
}

function card(container: HTMLElement): Element | null {
  return container.querySelector('[data-setup-script-prompt-layer]')
}

describe('SetupScriptPromptCard dismissal on the real store', () => {
  it('shows the detected pnpm install suggestion for a project without a setup script', async () => {
    const container = await mountCard()

    expect(card(container)).not.toBeNull()
    expect(container.textContent).toContain('Add a setup script')
    expect(container.textContent).toContain('sal')
  })

  it('hides the card on Dismiss and persists the dismissal for that project only', async () => {
    const container = await mountCard()
    const dismiss = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss setup scripts"]'
    )
    expect(dismiss).not.toBeNull()

    await act(async () => {
      dismiss!.click()
    })
    await settle()

    const key = getSetupScriptPromptDismissalKey(getRepoHostIdentity(samRepo))
    expect(card(container)).toBeNull()
    expect(useAppStore.getState().setupScriptPromptDismissedRepoIds).toEqual([key])
    expect(uiSet).toHaveBeenCalledWith({ setupScriptPromptDismissedRepoIds: [key] })

    // Why: a dismissal is per project — switching to another project still offers its card.
    act(() => useAppStore.setState({ activeRepoId: otherRepo.id }))
    await settle()
    expect(card(container)).not.toBeNull()
    expect(container.textContent).toContain('other')
  })

  it('keeps a persisted dismissal hidden after the next launch hydrates it', async () => {
    const key = getSetupScriptPromptDismissalKey(getRepoHostIdentity(samRepo))
    // Why: a relaunch starts from a fresh store, then hydrates the persisted UI
    // state written by the earlier Dismiss (window.api.ui.set).
    act(() => {
      useAppStore
        .getState()
        .hydratePersistedUI({ ...getDefaultUIState(), setupScriptPromptDismissedRepoIds: [key] })
    })
    expect(useAppStore.getState().setupScriptPromptDismissedRepoIds).toEqual([key])

    const container = await mountCard()

    expect(card(container)).toBeNull()
    expect(hooksCheck).not.toHaveBeenCalled()

    act(() => useAppStore.setState({ activeRepoId: otherRepo.id }))
    await settle()
    expect(card(container)).not.toBeNull()
  })

  it('hides the card once the project has an effective local setup script', async () => {
    act(() =>
      useAppStore.setState({
        repos: [
          {
            ...samRepo,
            hookSettings: {
              mode: 'auto',
              setupRunPolicy: 'run-by-default',
              setupAgentStartupPolicy: 'start-immediately',
              scripts: { setup: 'pnpm install', archive: '' },
              commandSourcePolicy: 'local-only'
            }
          },
          otherRepo
        ]
      })
    )

    const container = await mountCard()

    expect(card(container)).toBeNull()
    expect(inspectImports).not.toHaveBeenCalled()
  })
})
