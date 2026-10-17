/**
 * What one steward move reads and writes: the observed session, its pass memory, and the notes,
 * Stalled marks and "nothing now" outcomes every step of `steward-row.ts` reports with.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import type { SessionStewardActivityKind } from '../../shared/session-steward-status'
import type { ObservedSession } from '../session-manage/session-manage-observe'
import type { StewardTarget } from './steward-actions'
import type { StewardPassDeps, StewardPassMemory } from './steward-pass'

export type StewardRowAction =
  | 'skip'
  | 'none'
  | 'error'
  | Exclude<SessionStewardActivityKind, 'cleanup'>

export type StewardRowOutcome = {
  paneKey: string
  action: StewardRowAction
  detail?: string
  recheckAt?: number
}

export type StewardRow = {
  deps: StewardPassDeps
  memory: StewardPassMemory
  row: SessionManageSidebarRow
  session: ObservedSession
  entry: SessionManageEntry
  paneKey: string
  turnKey: string | null
  now: number
}

export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export async function note(
  ctx: StewardRow,
  kind: Exclude<StewardRowAction, 'skip' | 'none' | 'error'>,
  summary: string,
  once = false
): Promise<StewardRowOutcome> {
  const id = `${ctx.paneKey}|${ctx.turnKey}|${kind}|${summary}`
  if (!once || !ctx.memory.noted.has(id)) {
    ctx.memory.noted.add(id)
    await ctx.deps.store.note({ kind, paneKey: ctx.paneKey, title: ctx.entry.title, summary })
  }
  return { paneKey: ctx.paneKey, action: kind, detail: summary }
}

export const none = (ctx: StewardRow, recheckAt?: number): StewardRowOutcome => ({
  paneKey: ctx.paneKey,
  action: 'none',
  ...(recheckAt !== undefined ? { recheckAt } : {})
})

export function target(ctx: StewardRow, source: ConversationSource): StewardTarget {
  return { entry: ctx.entry, source, agentProcess: ctx.session.agentProcess }
}

export async function stall(ctx: StewardRow, reason: string): Promise<StewardRowOutcome> {
  await ctx.deps.store.transact((data) => {
    const session = data.sessions[ctx.paneKey] ?? { updatedAt: ctx.now }
    data.sessions[ctx.paneKey] = {
      ...session,
      title: ctx.entry.title,
      stalled: { at: ctx.now, reason, turnKey: ctx.turnKey },
      updatedAt: ctx.now
    }
  })
  return note(ctx, 'stalled', `“${ctx.entry.title}” is Stalled: ${reason}`)
}
