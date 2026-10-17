// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionChain } from '../../../../shared/session-chain-types'

const state = vi.hoisted(() => ({
  agentStatusByPaneKey: {
    'tab:r1': { paneKey: 'tab:r1', state: 'working', agentType: 'codex', model: 'gpt' }
  } as Record<string, unknown>,
  chain: null as SessionChain | null
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (store: typeof state) => unknown) => selector(state)
}))
vi.mock('@/lib/session-chain-registry', () => ({
  getSessionChain: () => state.chain,
  subscribeSessionChains: () => () => {}
}))
vi.mock('@/lib/sidebar-session-source-identity', () => ({
  sidebarSessionSourceIdentity: () => ({ sourceKey: 'tab:source' })
}))
import { SessionTeamPlanStrip } from './SessionTeamPlanStrip'
afterEach(cleanup)

const session = {
  paneKey: 'tab:source',
  rowKey: '["local","row"]',
  label: 'Work',
  agent: 'claude'
} as SidebarSession

function chain(steps: SessionChain['steps'], extra: Partial<SessionChain> = {}): SessionChain {
  return {
    id: 'chn_1',
    workspacePath: '/w',
    worktreeId: 'wt',
    hostId: null,
    sourcePaneKey: 'tab:source',
    sourceRowKey: session.rowKey,
    auto: false,
    steps,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    end: 'me',
    ...extra
  }
}

describe('SessionTeamPlanStrip', () => {
  it('shows the plan with live seats filling in and opens the rows', () => {
    state.chain = chain([
      {
        id: 's1',
        agent: 'codex',
        prompt: 'p',
        presetId: 'review',
        group: 'g1',
        status: 'launched',
        launchedPaneKey: 'tab:r1'
      },
      { id: 's2', agent: 'grok', prompt: 'p', presetId: 'review', group: 'g1', status: 'queued' },
      { id: 's3', agent: 'claude', prompt: 'p', presetId: 'synthesize', status: 'queued' }
    ])
    const { container } = render(<SessionTeamPlanStrip session={session} chainId="chn_1" />)
    expect(container.querySelector('[data-session-team-count]')?.textContent).toBe('0/3 done')
    expect(screen.getByText(/Current/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    const seats = [...container.querySelectorAll('[data-session-team-seat]')].map((seat) =>
      seat.getAttribute('data-session-team-seat')
    )
    expect(seats).toEqual(['working', 'planned', 'planned'])
    expect(container.querySelectorAll('[data-session-team-phase]')).toHaveLength(2)
  })

  it('counts planned seats before anything launched, and failures in red', () => {
    state.chain = chain([
      { id: 's1', agent: 'codex', prompt: 'p', presetId: 'improve', status: 'queued' },
      { id: 's2', agent: 'claude', prompt: 'p', presetId: 'verify', status: 'queued' }
    ])
    const planned = render(<SessionTeamPlanStrip session={session} chainId="chn_1" />)
    expect(planned.container.querySelector('[data-session-team-count]')?.textContent).toBe(
      '2 agents planned'
    )
    cleanup()
    state.chain = chain(
      [
        { id: 's1', agent: 'codex', prompt: 'p', presetId: 'improve', status: 'failed' },
        { id: 's2', agent: 'claude', prompt: 'p', presetId: 'verify', status: 'queued' }
      ],
      { state: 'failed' }
    )
    const failed = render(<SessionTeamPlanStrip session={session} chainId="chn_1" />)
    const count = failed.container.querySelector('[data-session-team-count]')
    expect(count?.textContent).toContain('failed')
    expect(count?.className).toContain('text-destructive')
  })

  it('renders nothing without a plan, even when live helpers exist', () => {
    state.chain = null
    const { container } = render(<SessionTeamPlanStrip session={session} chainId={null} />)
    expect(container.querySelector('[data-session-team-plan]')).toBeNull()
  })
})
