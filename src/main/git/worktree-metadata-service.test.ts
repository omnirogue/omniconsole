import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ChildProcessHandle,
  ProcessResult,
  ProcessSpec
} from '../../shared/child-process/run-process'
import { WorktreeMetadataService } from './worktree-metadata-service'

type Call = { spec: ProcessSpec; resolve: (result: ProcessResult) => void }
const result: ProcessResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
let calls: Call[]
let service: WorktreeMetadataService

function close(call: Call): void {
  call.spec.onChildTerminated?.()
  call.resolve(result)
}
function start(call: Call, index: number): void {
  const requests = JSON.parse(call.spec.input!)
  call.spec.onStdout?.(
    `${JSON.stringify({ index, operation: requests[index].operation, phase: 'start' })}\n`
  )
}
function complete(call: Call, index: number, value: boolean): void {
  start(call, index)
  const requests = JSON.parse(call.spec.input!)
  call.spec.onStdout?.(
    `${JSON.stringify({ index, operation: requests[index].operation, phase: 'result', value })}\n`
  )
}
async function pump(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  service = new WorktreeMetadataService(
    vi.fn(
      (spec: ProcessSpec) => new Promise<ProcessResult>((resolve) => calls.push({ spec, resolve }))
    ),
    () => ({ program: 'owned-metadata-child' })
  )
})
afterEach(async () => {
  const stopped = service.stop()
  calls.forEach(close)
  await stopped
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('worktree metadata child ownership', () => {
  it('deduplicates overlapping batches by operation and normalized path while cancellation stays independent', async () => {
    const controller = new AbortController()
    const first = service.probe('sparse', ['/repo/one', '/repo/two'], controller.signal)
    await pump()
    const second = service.probe('sparse', ['/repo/./one'])
    await pump()
    expect(calls).toHaveLength(1)
    controller.abort()
    expect(calls[0].spec.signal?.aborted).toBe(false)
    complete(calls[0], 0, true)
    expect((await second).get('/repo/./one')).toMatchObject({ value: true })
    expect([...(await first).values()]).toEqual([undefined, undefined])
    close(calls[0])
  })

  it('delivers a healthy result before a blocked sibling exits and preserves unknown results', async () => {
    const batch = service.probe('sparse', ['/blocked', '/healthy'])
    await pump()
    start(calls[0], 0)
    const healthy = service.probe('sparse', ['/healthy'])
    complete(calls[0], 1, true)
    expect((await healthy).get('/healthy')).toMatchObject({ value: true })
    close(calls[0])
    expect((await batch).get('/blocked')).toBeUndefined()
  })

  it('bounds both actual children and admission time even when callers provide no signal', async () => {
    const first = service.probe('sparse', ['/a'])
    await pump()
    const second = service.probe('exists', ['/b'])
    await pump()
    const queued = service.probe('sparse', ['/c'])
    await pump()
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await queued).get('/c')).toBeUndefined()
    close(calls[0])
    close(calls[1])
    await Promise.all([first, second])
    await pump()
    expect(calls).toHaveLength(2)
  })

  it('holds an aborted child slot until its exact termination is reported', async () => {
    const controller = new AbortController()
    const first = service.probe('sparse', ['/a'], controller.signal)
    await pump()
    const second = service.probe('sparse', ['/b'])
    await pump()
    controller.abort()
    await first
    expect(calls[0].spec.signal?.aborted).toBe(true)
    const queued = service.probe('sparse', ['/c'])
    await pump()
    expect(calls).toHaveLength(2)
    close(calls[0])
    await pump()
    expect(calls).toHaveLength(3)
    close(calls[1])
    close(calls[2])
    await Promise.all([second, queued])
  })

  it('cools down only attempted unknown paths across operations so later polls reach unstarted healthy paths', async () => {
    const paths = ['/blocked-1', '/blocked-2', '/blocked-3', '/blocked-4', '/healthy']
    const first = service.probe('sparse', paths)
    await pump()
    for (let index = 0; index < 4; index++) {
      start(calls[0], index)
    }
    close(calls[0])
    await first
    const second = service.probe('exists', paths)
    await pump()
    expect(JSON.parse(calls[1].spec.input!)).toEqual([{ operation: 'exists', path: '/healthy' }])
    complete(calls[1], 0, true)
    close(calls[1])
    expect((await second).get('/healthy')).toMatchObject({ value: true })
    await vi.advanceTimersByTimeAsync(30_000)
    const retry = service.probe('sparse', ['/blocked-1'])
    await pump()
    expect(calls).toHaveLength(3)
    close(calls[2])
    await retry
  })

  it('keeps unverifiable children in their slots, detaches parent handles and disables probes after two leaks', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = service.probe('sparse', ['/a'])
    await pump()
    const second = service.probe('sparse', ['/b'])
    await pump()
    const children = calls.map((call) => {
      const child = {
        pid: 123,
        stdin: { destroy: vi.fn() },
        stdout: { destroy: vi.fn() },
        stderr: { destroy: vi.fn() },
        unref: vi.fn()
      }
      call.spec.onChildExitUnverified?.(child as unknown as ChildProcessHandle)
      call.resolve({ ...result, code: null, timedOut: true })
      return child
    })
    await Promise.all([first, second])
    for (const child of children) {
      expect(child.unref).toHaveBeenCalledOnce()
      expect(child.stdout.destroy).toHaveBeenCalledOnce()
      expect(child.stdin.destroy).toHaveBeenCalledOnce()
      expect(child.stderr.destroy).toHaveBeenCalledOnce()
    }
    expect((await service.probe('exists', ['/later'])).get('/later')).toBeUndefined()
    expect(service.isExhausted()).toBe(true)
    calls.forEach(close)
    expect((await service.probe('exists', ['/even-later'])).get('/even-later')).toBeUndefined()
    expect(calls).toHaveLength(2)
  })

  it('committed shutdown aborts owned work, drains its lifecycle and prevents new processes', async () => {
    const first = service.probe('sparse', ['/a'])
    await pump()
    const stopped = service.stop()
    expect(calls[0].spec.signal?.aborted).toBe(true)
    expect((await service.probe('sparse', ['/b'])).get('/b')).toBeUndefined()
    close(calls[0])
    await Promise.all([first, stopped])
    expect(calls).toHaveLength(1)
  })

  it('dispatches readable requests ahead of listing work in separate batches at the next free slot', async () => {
    const first = service.probe('sparse', ['/listing-1'])
    await pump()
    const second = service.probe('exists', ['/listing-2'])
    await pump()
    const listing = service.probe('sparse', ['/listing-3'])
    const readable = service.probe('readable', ['/active'])
    await pump()
    expect(calls).toHaveLength(2)
    close(calls[0])
    await pump()
    expect(JSON.parse(calls[2].spec.input!)).toEqual([{ operation: 'readable', path: '/active' }])
    complete(calls[2], 0, true)
    expect((await readable).get('/active')).toMatchObject({ operation: 'readable', value: true })
    close(calls[2])
    await pump()
    expect(JSON.parse(calls[3].spec.input!)).toEqual([{ operation: 'sparse', path: '/listing-3' }])
    close(calls[1])
    close(calls[3])
    await Promise.all([first, second, listing])
  })

  it('requires new readable proof after cooldown and never cools down an unstarted admission', async () => {
    const blocked = service.probe('readable', ['/active'])
    await pump()
    start(calls[0], 0)
    close(calls[0])
    expect((await blocked).get('/active')).toBeUndefined()
    expect((await service.probe('readable', ['/active'])).get('/active')).toBeUndefined()
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000)
    const retry = service.probe('readable', ['/active'])
    await pump()
    complete(calls[1], 0, true)
    close(calls[1])
    expect((await retry).get('/active')).toMatchObject({ operation: 'readable', value: true })
    const busy1 = service.probe('sparse', ['/busy1'])
    await pump()
    const busy2 = service.probe('sparse', ['/busy2'])
    await pump()
    const queued = service.probe('readable', ['/unstarted'])
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await queued).get('/unstarted')).toBeUndefined()
    close(calls[2])
    close(calls[3])
    await Promise.all([busy1, busy2])
    const fresh = service.probe('readable', ['/unstarted'])
    await pump()
    complete(calls[4], 0, true)
    close(calls[4])
    expect((await fresh).get('/unstarted')).toMatchObject({ value: true })
  })

  it('does not cool down a cancelled member while its sibling still owns the batch', async () => {
    const controller = new AbortController()
    const cancelled = service.probe('readable', ['/cancelled'], controller.signal)
    const sibling = service.probe('readable', ['/sibling'])
    await pump()
    start(calls[0], 0)
    controller.abort()
    await cancelled
    expect(calls[0].spec.signal?.aborted).toBe(false)
    complete(calls[0], 1, true)
    close(calls[0])
    await sibling
    const retry = service.probe('readable', ['/cancelled'])
    await pump()
    expect(calls).toHaveLength(2)
    complete(calls[1], 0, true)
    close(calls[1])
    expect((await retry).get('/cancelled')).toMatchObject({ value: true })
  })

  it('rejects invalid input and bounds queued batches without putting paths in argv', async () => {
    const invalid = await service.probe('sparse', ['', '/bad\0path', `/${'x'.repeat(20_000)}`])
    expect([...invalid.values()]).toEqual([undefined, undefined, undefined])
    expect(calls).toHaveLength(0)
    const paths = Array.from({ length: 600 }, (_, index) => `/repo/${index}`)
    const pending = service.probe('sparse', paths)
    await pump()
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => JSON.parse(call.spec.input!).length <= 256)).toBe(true)
    calls.forEach(close)
    await pump()
    expect(calls).toHaveLength(3)
    close(calls[2])
    expect((await pending).size).toBe(600)
  })
})
