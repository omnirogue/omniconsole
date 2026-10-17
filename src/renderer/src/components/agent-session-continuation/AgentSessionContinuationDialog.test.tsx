// @vitest-environment happy-dom

import React, { type ReactNode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'

const mocks = vi.hoisted(() => ({
  detectAgents: vi.fn(),
  launchContinuation: vi.fn(),
  settings: {
    defaultTuiAgent: 'codex',
    disabledTuiAgents: [],
    agentAccountProfiles: [
      { id: 'p1', label: 'Pool slot 3', agent: 'codex', configDir: '/pool/codex-3' }
    ]
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ settings: mocks.settings })
}))
vi.mock('@/lib/launch-agent-session-continuation', () => ({
  detectAgentSessionContinuationAgents: mocks.detectAgents,
  launchAgentSessionContinuation: mocks.launchContinuation
}))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }],
  getAgentLabel: () => 'Codex'
}))
vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({ value }: { value: string | null }) =>
    React.createElement('div', { 'data-agent': value ?? '' })
}))
vi.mock('@/components/build-review/BuildReviewAgentFields', () => ({
  BuildReviewModelEffortFields: ({
    agent,
    onChange
  }: {
    agent: string
    onChange: (choice: { model?: string; effort?: string }) => void
  }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        'data-actor-agent': agent,
        'data-testid': 'pick-actor',
        onClick: () => onChange({ model: 'opus', effort: 'max' })
      },
      'pick actor'
    )
}))
vi.mock('@/components/agent/AgentAccountSelect', () => ({
  AgentAccountSelect: ({ onChange }: { onChange: (id: string | null) => void }) =>
    React.createElement(
      'button',
      { type: 'button', 'data-testid': 'pick-account', onClick: () => onChange('profile:p1') },
      'pick account'
    )
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children?: ReactNode }) =>
    React.createElement('footer', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) =>
    React.createElement('header', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => React.createElement('h2', null, children)
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => React.createElement('div', null, children),
  SelectContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectItem: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectTrigger: ({ children }: { children?: ReactNode }) =>
    React.createElement('button', null, children),
  SelectValue: () => React.createElement('span')
}))

import { AgentSessionContinuationDialog } from './AgentSessionContinuationDialog'

function request(worktreeId: string): AgentSessionContinuationRequest {
  return {
    source: { capturedText: 'previous session', sourceAgent: 'codex' },
    worktreeId,
    workspacePath: '/repo',
    launchSource: 'sidebar'
  }
}

describe('AgentSessionContinuationDialog', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('clears a prior detection failure while detecting a new request', async () => {
    let resolveSecond: (agents: ['codex']) => void = () => {}
    mocks.detectAgents.mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(
      new Promise<['codex']>((resolve) => {
        resolveSecond = resolve
      })
    )

    await act(async () => {
      root.render(
        <AgentSessionContinuationDialog open request={request('wt-1')} onOpenChange={vi.fn()} />
      )
    })
    await vi.waitFor(() => expect(container.textContent).toContain('Could not detect Agents'))

    act(() => {
      root.render(
        <AgentSessionContinuationDialog open request={request('wt-2')} onOpenChange={vi.fn()} />
      )
    })
    expect(container.textContent).toContain('Detecting Agents')
    expect(container.textContent).not.toContain('Could not detect Agents')

    await act(async () => resolveSecond(['codex']))
    await vi.waitFor(() => expect(container.querySelector('[data-agent="codex"]')).not.toBeNull())
  })
  it('forwards the picked actor (model, effort, account directory) to the launch', async () => {
    mocks.detectAgents.mockResolvedValue(['codex'])
    mocks.launchContinuation.mockResolvedValue(true)

    await act(async () => {
      root.render(
        <AgentSessionContinuationDialog open request={request('wt-1')} onOpenChange={vi.fn()} />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('[data-agent="codex"]')).not.toBeNull())
    expect(container.querySelector('[data-actor-agent="codex"]')).not.toBeNull()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="pick-actor"]')?.click()
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="pick-account"]')?.click()
    })
    const start = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Start New Session')
    )
    await act(async () => {
      start?.click()
    })

    await vi.waitFor(() =>
      expect(mocks.launchContinuation).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'codex',
          launchPreferences: { model: 'opus', effort: 'max' },
          launchEnv: { CODEX_HOME: '/pool/codex-3' }
        })
      )
    )
  })
})
