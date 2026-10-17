import { z } from 'zod'
import type {
  NotificationDispatchRequest,
  NotificationDispatchResult
} from '../../shared/notification-settings-types'

const id = z.union([z.string().min(1), z.number().int().nonnegative().safe()])
const pageSchema = z.object({
  items: z
    .array(
      z.object({
        id,
        event: z.string(),
        title: z.string(),
        body: z.string(),
        url: z.string(),
        created_at: z.string()
      })
    )
    .max(50),
  next_after: id.nullable()
})
export type WorkNoticeCursor = {
  after: string | number | null
  pending: string | number | null
  seen: string[]
}
export type WorkNoticeScope = {
  key: string
  current: () => boolean
  request: (path: string, throughId?: string | number) => Promise<unknown>
  read: () => WorkNoticeCursor
  write: (cursor: WorkNoticeCursor) => void
}

type Dependencies = {
  enabled: () => boolean
  scope: () => WorkNoticeScope | null
  dispatch: (
    request: NotificationDispatchRequest
  ) => NotificationDispatchResult | Promise<NotificationDispatchResult>
  now?: () => number
}

export class WorkNoticePoller {
  private stopped = false
  private busy = false
  private retryAt = 0
  private failures = 0
  private scopeKey: string | null = null

  constructor(private readonly deps: Dependencies) {}

  stop(): void {
    this.stopped = true
  }

  async tick(): Promise<void> {
    if (this.stopped || this.busy || !this.deps.enabled()) {
      return
    }
    this.busy = true
    try {
      const scope = this.deps.scope()
      if (!scope) {
        this.scopeKey = null
        return
      }
      if (scope.key !== this.scopeKey) {
        this.scopeKey = scope.key
        this.retryAt = 0
        this.failures = 0
      }
      const now = this.deps.now ?? Date.now
      if (now() < this.retryAt) {
        return
      }
      const current = (): boolean => !this.stopped && this.deps.enabled() && scope.current()
      const cursor = scope.read()
      if (cursor.pending !== null) {
        if (!current()) {
          return
        }
        await scope.request('/v1/me/notifications/ack', cursor.pending)
        if (!current()) {
          return
        }
        cursor.after = cursor.pending
        cursor.pending = null
        scope.write(cursor)
      }
      const query = cursor.after === null ? '' : `after=${encodeURIComponent(cursor.after)}&`
      const page = pageSchema.parse(await scope.request(`/v1/me/notifications?${query}limit=50`))
      if (!current()) {
        return
      }
      const seen = new Set(cursor.seen)
      for (const item of page.items) {
        if (!current()) {
          return
        }
        const key = String(item.id)
        if (seen.has(key)) {
          continue
        }
        const result = await this.deps.dispatch({
          source: 'work-notice',
          notificationId: `work-notice:${scope.key}:${key}`,
          workNoticeTitle: item.title,
          workNoticeBody: item.body,
          workNoticeUrl: item.url
        })
        if (!current() || result.reason === 'disabled' || result.reason === 'source-disabled') {
          return
        }
        seen.add(key)
        cursor.seen = [...seen].slice(-200)
        scope.write(cursor)
      }
      const last = page.items.at(-1)
      if (last) {
        cursor.pending = page.next_after ?? last.id
        scope.write(cursor)
        if (!current()) {
          return
        }
        await scope.request('/v1/me/notifications/ack', cursor.pending)
        if (!current()) {
          return
        }
        cursor.after = cursor.pending
        cursor.pending = null
        scope.write(cursor)
      }
      this.failures = 0
      this.retryAt = 0
    } catch (error) {
      const status = (error as { statusCode?: number } | null)?.statusCode
      const delay =
        status === 404
          ? 30 * 60_000
          : Math.min(30 * 60_000, 60_000 * 2 ** Math.min(++this.failures, 5))
      this.retryAt = (this.deps.now ?? Date.now)() + delay
    } finally {
      this.busy = false
    }
  }
}
