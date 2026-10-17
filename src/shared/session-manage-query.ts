import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from './execution-host'
import type { SessionManageEntry } from './session-manage-types'

/** Unknown provenance must never become local; equivalent encoded target IDs match. */
export function sessionManageHostKey(value: string | null | undefined): string | null {
  const host = parseExecutionHostId(value)
  return host?.kind === 'local'
    ? 'local'
    : host?.kind === 'ssh'
      ? toSshExecutionHostId(host.targetId)
      : host?.kind === 'runtime'
        ? toRuntimeExecutionHostId(host.environmentId)
        : null
}

/** Literal, case-insensitive terms over inventory metadata, never transcript search. */
export function sessionManageMatchesQuery(entry: SessionManageEntry, query: string): boolean {
  const text = [
    entry.title,
    entry.agent,
    entry.workspace,
    entry.worktreePath,
    entry.folder,
    entry.waitingOn,
    ...entry.pendingSteps
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => text.includes(term))
}
