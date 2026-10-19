import { describe, expect, it, vi } from 'vitest'
import { TeamBridge, type TeamPane } from './bridge'

const connection = {
  server: 'https://team.example/mcp',
  key: 'osc1.fake-test-key',
  team: 'org-fake',
  installation: 'install-fake'
}
const pane: TeamPane = {
  id: 'pane-fake',
  provider: 'claude',
  name: 'Plan review',
  source: { kind: 'pty', paneKey: 'pane-fake', worktreeId: 'workspace-fake' }
}
type Receipt = { operation: string; delivered: boolean }
const receipts = (): {
  read: (id: string) => Receipt | undefined
  save: (id: string, value: Receipt) => void
} => {
  const rows = new Map<string, Receipt>()
  return {
    read: (id: string) => rows.get(id),
    save: (id: string, value: Receipt) => void rows.set(id, { ...value })
  }
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
describe('steering bridge', () => {
  it('delivers one labelled turn, keeps approval wording, acks after delivery, and stops on close', async () => {
    const acked = deferred()
    const delivered = deferred()
    const directives: string[] = []
    let session = ''
    let waited = false
    const call = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'session_register') {
        session = String(args.session_id)
        return {}
      }
      if (tool === 'session_wait') {
        expect(args.wait_seconds).toBe(45)
        if (waited) {
          return { messages: [] }
        }
        waited = true
        return {
          messages: [
            {
              message_id: 'msg-fake',
              target_session_id: session,
              directive: 'Build this. Ask Sal before publishing.'
            }
          ]
        }
      }
      if (tool === 'session_ack') {
        expect(directives).toHaveLength(1)
        acked.resolve()
      }
      return {}
    })
    const deliver = vi.fn(async (_pane, text) => {
      directives.push(text)
      await delivered.promise
    })
    const bridge = new TeamBridge(connection, { call }, deliver, receipts(), vi.fn())
    bridge.reconcile([pane])
    bridge.reconcile([pane])
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    expect(call.mock.calls.some(([name]) => name === 'session_ack')).toBe(false)
    delivered.resolve()
    await acked.promise
    expect(directives).toEqual(['From OmniSI: Build this. Ask Sal before publishing.'])
    bridge.reconcile([])
    await bridge.stop()
    expect(call).toHaveBeenLastCalledWith(
      'session_register',
      expect.objectContaining({ status: 'stopped', session_id: session })
    )
  })
  it('acks an already delivered receipt without sending again', async () => {
    const acked = deferred()
    let session = ''
    const call = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'session_register') {
        session = String(args.session_id)
      }
      if (tool === 'session_wait') {
        return {
          messages: [
            {
              message_id: 'msg-fake',
              target_session_id: session,
              directive: 'Already delivered'
            }
          ]
        }
      }
      if (tool === 'session_ack') {
        acked.resolve()
      }
      return {}
    })
    const deliver = vi.fn()
    const bridge = new TeamBridge(
      connection,
      { call },
      deliver,
      {
        read: () => ({ operation: 'fake-operation', delivered: true }),
        save: vi.fn()
      },
      vi.fn()
    )
    bridge.reconcile([pane])
    await acked.promise
    await bridge.stop()
    expect(deliver).not.toHaveBeenCalled()
  })
  it('does not resend or ack an uncertain prior delivery', async () => {
    let session = ''
    const call = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'session_register') {
        session = String(args.session_id)
      }
      return tool === 'session_wait'
        ? {
            messages: [
              {
                message_id: 'msg-fake',
                target_session_id: session,
                directive: 'Never duplicate'
              }
            ]
          }
        : {}
    })
    const deliver = vi.fn()
    const report = vi.fn()
    const bridge = new TeamBridge(
      connection,
      { call },
      deliver,
      {
        read: () => ({ operation: 'fake-operation', delivered: false }),
        save: vi.fn()
      },
      report
    )
    bridge.reconcile([pane])
    await vi.waitFor(() => expect(report).toHaveBeenCalled())
    await bridge.stop()
    expect(deliver).not.toHaveBeenCalled()
    expect(call.mock.calls.some(([tool]) => tool === 'session_ack')).toBe(false)
  })
})
