/**
 * What the execution host finds for each deliverable. A local workspace is read on this disk with
 * the same reader delivery proof uses; an SSH workspace only through its registered provider. The
 * client's own disk is never consulted for a remote path, and lost contact is `unverifiable`.
 */

import {
  deliverableOverall,
  type DeliverableCheck,
  type DeliverableOverall
} from '../../shared/deliverable-verification-types'
import type { DeliveredFileReading } from '../runtime/delivered-file-read'
import type { DeliverableContractItem } from './deliverable-contract'

export type RemoteDeliverableStat = { size: number; isDirectory: boolean; mtime: number }

export type DeliverableCheckContext = {
  /** `null` = this host; otherwise the SSH connection the workspace lives on. */
  connectionId: string | null
  /** Plain name for messages: "this computer" or the SSH host's label. */
  hostLabel: string
  readLocalFile: (path: string) => Promise<DeliveredFileReading>
  /** Local directory: entries, or null when it is not a readable directory. */
  readLocalDirectory: (path: string) => Promise<number | null>
  /** Null when no provider is registered for the connection (lost contact). */
  statRemote: ((path: string) => Promise<RemoteDeliverableStat>) | null
  requestStartedAt: number | null
  /** Paths this conversation's own write tools finished writing (`SessionWrittenFilesStore`). */
  writtenPaths: ReadonlySet<string>
  /** Share URLs this pane published since the request started. */
  sharedUrls: ReadonlySet<string>
}

const CHANGED_CLAIMS = new Set(['created', 'updated'])

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 2) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /\b(?:no such file|not found|does not exist|ENOENT)\b/i.test(message)
}

function verdict(
  item: DeliverableContractItem,
  value: Pick<DeliverableCheck, 'verdict' | 'detail'> & Partial<DeliverableCheck>
): DeliverableCheck {
  const { resolved, ...rest } = item
  return { ...rest, ...(resolved ? { path: resolved } : {}), ...value }
}

/** A claimed write must be newer than the request, or one this conversation's tools made. */
function staleClaim(
  item: DeliverableContractItem,
  path: string,
  mtimeMs: number,
  ctx: DeliverableCheckContext
): boolean {
  return (
    CHANGED_CLAIMS.has(item.claim) &&
    ctx.requestStartedAt !== null &&
    mtimeMs < ctx.requestStartedAt &&
    !ctx.writtenPaths.has(path) &&
    !ctx.writtenPaths.has(item.resolved ?? '')
  )
}

async function checkLocal(
  item: DeliverableContractItem,
  path: string,
  ctx: DeliverableCheckContext
): Promise<DeliverableCheck> {
  const here = ctx.hostLabel
  if (item.kind === 'directory') {
    const entries = await ctx.readLocalDirectory(path)
    return entries === null
      ? verdict(item, { verdict: 'missing', detail: `no folder on ${here}` })
      : entries === 0
        ? verdict(item, { verdict: 'missing', detail: 'the folder is empty' })
        : verdict(item, { verdict: 'verified', detail: `folder with ${entries} entries` })
  }
  const read = await ctx.readLocalFile(path)
  if (read.status === 'unreadable') {
    return read.code === 'ENOENT' || read.code === 'ENOTDIR'
      ? verdict(item, { verdict: 'missing', detail: `no file on ${here}` })
      : verdict(item, { verdict: 'unverifiable', detail: `${here} could not read it` })
  }
  if (read.status === 'not-file') {
    return verdict(item, { verdict: 'missing', detail: 'a folder, not a file' })
  }
  const facts = { path: read.path, size: read.size, mtimeMs: read.mtimeMs }
  if (read.size === 0) {
    return verdict(item, { verdict: 'missing', detail: 'the file is empty (0 bytes)', ...facts })
  }
  if (staleClaim(item, read.path, read.mtimeMs, ctx)) {
    return verdict(item, {
      verdict: 'missing',
      detail: 'not changed since this request started',
      ...facts
    })
  }
  return read.status === 'file'
    ? verdict(item, { verdict: 'verified', detail: 'found', ...facts, sha256: read.hash })
    : verdict(item, { verdict: 'verified', detail: 'found (too large to hash)', ...facts })
}

async function checkRemote(
  item: DeliverableContractItem,
  path: string,
  ctx: DeliverableCheckContext
): Promise<DeliverableCheck> {
  if (!ctx.statRemote) {
    return verdict(item, {
      verdict: 'unverifiable',
      detail: `${ctx.hostLabel} is not connected`
    })
  }
  let info: RemoteDeliverableStat
  try {
    info = await ctx.statRemote(path)
  } catch (error) {
    return isNotFound(error)
      ? verdict(item, { verdict: 'missing', detail: `nothing at that path on ${ctx.hostLabel}` })
      : verdict(item, { verdict: 'unverifiable', detail: `${ctx.hostLabel} could not be read` })
  }
  const facts = { size: info.size, mtimeMs: info.mtime }
  if (item.kind === 'directory') {
    return info.isDirectory
      ? verdict(item, { verdict: 'verified', detail: 'folder found', ...facts })
      : verdict(item, { verdict: 'missing', detail: 'a file, not a folder', ...facts })
  }
  if (info.isDirectory) {
    return verdict(item, { verdict: 'missing', detail: 'a folder, not a file', ...facts })
  }
  if (info.size === 0) {
    return verdict(item, { verdict: 'missing', detail: 'the file is empty (0 bytes)', ...facts })
  }
  if (staleClaim(item, path, info.mtime, ctx)) {
    return verdict(item, {
      verdict: 'missing',
      detail: 'not changed since this request started',
      ...facts
    })
  }
  return verdict(item, { verdict: 'verified', detail: 'found', ...facts })
}

async function checkOne(
  item: DeliverableContractItem,
  ctx: DeliverableCheckContext
): Promise<DeliverableCheck> {
  if (item.kind === 'artifact') {
    return ctx.sharedUrls.has(item.target)
      ? verdict(item, { verdict: 'verified', detail: 'published from this session' })
      : verdict(item, {
          verdict: 'unverifiable',
          detail: 'no share record from this session on this computer'
        })
  }
  if (item.kind === 'url') {
    return verdict(item, { verdict: 'unverifiable', detail: 'links are not checked yet' })
  }
  if (!item.resolved) {
    return verdict(item, { verdict: 'unverifiable', detail: 'the path could not be resolved here' })
  }
  return ctx.connectionId
    ? checkRemote(item, item.resolved, ctx)
    : checkLocal(item, item.resolved, ctx)
}

/** A missing item the reply declined in its own words is declined, not missing. */
function honorDecline(check: DeliverableCheck): DeliverableCheck {
  return check.verdict === 'missing' && check.declined ? { ...check, verdict: 'declined' } : check
}

export async function checkDeliverables(
  items: readonly DeliverableContractItem[],
  ctx: DeliverableCheckContext
): Promise<{ checks: DeliverableCheck[]; overall: DeliverableOverall }> {
  // One at a time: a file check may hold up to 64 MB in memory while it hashes.
  const checks: DeliverableCheck[] = []
  for (const item of items) {
    checks.push(honorDecline(await checkOne(item, ctx)))
  }
  return { checks, overall: deliverableOverall(checks) }
}
