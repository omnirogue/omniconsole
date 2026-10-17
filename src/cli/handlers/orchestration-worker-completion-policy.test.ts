import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_WORKER_LAUNCH_HANDLER } from './orchestration/worker-launch-handler'
import { ORCHESTRATION_WORKER_COMPLETION_POLICY_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

vi.mock('../format', () => ({ printResult: vi.fn() }))
const flags = new Map<string, string | boolean>([
  ['task', 'task'],
  ['from', 'term_coord'],
  ['agent', 'codex'],
  ['close-on-completion', true]
])
const oldExitCode = process.exitCode
afterEach(() => {
  process.exitCode = oldExitCode
})
describe('disposable worker CLI compatibility', () => {
  it('refuses an older runtime before creating any worker', async () => {
    const call = vi.fn().mockResolvedValue({ result: { capabilities: [] } })
    await expect(
      ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
        flags,
        client: { call },
        cwd: '/tmp',
        json: true
      } as never)
    ).rejects.toThrow('does not support --close-on-completion')
    expect(call.mock.calls.map(([method]) => method)).toEqual(['status.get'])
  })
  it('sends the launch opt-in only after capability confirmation', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          capabilities: [ORCHESTRATION_WORKER_COMPLETION_POLICY_RUNTIME_CAPABILITY]
        }
      })
      .mockResolvedValueOnce({ result: { state: 'ready' } })
    await ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
      flags,
      client: { call },
      cwd: '/tmp',
      json: true
    } as never)
    expect(call).toHaveBeenLastCalledWith(
      'orchestration.workerStart',
      expect.objectContaining({ closeOnCompletion: true })
    )
  })
  it('sends an explicit retain choice without requiring the older opt-in capability', async () => {
    const call = vi.fn().mockResolvedValue({ result: { state: 'ready' } })
    await ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
      flags: new Map(
        [...flags]
          .filter(([key]) => key !== 'close-on-completion')
          .concat([['keep-as-conversation', true]])
      ),
      client: { call },
      cwd: '/tmp',
      json: true
    } as never)
    expect(call).toHaveBeenCalledWith(
      'orchestration.workerStart',
      expect.objectContaining({ closeOnCompletion: false })
    )
    expect(call.mock.calls.map(([method]) => method)).toEqual(['orchestration.workerStart'])
  })
  it('rejects conflicting launch choices before calling the runtime', async () => {
    const call = vi.fn()
    await expect(
      ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
        flags: new Map([...flags, ['keep-as-conversation', true]]),
        client: { call },
        cwd: '/tmp',
        json: true
      } as never)
    ).rejects.toThrow('cannot be combined')
    expect(call).not.toHaveBeenCalled()
  })
})
