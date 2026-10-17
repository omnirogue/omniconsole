import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { OrcaRuntimeService } from './omni-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const TAB = '11111111-1111-4111-8111-111111111111'
const LEAF = '22222222-2222-4222-8222-222222222222'
const PANE = makePaneKey(TAB, LEAF)
const PTY = 'omp-redraw'
const WORKTREE = 'repo::/tmp/omp-redraw'
const PROMPT = JSON.stringify({
  ompApproval: { tool: 'bash', toolCallId: 'copy-1', summary: 'cp source.txt receipt.txt' }
})
// OMP 18.2 closes the prompt zone inside every rendered user-message bubble.
const REDRAW = '\x1b]133;A\x07copy the file\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07'

function pendingOmp(confirmShell: () => Promise<boolean>) {
  const server = new AgentHookServer()
  const retire = vi.fn((paneKey: string) => server.retirePaneAuthority(paneKey))
  const completions: (number | null)[] = []
  const runtime = new OrcaRuntimeService(null, undefined, {
    retireAgentHookCompatibilityAuthority: retire,
    onTerminalSideEffects: (batch) => {
      for (const fact of batch.facts) {
        if (fact.kind === 'command-finished') {
          completions.push(fact.exitCode)
        }
      }
    }
  })
  const controller = {
    spawn: vi.fn().mockResolvedValue({ id: PTY }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'omp',
    confirmShellForeground: vi.fn(confirmShell)
  }
  runtime.setPtyController(controller)
  runtime.attachWindow(1)
  runtime.markGraphReady(1)
  runtime.registerPty(PTY, WORKTREE, null, {
    tabId: TAB,
    leafId: LEAF,
    incarnationId: 'omp-incarnation',
    providerReattachLaunchIdentity: {
      incarnationId: 'omp-incarnation',
      launchAgent: 'omp'
    }
  })
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: TAB,
    worktreeId: WORKTREE,
    payload: {
      state: 'blocked',
      prompt: 'copy the file',
      agentType: 'omp',
      interactivePrompt: PROMPT
    }
  })
  return { runtime, server, retire, controller, completions }
}

function redraw(runtime: OrcaRuntimeService, transport: 'pty' | 'daemon'): void {
  if (transport === 'pty') {
    runtime.onPtyData(PTY, REDRAW, Date.now())
  } else {
    runtime.emitDaemonPtyTransientFact(PTY, { kind: 'command-finished', exitCode: 0 })
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('OMP prompt redraw ownership', () => {
  it.each(['pty', 'daemon'] as const)(
    'keeps the approval after a %s redraw, then retires it on confirmed shell return',
    async (transport) => {
      const { runtime, server, retire, controller, completions } = pendingOmp(async () => false)
      redraw(runtime, transport)
      await settle()

      expect(controller.confirmShellForeground).toHaveBeenCalledExactlyOnceWith(PTY)
      expect(retire).not.toHaveBeenCalled()
      expect(completions).toEqual([])
      expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
        state: 'blocked',
        interactivePrompt: PROMPT
      })

      controller.confirmShellForeground.mockResolvedValue(true)
      redraw(runtime, transport)
      runtime.onPtyData(PTY, '\x1b]0;~/worktree\x07', Date.now())
      await settle()

      expect(retire).toHaveBeenCalledExactlyOnceWith(PANE)
      expect(completions).toEqual([0])
      expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
    }
  )

  it('keeps the approval when the owning host cannot confirm a shell', async () => {
    const { runtime, server, retire } = pendingOmp(async () => {
      throw new Error('host unavailable')
    })
    redraw(runtime, 'daemon')
    await settle()

    expect(retire).not.toHaveBeenCalled()
    expect(server.getStatusSnapshotForPane(PANE)[0]?.interactivePrompt).toBe(PROMPT)
  })

  it('still retires the approval when the owning PTY exits', () => {
    const { runtime, server, retire } = pendingOmp(async () => false)
    runtime.onPtyExit(PTY, 0, 'omp-incarnation', { providerExitObserved: true })

    expect(retire).toHaveBeenCalledExactlyOnceWith(PANE)
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
  })

  it('coalesces redraw checks and refuses an old controller response', async () => {
    let confirm!: (value: boolean) => void
    const confirmation = new Promise<boolean>((resolve) => {
      confirm = resolve
    })
    const { runtime, server, retire, controller } = pendingOmp(() => confirmation)
    redraw(runtime, 'pty')
    redraw(runtime, 'daemon')
    await settle()
    expect(controller.confirmShellForeground).toHaveBeenCalledOnce()

    runtime.setPtyController({ ...controller })
    confirm(true)
    await settle()

    expect(retire).not.toHaveBeenCalled()
    expect(server.getStatusSnapshotForPane(PANE)[0]?.interactivePrompt).toBe(PROMPT)
  })

  it('refuses shell evidence from the previous process incarnation', async () => {
    let confirm!: (value: boolean) => void
    const confirmation = new Promise<boolean>((resolve) => {
      confirm = resolve
    })
    const { runtime, server, retire } = pendingOmp(() => confirmation)
    redraw(runtime, 'daemon')
    await settle()

    runtime.registerPty(PTY, WORKTREE, null, {
      tabId: TAB,
      leafId: LEAF,
      incarnationId: 'replacement-incarnation',
      providerReattachLaunchIdentity: {
        incarnationId: 'replacement-incarnation',
        launchAgent: 'omp'
      }
    })
    confirm(true)
    await settle()

    expect(retire).not.toHaveBeenCalled()
    expect(server.getStatusSnapshotForPane(PANE)[0]?.interactivePrompt).toBe(PROMPT)
  })
})
