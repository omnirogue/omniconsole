import { beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { capturePairedQuestionOwner, isPairedQuestionOwnerCurrent } from './paired-question-owner'

const leaf = '11111111-2222-4333-8444-555555555555'
const tab = toWebTerminalSurfaceTabId('host-tab')
const pane = makePaneKey(tab, leaf)
const environment = { id: 'rental', createdAt: 100, pairingRevision: 101 }

function fixture() {
  return {
    runtimeEnvironmentCatalogHydrated: true,
    runtimeEnvironments: [environment],
    runtimeStatusByEnvironmentId: new Map([
      ['rental', { status: { runtimeId: 'process-1' }, connectionGeneration: 3 }]
    ]),
    unifiedTabsByWorktree: {
      'folder:work': [
        {
          id: tab,
          worktreeId: 'folder:work',
          contentType: 'terminal',
          executionHostId: 'runtime:rental'
        }
      ]
    },
    terminalLayoutsByTabId: {
      [tab]: { ptyIdsByLeafId: { [leaf]: toRemoteRuntimePtyId('term-1', 'rental') } }
    },
    agentStatusByPaneKey: {
      [pane]: {
        paneKey: pane,
        worktreeId: 'folder:work',
        tabId: tab,
        terminalHandle: 'term-1',
        agentType: 'claude',
        state: 'waiting',
        stateStartedAt: 1000,
        toolName: 'AskUserQuestion',
        providerSession: { key: 'session_id', id: 'provider-1' },
        interactivePrompt: JSON.stringify({
          questions: [
            {
              question: 'Which color?',
              multiSelect: false,
              options: [{ label: 'Blue' }, { label: 'Green' }]
            }
          ]
        })
      }
    }
  }
}

beforeEach(() => replaceRuntimeEnvironmentRevisions([environment]))

describe('paired question execution owner', () => {
  it('resolves the host pane for folder workspaces without using the client pane as authority', () => {
    const state = fixture() as unknown as Partial<AppState>
    const captured = capturePairedQuestionOwner(state, pane)!
    expect(captured.target).toEqual({
      worktreeId: 'folder:work',
      paneKey: makePaneKey('host-tab', leaf),
      terminal: 'term-1'
    })
    expect(captured.runtimeId).toBe('process-1')
    expect(isPairedQuestionOwnerCurrent(state, pane, captured)).toBe(true)
  })

  it.each([
    [
      'provider replacement',
      (s: ReturnType<typeof fixture>) => {
        s.agentStatusByPaneKey[pane]!.providerSession.id = 'provider-2'
      }
    ],
    [
      'runtime restart',
      (s: ReturnType<typeof fixture>) => {
        s.runtimeStatusByEnvironmentId.get('rental')!.status.runtimeId = 'process-2'
      }
    ],
    [
      'connection replacement',
      (s: ReturnType<typeof fixture>) => {
        s.runtimeStatusByEnvironmentId.get('rental')!.connectionGeneration++
      }
    ],
    [
      'terminal replacement',
      (s: ReturnType<typeof fixture>) => {
        s.terminalLayoutsByTabId[tab]!.ptyIdsByLeafId[leaf] = toRemoteRuntimePtyId(
          'term-2',
          'rental'
        )
      }
    ],
    [
      'host reassignment',
      (s: ReturnType<typeof fixture>) => {
        s.unifiedTabsByWorktree['folder:work'][0]!.executionHostId = 'runtime:other'
      }
    ],
    [
      'new question occurrence with identical text',
      (s: ReturnType<typeof fixture>) => {
        s.agentStatusByPaneKey[pane]!.stateStartedAt++
      }
    ]
  ])('invalidates an answer on %s', (_name, mutate) => {
    const state = fixture()
    const captured = capturePairedQuestionOwner(state as unknown as Partial<AppState>, pane)!
    mutate(state)
    expect(
      isPairedQuestionOwnerCurrent(state as unknown as Partial<AppState>, pane, captured)
    ).toBe(false)
  })

  it('refuses a same-id re-pair even before the renderer catalog updates', () => {
    const state = fixture() as unknown as Partial<AppState>
    const captured = capturePairedQuestionOwner(state, pane)!
    replaceRuntimeEnvironmentRevisions([{ ...environment, pairingRevision: 102 }])
    expect(isPairedQuestionOwnerCurrent(state, pane, captured)).toBe(false)
  })

  it.each([
    { restoredUnconfirmed: true },
    { connectionId: 'ssh-1' },
    { providerSession: undefined },
    { terminalHandle: undefined },
    { state: 'working' },
    { interactivePrompt: undefined }
  ])('does not establish an owner from unverified source %j', (override) => {
    const state = fixture()
    Object.assign(state.agentStatusByPaneKey[pane]!, override)
    expect(capturePairedQuestionOwner(state as unknown as Partial<AppState>, pane)).toBeNull()
  })
})
