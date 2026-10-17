// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearSessionChainEntries,
  publishSessionChains,
  setSessionChainEntry
} from '@/lib/session-chain-registry'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { SessionChain } from '../../../../shared/session-chain-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/structured-agent-session-projection'
import { SessionActivityPanel } from './SessionActivityPanel'

const PANE = 'term:tab-1:pane-1'

const session: SidebarSession = {
  rowKey: 'row-1',
  sessionKey: 'session-1',
  worktreeId: 'repo:/workspace',
  hostId: 'local',
  tabId: 'term:tab-1',
  paneKey: PANE,
  kind: 'terminal',
  label: 'Build landing page',
  workspaceLabel: 'Website',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}

function setStatus(entry: Partial<AgentStatusEntry> | null): void {
  useAppStore.setState({
    agentStatusEpoch: 1,
    agentStatusByPaneKey: entry
      ? {
          [PANE]: {
            paneKey: PANE,
            state: 'working',
            prompt: '',
            updatedAt: Date.now(),
            stateStartedAt: Date.now() - 120_000,
            stateHistory: [],
            ...entry
          } as AgentStatusEntry
        }
      : {}
  } as never)
}

/** A live plan whose second step launched this pane. */
function launchPlan(): void {
  setSessionChainEntry({
    id: 'chn_1',
    workspacePath: '/workspace',
    worktreeId: session.worktreeId,
    hostId: 'local',
    sourcePaneKey: 'term:tab-0:pane-0',
    sourceRowKey: 'row-0',
    auto: true,
    currentIndex: 2,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps: [
      { id: 's1', agent: 'claude', prompt: 'Build it', status: 'launched' },
      {
        id: 's2',
        agent: 'codex',
        prompt: 'Review it',
        presetId: 'review',
        status: 'launched',
        launchedPaneKey: PANE
      },
      { id: 's3', agent: 'claude', prompt: 'Repair it', status: 'queued' }
    ]
  } as SessionChain)
  publishSessionChains()
}

function transcriptEndingWith(role: 'assistant' | 'user', text: string): NativeChatMessage[] {
  return [
    {
      id: 'a1',
      role: 'assistant',
      timestamp: 1,
      source: 'transcript',
      blocks: [
        {
          type: 'text',
          text: '**Since 13:01:** Cash is unchanged. Clerk registrations increased **2**.'
        }
      ]
    },
    ...(role === 'user'
      ? [
          {
            id: 'u1',
            role: 'user' as const,
            timestamp: 2,
            source: 'transcript' as const,
            blocks: [{ type: 'text' as const, text }]
          }
        ]
      : [])
  ]
}

function transcriptWithTodos(): NativeChatMessage[] {
  return [
    {
      id: 'm1',
      role: 'assistant',
      timestamp: 1,
      source: 'transcript',
      blocks: [
        {
          type: 'tool-call',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Read the brief', status: 'completed' },
              { content: 'Write the tests', status: 'in_progress' },
              { content: 'Open the PR', status: 'pending' }
            ]
          }
        }
      ]
    }
  ]
}

beforeEach(() => {
  setStatus(null)
})

afterEach(() => {
  cleanup()
  clearSessionChainEntries()
  publishSessionChains()
  setStatus(null)
})

describe('SessionActivityPanel', () => {
  it('shows the plan step a pane is on, reusing the plan vocabulary', () => {
    launchPlan()
    setStatus({ toolName: 'Read', toolInput: 'src/main/index.ts' })
    render(<SessionActivityPanel session={session} />)
    const line = screen.getByText('Step 2 of 3 · 👀 Review · Codex')
    expect(line.hasAttribute('data-session-activity-line')).toBe(true)
    expect(line.closest('[data-session-activity]')?.getAttribute('data-session-activity')).toBe(
      'chain'
    )
    // Copy changed 2026-09-18 (brief 78, rec. 5): a relative age with the absolute time in title.
    const state = screen.getByText('Working · 2 min ago')
    expect(state.getAttribute('data-session-activity-state')).toBe('working')
    expect(state.getAttribute('title')).toMatch(/\d/)
  })

  it('renders the task list the agent published, with done, current and pending marked', () => {
    setStatus({ toolName: 'Bash', toolInput: 'pnpm test' })
    render(<SessionActivityPanel session={session} messages={transcriptWithTodos()} />)
    expect(screen.getByText('1/3 · Write the tests')).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Tasks this session published' })
    expect(list.getAttribute('data-session-activity-todos')).toBe('3')
    const items = list.querySelectorAll('[data-session-activity-todo]')
    expect([...items].map((item) => item.getAttribute('data-session-activity-todo'))).toEqual([
      'completed',
      'current',
      'pending'
    ])
    expect(screen.getByText('Read the brief').className).toContain('line-through')
    expect(screen.getByLabelText('Doing now')).toBeTruthy()
  })

  it('falls back to the current activity when there is no plan step and no task list', () => {
    setStatus({ toolName: 'Edit', toolInput: 'src/renderer/src/App.tsx' })
    render(<SessionActivityPanel session={session} messages={[]} />)
    const region = screen.getByText('Editing App.tsx')
    expect(region.getAttribute('title')).toBe('Edit · src/renderer/src/App.tsx')
    expect(region.closest('[data-session-activity]')?.getAttribute('data-session-activity')).toBe(
      'activity'
    )
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('shows the last words without markers, and yields to the status when they are right below', () => {
    setStatus({
      state: 'done',
      stateStartedAt: Date.now() - 4 * 60_000,
      lastAssistantMessage:
        '**Since 13:01:** Cash is unchanged. Clerk registrations increased **2**.'
    })
    const first = render(<SessionActivityPanel session={session} messages={[]} />)
    expect(
      screen.getByText('Since 13:01: Cash is unchanged. Clerk registrations increased 2.')
    ).toBeTruthy()
    expect(screen.getByText('Finished its turn · 4 min ago')).toBeTruthy()
    first.unmount()
    // The same message ends the transcript under the panel: say the status, once, not the echo.
    render(
      <SessionActivityPanel session={session} messages={transcriptEndingWith('assistant', '')} />
    )
    const line = screen.getByText('Finished its turn · 4 min ago')
    expect(line.hasAttribute('data-session-activity-line')).toBe(true)
    expect(line.getAttribute('title')).toMatch(/\d/)
    expect(screen.queryByText(/Since 13:01/)).toBeNull()
    expect(document.querySelector('[data-session-activity-state]')).toBeNull()
    expect(document.querySelector('[data-session-activity-echoed]')).toBeTruthy()
  })

  it('keeps the preview when a newer prompt ends the transcript: the reply is not below', () => {
    setStatus({
      state: 'done',
      lastAssistantMessage:
        '**Since 13:01:** Cash is unchanged. Clerk registrations increased **2**.'
    })
    render(
      <SessionActivityPanel session={session} messages={transcriptEndingWith('user', 'And now?')} />
    )
    expect(
      screen.getByText('Since 13:01: Cash is unchanged. Clerk registrations increased 2.')
    ).toBeTruthy()
    expect(document.querySelector('[data-session-activity-echoed]')).toBeNull()
  })

  it('says status unknown rather than rendering an empty strip', () => {
    render(<SessionActivityPanel session={session} messages={[]} />)
    expect(screen.getByText('Status unknown')).toBeTruthy()
    expect(
      screen
        .getByText('Status unknown')
        .closest('[data-session-activity]')
        ?.getAttribute('data-session-activity')
    ).toBe('unknown')
  })

  it('reads a structured chat’s live status from its own key, since its row has no pane', () => {
    const tabId = structuredAgentSessionTabId('chat-1')
    const statusKey = structuredAgentSessionPaneKey(tabId, 'chat-1')
    useAppStore.setState({
      agentStatusEpoch: 1,
      agentStatusByPaneKey: {
        [statusKey]: {
          paneKey: statusKey,
          state: 'working',
          workingMode: 'monitoring',
          backgroundTaskCount: 2,
          prompt: '',
          updatedAt: Date.now(),
          stateStartedAt: Date.now() - 60_000,
          stateHistory: []
        } as AgentStatusEntry
      }
    } as never)
    render(
      <SessionActivityPanel
        session={{ ...session, kind: 'structured', tabId, paneKey: null } as SidebarSession}
      />
    )
    const state = document.querySelector('[data-session-activity-state="working"]')
    // The count travels with the phrase here too, as on the row and in the header.
    expect(state?.textContent).toMatch(/^Waiting on background work \(2\)/)
  })
})
