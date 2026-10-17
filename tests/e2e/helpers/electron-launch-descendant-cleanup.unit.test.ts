import type { ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  captureElectronLaunchDescendants,
  cleanupElectronLaunchDescendants
} from './electron-launch-descendant-cleanup'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  readlinkSync: vi.fn(),
  realpathSync: vi.fn()
}))

type Process = {
  start: string
  group: number
  session: number
  uid: number
  exe: string
  pipes: string[]
}
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const rootPid = 2_000_010
const childPid = 2_000_011
const uid = process.getuid?.() ?? 501
let processes: Map<number, Process>
let launcher: ChildProcess
const make = (extra: Partial<Process> = {}): Process => ({
  start: '101',
  group: rootPid,
  session: rootPid,
  uid,
  exe: '/owned/node',
  pipes: ['socket:[9001]'],
  ...extra
})

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  processes = new Map([
    [rootPid, make({ start: '100', exe: '/owned/electron' })],
    [childPid, make()]
  ])
  launcher = {
    pid: rootPid,
    spawnfile: '/owned/electron',
    stdio: [null, null, null, {}],
    exitCode: null,
    signalCode: null
  } as unknown as ChildProcess
  vi.mocked(realpathSync).mockImplementation(((p: string) => p) as typeof realpathSync)
  vi.mocked(readFileSync).mockImplementation(((p: string) => {
    const [, pidText, file] = /^\/proc\/(\d+)\/(.+)$/.exec(p) ?? []
    const current = processes.get(Number(pidText))
    if (!current) {
      throw new Error('ESRCH')
    }
    if (file === 'status') {
      return `Uid:\t${current.uid}\t${current.uid}\t${current.uid}\t${current.uid}`
    }
    if (file === 'stat') {
      const fields = Array(20).fill('0')
      fields[0] = 'S'
      fields[1] = '1'
      fields[2] = String(current.group)
      fields[3] = String(current.session)
      fields[19] = current.start
      return `${pidText} (fixture with ) parens) ${fields.join(' ')}`
    }
    throw new Error('Unexpected read')
  }) as typeof readFileSync)
  vi.mocked(readdirSync).mockImplementation(((p: string) => {
    if (p === '/proc') {
      return [...processes.keys()].map(String)
    }
    const pid = Number(/^\/proc\/(\d+)\/fd$/.exec(p)?.[1])
    return processes.get(pid)?.pipes.map((_target, index) => String(index + 3)) ?? []
  }) as typeof readdirSync)
  vi.mocked(readlinkSync).mockImplementation(((p: string) => {
    const [, pidText, file] = /^\/proc\/(\d+)\/(.+)$/.exec(p) ?? []
    const current = processes.get(Number(pidText))
    if (!current) {
      throw new Error('ESRCH')
    }
    if (file === 'exe') {
      return current.exe
    }
    const value = current.pipes[Number(file.slice(3)) - 3]
    if (!value) {
      throw new Error('ENOENT')
    }
    return value
  }) as typeof readlinkSync)
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    processes.delete(pid)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', platform)
})

function exitLauncher(): void {
  Object.assign(launcher, { exitCode: 0 })
  processes.delete(rootPid)
}

it('captures only exact launch-group pipe owners and releases them after launcher exit', async () => {
  processes.set(2_000_012, make({ group: 2_000_012, session: 2_000_012 }))
  processes.set(2_000_013, make({ pipes: ['socket:[9999]'] }))
  processes.set(process.pid, make())
  processes.set(process.ppid, make())
  const snapshot = captureElectronLaunchDescendants(launcher)
  expect(snapshot?.candidates.map((p) => p.pid)).toEqual([childPid])
  exitLauncher()
  expect(await cleanupElectronLaunchDescendants(launcher, snapshot)).toEqual({
    matched: [childPid],
    exited: [childPid]
  })
  expect(process.kill).toHaveBeenCalledExactlyOnceWith(childPid, 'SIGTERM')
  expect(processes.has(2_000_012)).toBe(true)
})

it.each(['start', 'uid', 'group', 'session', 'exe', 'pipes'] as const)(
  'refuses a changed %s at final cleanup',
  async (field) => {
    const snapshot = captureElectronLaunchDescendants(launcher)
    exitLauncher()
    const change = {
      start: '202',
      uid: uid + 1,
      group: rootPid + 5,
      session: rootPid + 5,
      exe: '/other/node',
      pipes: ['socket:[2222]']
    }
    processes.set(childPid, make({ [field]: change[field] }))
    expect(await cleanupElectronLaunchDescendants(launcher, snapshot)).toEqual({
      matched: [],
      exited: []
    })
    expect(process.kill).not.toHaveBeenCalled()
  }
)

it('does not admit a later unseen process even if it joins the same group and socket', async () => {
  const snapshot = captureElectronLaunchDescendants(launcher)
  exitLauncher()
  processes.delete(childPid)
  processes.set(2_000_015, make())
  await cleanupElectronLaunchDescendants(launcher, snapshot)
  expect(process.kill).not.toHaveBeenCalled()
})

it('refuses cleanup while the launcher is still live', async () => {
  const snapshot = captureElectronLaunchDescendants(launcher)
  await expect(cleanupElectronLaunchDescendants(launcher, snapshot)).rejects.toThrow(
    'before its exact Electron launcher exits'
  )
  expect(process.kill).not.toHaveBeenCalled()
})

it('requires the live launcher to own its session and executable', () => {
  processes.set(rootPid, make({ exe: '/other/electron', start: '100' }))
  expect(() => captureElectronLaunchDescendants(launcher)).toThrow('ownership')
  expect(process.kill).not.toHaveBeenCalled()
})

it('does not escalate against a PID reused after TERM', async () => {
  const snapshot = captureElectronLaunchDescendants(launcher)
  exitLauncher()
  vi.mocked(process.kill).mockImplementation(() => {
    processes.set(childPid, make({ start: '202' }))
    return true
  })
  await cleanupElectronLaunchDescendants(launcher, snapshot)
  expect(process.kill).toHaveBeenCalledExactlyOnceWith(childPid, 'SIGTERM')
})

it('escalates only while the same captured identity still owns the inherited socket', async () => {
  vi.useFakeTimers()
  const snapshot = captureElectronLaunchDescendants(launcher)
  exitLauncher()
  vi.mocked(process.kill).mockImplementation((pid, signal) => {
    if (signal === 'SIGKILL') {
      processes.delete(pid)
    }
    return true
  })
  const cleanup = cleanupElectronLaunchDescendants(launcher, snapshot)
  await vi.runAllTimersAsync()
  await cleanup
  expect(vi.mocked(process.kill).mock.calls).toEqual([
    [childPid, 'SIGTERM'],
    [childPid, 'SIGKILL']
  ])
})

it('fails when TERM releases pipes but the captured birth identity stays alive', async () => {
  vi.useFakeTimers()
  const snapshot = captureElectronLaunchDescendants(launcher)
  exitLauncher()
  vi.mocked(process.kill).mockImplementation(() => {
    processes.set(childPid, make({ pipes: [] }))
    return true
  })
  const cleanup = cleanupElectronLaunchDescendants(launcher, snapshot)
  const failed = expect(cleanup).rejects.toThrow('survived but lost its signal guard')
  await vi.runAllTimersAsync()
  await failed
  expect(process.kill).toHaveBeenCalledExactlyOnceWith(childPid, 'SIGTERM')
  expect(processes.has(childPid)).toBe(true)
})
