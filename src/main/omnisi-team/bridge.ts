import { createHash, randomUUID } from 'node:crypto'
import type { ConversationSource } from '../../shared/conversation-source'
import { conversationDeliveryOperationId } from '../../shared/conversation-source'
import type { TeamConnection } from './connection'

export type TeamPane = {
  id: string
  provider: string
  name: string
  source: ConversationSource
}
type Client = {
  call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>>
}
type Receipt = { operation: string; delivered: boolean }

export class TeamBridge {
  private workers = new Map<string, { abort: AbortController; done: Promise<void> }>()
  private stopped = false
  constructor(
    private readonly connection: TeamConnection,
    private readonly client: Client,
    private readonly deliver: (
      pane: TeamPane,
      text: string,
      operation: string,
      signal: AbortSignal
    ) => Promise<void>,
    private readonly receipts: {
      read(id: string): Receipt | undefined
      save(id: string, receipt: Receipt): void
    },
    private readonly report: (message: string) => void,
    private readonly ready?: (pane: TeamPane) => Promise<void>
  ) {}

  reconcile(panes: TeamPane[]): void {
    if (this.stopped) {
      return
    }
    const present = new Set(panes.map((pane) => pane.id))
    for (const [id, worker] of this.workers) {
      if (!present.has(id)) {
        worker.abort.abort()
      }
    }
    for (const pane of panes) {
      if (this.workers.has(pane.id)) {
        continue
      }
      const abort = new AbortController()
      const worker = { abort, done: Promise.resolve() }
      this.workers.set(pane.id, worker)
      worker.done = this.run(pane, abort.signal).finally(() => this.workers.delete(pane.id))
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    const workers = [...this.workers.values()]
    for (const worker of workers) {
      worker.abort.abort()
    }
    await Promise.all(workers.map((worker) => worker.done))
  }

  private async run(pane: TeamPane, signal: AbortSignal): Promise<void> {
    const suffix = createHash('sha256')
      .update(`${this.connection.installation}:${pane.id}`)
      .digest('hex')
      .slice(0, 16)
    const session = {
      session_id: `omniconsole-${suffix}`,
      handle: `@${pane.provider}-${pane.name
        .replace(/[^a-zA-Z0-9._-]/g, '-')
        .slice(0, 22)}-${suffix}`,
      provider: ['claude', 'codex', 'goose'].includes(pane.provider) ? pane.provider : 'custom',
      mode: 'mcp',
      summary: `OmniConsole: ${pane.name}`.slice(0, 500)
    }
    try {
      while (!signal.aborted) {
        try {
          await this.client.call('session_register', { ...session, status: 'active' }, signal)
          while (!signal.aborted) {
            const result = await this.client.call(
              'session_wait',
              {
                session_id: session.session_id,
                wait_seconds: 45
              },
              signal
            )
            if (signal.aborted) {
              break
            }
            const messages = result.messages
            if (!Array.isArray(messages)) {
              throw new Error('Invalid messages payload.')
            }
            for (const message of messages) {
              if (signal.aborted) {
                break
              }
              if (
                typeof message?.message_id !== 'string' ||
                typeof message?.directive !== 'string' ||
                message.target_session_id !== session.session_id
              ) {
                throw new Error('Invalid message item.')
              }
              const id = `${session.session_id}:${message.message_id}`
              const existing = this.receipts.read(id)
              if (existing && !existing.delivered) {
                throw new Error('Uncertain prior delivery needs reconciliation.')
              }
              if (!existing) {
                await this.ready?.(pane)
              }
              if (signal.aborted) {
                break
              }
              const receipt = existing ?? {
                operation: conversationDeliveryOperationId('prompt-queue', randomUUID()),
                delivered: false
              }
              // Reserve the operation before writing; an uncertain send must never become a fresh turn.
              if (!this.receipts.read(id)) {
                this.receipts.save(id, receipt)
              }
              if (!receipt.delivered) {
                await this.deliver(
                  pane,
                  `From OmniSI: ${message.directive}`,
                  receipt.operation,
                  signal
                )
                receipt.delivered = true
                this.receipts.save(id, receipt)
              }
              if (!signal.aborted) {
                await this.client.call('session_ack', { message_id: message.message_id }, signal)
              }
            }
            // A server returning immediately with no work must not busy-loop.
            await pause(signal, 250)
          }
        } catch {
          if (!signal.aborted) {
            this.report('OmniSI delivery is paused. Check the connection and the selected AI pane.')
            await pause(signal, 5000)
          }
        }
      }
    } finally {
      await this.client.call('session_register', { ...session, status: 'stopped' }).catch(() => {
        this.report(
          'OmniSI could not confirm this session stopped. It will expire after two minutes offline.'
        )
      })
    }
  }
}

function pause(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
