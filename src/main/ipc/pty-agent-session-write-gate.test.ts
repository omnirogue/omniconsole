import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, onMock, removeHandlerMock, removeAllListenersMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: vi.fn().mockReturnValue('/tmp/omni-test-userdata')
  },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  },
  powerMonitor: { on: vi.fn() }
}))

vi.mock('fs', () => ({
  existsSync: () => true,
  statSync: () => ({ isDirectory: () => true, mode: 0o755 }),
  accessSync: () => undefined,
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    process: 'zsh',
    pid: 12345
  })
}))

vi.mock('../opencode/hook-service', () => ({
  openCodeHookService: { buildPtyEnv: () => ({}), clearPty: vi.fn() }
}))

vi.mock('../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), clearPty: vi.fn() }
}))

import {
  deletePtyOwnership,
  registerPtyHandlers,
  registerSshPtyProvider,
  setPtyOwnership,
  unregisterSshPtyProvider
} from './pty'
import { agentSessionPtyWriteGate } from '../runtime/agent-session-pty-write-gate'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../shared/terminal-input'
import type { AgentSessionLease, AgentSessionRecord } from '../../shared/agent-session-record'
import type { IPtyProvider } from '../providers/types'
import { setPtyHostBindings } from './pty-host-bindings'
import { getLocalPtyProvider, setLocalPtyProvider } from './pty/provider/registry'
import { interactiveOutputCharsByPty, lastInputAtByPty } from './pty/delivery/visibility-state'

// The renderer IPC path and the runtime controller are the two byte entry points this module owns;
// both are proved to consult the lease, and both are proved to leave an unbound PTY alone.

const CONNECTION_ID = 'conn-lease'
const PTY_ID = 'ssh:conn-lease@@pty-1'
const SESSION_ID = 'session-alpha-1'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const records = new Map<string, AgentSessionRecord>()
const cancelCapacityRecovery = vi.fn()

const mainWindow = {
  isDestroyed: () => false,
  webContents: { on: vi.fn(), send: vi.fn(), removeListener: vi.fn() }
}
const mainWindowIpcEvent = { sender: mainWindow.webContents }

let ptyController: { write: (ptyId: string, data: string) => boolean } | null = null

function createMockProvider(): IPtyProvider {
  return {
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    attach: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    shutdown: vi.fn(),
    sendSignal: vi.fn(),
    getCwd: vi.fn(),
    getInitialCwd: vi.fn(),
    clearBuffer: vi.fn(),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(),
    getForegroundProcess: vi.fn(),
    serialize: vi.fn(),
    revive: vi.fn(),
    listProcesses: vi.fn(),
    getDefaultShell: vi.fn(),
    getProfiles: vi.fn(),
    onData: vi.fn().mockReturnValue(() => {}),
    onReplay: vi.fn().mockReturnValue(() => {}),
    onExit: vi.fn().mockReturnValue(() => {})
  } as unknown as IPtyProvider
}

let provider: IPtyProvider
let previousLocalProvider: IPtyProvider

function publish(lease: AgentSessionLease): void {
  records.set(lease.sessionId, agentSessionRecordFixture(lease))
}

function enforce(lease: AgentSessionLease = agentSessionLeaseFixture()): void {
  publish(lease)
  agentSessionPtyWriteGate.attachRecordLookup((sessionId) => records.get(sessionId) ?? null)
  agentSessionPtyWriteGate.bindPty(PTY_ID, SESSION_ID)
}

function writeFromRenderer(data: string): void {
  ;(handlers.get('pty:write') as (event: unknown, args: unknown) => void)(mainWindowIpcEvent, {
    id: PTY_ID,
    data
  })
}

async function writeAcceptedFromRenderer(data: string): Promise<boolean> {
  return await (
    handlers.get('pty:writeAccepted') as (
      event: unknown,
      args: unknown
    ) => boolean | Promise<boolean>
  )(mainWindowIpcEvent, { id: PTY_ID, data })
}

function lastRefusal(): { id: string; agentSessionRefusal?: { code: string } } | null {
  const call = mainWindow.webContents.send.mock.calls.findLast(
    ([channel]) => channel === 'pty:writeUnavailable'
  )
  return (call?.[1] as { id: string; agentSessionRefusal?: { code: string } }) ?? null
}

beforeEach(() => {
  handlers.clear()
  records.clear()
  handleMock.mockReset()
  onMock.mockReset()
  mainWindow.webContents.send.mockReset()
  ptyController = null
  cancelCapacityRecovery.mockReset()
  lastInputAtByPty.delete(PTY_ID)
  interactiveOutputCharsByPty.delete(PTY_ID)
  previousLocalProvider = getLocalPtyProvider()
  handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  })
  onMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  })
  setPtyHostBindings({
    ipc: {
      handle: handleMock,
      on: onMock,
      removeHandler: removeHandlerMock,
      removeAllListeners: removeAllListenersMock
    } as never
  })
  const runtime = {
    setPtyController: (controller: { write: (ptyId: string, data: string) => boolean }) => {
      ptyController = controller
    },
    getDriver: () => ({ kind: 'desktop' }),
    cancelConversationCapacityRecoveryForPty: cancelCapacityRecovery
  }
  registerPtyHandlers(mainWindow as never, runtime as never)
  provider = createMockProvider()
  registerSshPtyProvider(CONNECTION_ID, provider)
  setPtyOwnership(PTY_ID, CONNECTION_ID)
})

afterEach(() => {
  setPtyHostBindings({})
  agentSessionPtyWriteGate.detachRecordLookup()
  deletePtyOwnership(PTY_ID)
  unregisterSshPtyProvider(CONNECTION_ID)
  setLocalPtyProvider(previousLocalProvider)
  lastInputAtByPty.delete(PTY_ID)
  interactiveOutputCharsByPty.delete(PTY_ID)
})

describe('renderer IPC write path', () => {
  it.each(['write', 'accepted-local', 'accepted-ssh'] as const)(
    'forwards machine terminal reports through %s without cancelling recovery or advancing human input',
    async (route) => {
      provider.hasPty = () => true
      provider.writeAccepted = vi.fn().mockResolvedValue(true)
      if (route === 'accepted-local') {
        setLocalPtyProvider(provider)
        setPtyOwnership(PTY_ID, null)
      }
      lastInputAtByPty.set(PTY_ID, 42)
      interactiveOutputCharsByPty.set(PTY_ID, 500)
      const reports = [
        '\x1b[1;1R',
        '\x1b[?1;2c',
        '\x1b]10;rgb:ffff/ffff/ffff\x07',
        '\x1b[0n\x1b[1;1R',
        '\x1b[I',
        '\x1b[O\x1b[I',
        '\x1b[M !!',
        '\x1b[<0;1;1M\x1b[<0;1;1m'
      ]
      for (const data of reports) {
        if (route === 'write') {
          writeFromRenderer(data)
        } else {
          expect(await writeAcceptedFromRenderer(data)).toBe(true)
        }
      }
      const write = route === 'write' ? provider.write : provider.writeAccepted
      expect(vi.mocked(write).mock.calls.map((args) => args[1])).toEqual(reports)
      expect(cancelCapacityRecovery).not.toHaveBeenCalled()
      expect(lastInputAtByPty.get(PTY_ID)).toBe(42)
      expect(interactiveOutputCharsByPty.get(PTY_ID)).toBe(500)
    }
  )

  it.each(['write', 'accepted-local', 'accepted-ssh'] as const)(
    'preserves human typing, paste and Enter cancellation through %s',
    async (route) => {
      provider.hasPty = () => true
      provider.writeAccepted = vi.fn().mockResolvedValue(true)
      if (route === 'accepted-local') {
        setLocalPtyProvider(provider)
        setPtyOwnership(PTY_ID, null)
      }
      const inputs = ['x', '\r', '\x1b[13u', '\x1b[200~Pasted instructions\x1b[201~', '\x1b[0nx']
      for (const data of inputs) {
        lastInputAtByPty.delete(PTY_ID)
        interactiveOutputCharsByPty.set(PTY_ID, 500)
        if (route === 'write') {
          writeFromRenderer(data)
        } else {
          expect(await writeAcceptedFromRenderer(data)).toBe(true)
        }
        expect(lastInputAtByPty.get(PTY_ID)).toEqual(expect.any(Number))
        expect(interactiveOutputCharsByPty.get(PTY_ID)).toBe(0)
      }
      expect(cancelCapacityRecovery).toHaveBeenCalledTimes(inputs.length)
      expect(cancelCapacityRecovery).toHaveBeenLastCalledWith(PTY_ID, 'New terminal input.')
    }
  )

  it('writes an unbound pty unchanged, which is every shell that exists today', () => {
    writeFromRenderer('ls')

    expect(provider.write).toHaveBeenCalledWith(PTY_ID, 'ls')
    expect(lastRefusal()).toBeNull()
  })

  it('writes when the TUI owner holds a proven-live lease', () => {
    enforce()

    writeFromRenderer('ls')

    expect(provider.write).toHaveBeenCalledWith(PTY_ID, 'ls')
  })

  it('refuses and reports the owner when native chat holds the session', () => {
    enforce(agentSessionLeaseFixture({ runtimeKind: 'native' }))

    writeFromRenderer('ls')

    expect(provider.write).not.toHaveBeenCalled()
    const refusal = lastRefusal()
    expect(refusal?.id).toBe(PTY_ID)
    expect(refusal?.agentSessionRefusal).toMatchObject({
      code: 'agent_session_conflict',
      sessionId: SESSION_ID,
      ownerRuntimeKind: 'native',
      ownerPid: 4242
    })
  })

  it('refuses while the lease is unreconciled after a host restart', () => {
    enforce(agentSessionLeaseFixture({ unreconciled: true }))

    writeFromRenderer('ls')

    expect(provider.write).not.toHaveBeenCalled()
    expect(lastRefusal()?.agentSessionRefusal?.code).toBe('execution_owner_reconciling')
  })

  it('refuses the acknowledged write path too', async () => {
    enforce(agentSessionLeaseFixture({ handoffStage: 'preparing' }))

    await expect(writeAcceptedFromRenderer('')).resolves.toBe(false)

    expect(provider.write).not.toHaveBeenCalled()
    expect(lastRefusal()?.agentSessionRefusal?.code).toBe('agent_session_conflict')
  })

  it('leaves the acknowledged write path silent for an unbound pty', async () => {
    await writeAcceptedFromRenderer('')

    expect(lastRefusal()).toBeNull()
  })

  it('returns the owning SSH provider acknowledgement without a fallback write', async () => {
    enforce()
    provider.hasPty = () => true
    provider.writeAccepted = vi.fn().mockResolvedValue(true)
    await expect(writeAcceptedFromRenderer('\r')).resolves.toBe(true)
    expect(provider.writeAccepted).toHaveBeenCalledWith(PTY_ID, '\r', {
      isCurrent: expect.any(Function)
    })
    expect(provider.write).not.toHaveBeenCalled()
  })

  it('keeps an older SSH provider unconfirmed instead of replaying the input', async () => {
    enforce()
    provider.hasPty = () => true
    await expect(writeAcceptedFromRenderer('\r')).resolves.toBe(false)
    expect(provider.write).not.toHaveBeenCalled()
  })

  it.each(['lease', 'provider'])(
    'revalidates the SSH %s after capability negotiation yields',
    async (change) => {
      enforce(agentSessionLeaseFixture({ runtimeFence: 7 }))
      provider.hasPty = () => true
      let resume!: () => void
      let isCurrent!: () => boolean
      const original = provider
      provider.writeAccepted = vi.fn(
        (_id, _data, options) =>
          new Promise<boolean>((resolve) => {
            isCurrent = options!.isCurrent!
            resume = () => resolve(isCurrent())
          })
      )
      const pending = writeAcceptedFromRenderer('\r')
      await vi.waitFor(() => expect(original.writeAccepted).toHaveBeenCalledOnce())
      if (change === 'lease') {
        publish(agentSessionLeaseFixture({ runtimeFence: 8 }))
      } else {
        unregisterSshPtyProvider(CONNECTION_ID)
        provider = createMockProvider()
        registerSshPtyProvider(CONNECTION_ID, provider)
      }
      expect(isCurrent()).toBe(false)
      resume()
      await expect(pending).resolves.toBe(false)
      expect(original.write).not.toHaveBeenCalled()
      expect(provider.write).not.toHaveBeenCalled()
    }
  )

  it('stops a chunked paste once the fence advances mid-flight', async () => {
    enforce(agentSessionLeaseFixture({ runtimeFence: 7 }))
    vi.mocked(provider.write).mockImplementation(() => {
      publish(agentSessionLeaseFixture({ runtimeFence: 8 }))
    })

    writeFromRenderer('x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2 + 8))
    await vi.waitFor(() => expect(lastRefusal()).not.toBeNull())

    expect(provider.write).toHaveBeenCalledTimes(1)
    expect(lastRefusal()?.agentSessionRefusal?.code).toBe('agent_session_checkpoint_stale')
  })

  it('lets a chunked paste finish while the same owner holds the fence', async () => {
    enforce()

    writeFromRenderer('x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2 + 8))
    await vi.waitFor(() => expect(provider.write).toHaveBeenCalledTimes(3))

    expect(lastRefusal()).toBeNull()
  })
})

describe('runtime controller backstop', () => {
  it('lets a runtime write through on an unbound pty', () => {
    expect(ptyController?.write(PTY_ID, 'reply')).toBe(true)
    expect(provider.write).toHaveBeenCalledWith(PTY_ID, 'reply')
  })

  it('blocks a runtime write that never passed a typed gate', () => {
    // Query replies, followups, and deliveries reach the provider through this one function.
    enforce(agentSessionLeaseFixture({ runtimeKind: 'native' }))

    expect(ptyController?.write(PTY_ID, 'reply')).toBe(false)
    expect(provider.write).not.toHaveBeenCalled()
    expect(lastRefusal()?.agentSessionRefusal?.code).toBe('agent_session_conflict')
  })

  it('lets a runtime write through while the TUI owner holds the lease', () => {
    enforce()

    expect(ptyController?.write(PTY_ID, 'reply')).toBe(true)
    expect(provider.write).toHaveBeenCalledWith(PTY_ID, 'reply')
  })
})
