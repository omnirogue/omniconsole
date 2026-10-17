import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { deliverFile } from './file-delivery'

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const flags = new Map<string, string | boolean>([
    ['path', 'outputs/report.pdf'],
    ['worktree', 'id:remote-folder'],
    ['source-host', 'ssh:worker'],
    ['recipient-runtime-id', '11111111-1111-4111-8111-111111111111'],
    ['desktop-name', 'report.pdf']
  ])
  const call = vi.fn().mockResolvedValue({
    id: 'delivery',
    ok: true,
    result: {
      disposition: 'delivered',
      recipient: { path: '/recipient/Desktop/report.pdf', hostname: 'recipient' },
      size: 4,
      sha256: '1'.repeat(64)
    }
  })
  const run = () =>
    deliverFile({
      flags,
      client: { call } as unknown as RuntimeClient,
      cwd: '/worker/cwd',
      json: true
    })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  return { flags, call, run }
}

it('sends explicit source and recipient identities without resolving the worker cwd as a destination', async () => {
  const { run, call, flags } = fixture()
  await run()
  expect(call).toHaveBeenCalledWith(
    'files.deliver',
    expect.objectContaining({
      sourcePath: 'outputs/report.pdf',
      expectedSourceHostId: 'ssh:worker',
      recipientRuntimeId: '11111111-1111-4111-8111-111111111111',
      destination: { kind: 'desktop', name: 'report.pdf' }
    }),
    { timeoutMs: 240_000 }
  )
  call.mockClear()
  flags.delete('recipient-runtime-id')
  await expect(run()).rejects.toThrow('recipient-runtime-id')
  expect(call).not.toHaveBeenCalled()
})

it('refuses ambiguous destinations and makes no fallback after an old runtime or uncertain reply', async () => {
  const { run, flags, call } = fixture()
  flags.set('destination', '/another/report.pdf')
  await expect(run()).rejects.toThrow('exactly one')
  expect(call).not.toHaveBeenCalled()
  flags.delete('destination')
  call.mockRejectedValue(new Error('method_not_found'))
  await expect(run()).rejects.toThrow('method_not_found')
  expect(call).toHaveBeenCalledTimes(1)
})
