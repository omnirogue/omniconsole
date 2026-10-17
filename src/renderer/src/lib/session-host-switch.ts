import {
  parseExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostKind
} from '../../../shared/execution-host'
import {
  SESSION_HOST_KINDS,
  hostsOfKind,
  inSessionHostFilter,
  showAllSessionHostsOfKind,
  type SessionHostFilter
} from './session-host-scope'

type SessionHost = { id: ExecutionHostId; kind: ExecutionHostKind }
/** The filter as the view saves it; older builds may have saved nothing. */
type SavedSessionHostFilter = { kinds: readonly string[]; hiddenHostIds?: readonly string[] }

function kindOf(hostId: ExecutionHostId): ExecutionHostKind {
  return parseExecutionHostId(hostId)?.kind ?? 'local'
}

/*
 * Home and the Globe are one switch: Home is this computer alone, the Globe is this computer and
 * every paired runtime at once, each a single click from the other. The SSH plug keeps whatever it
 * showed through either, and the chevron beside the Globe picks one computer alone.
 */

/** Whether any host of the kind is in view; the Globe is on while a paired runtime shows. */
export function showsSessionHostKind(
  filter: SessionHostFilter,
  kind: ExecutionHostKind,
  hosts: readonly SessionHost[]
): boolean {
  return hostsOfKind(hosts, kind).some((id) => inSessionHostFilter(id, filter))
}

/** Home: this computer's sessions only, in one click from wherever the Globe had the list. */
export function homeSessionHostFilter(filter: SessionHostFilter): SessionHostFilter {
  return {
    kinds: SESSION_HOST_KINDS.filter(
      (kind) => kind === 'local' || (kind === 'ssh' && filter.kinds.includes('ssh'))
    ),
    hiddenHostIds: filter.hiddenHostIds.filter((id) => kindOf(id) === 'ssh')
  }
}

/**
 * Globe: sessions on this computer and every paired runtime, none narrowed away, in one click
 * from Home or from a Globe narrowed to one computer.
 */
export function everywhereSessionHostFilter(filter: SessionHostFilter): SessionHostFilter {
  return showAllSessionHostsOfKind({ ...filter, kinds: [...filter.kinds, 'local'] }, 'runtime')
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value))
}

/**
 * Whether two saved filters show the same hosts, whatever object holds them: a landing write
 * that repeats the view in force (Home's own, an archive re-read) is not the person moving it.
 */
export function sameSessionHostFilter(
  a: SavedSessionHostFilter | undefined,
  b: SavedSessionHostFilter | undefined
): boolean {
  if (!a || !b) {
    return a === b
  }
  return sameMembers(a.kinds, b.kinds) && sameMembers(a.hiddenHostIds ?? [], b.hiddenHostIds ?? [])
}

/**
 * One computer's sessions alone (the computer picked to view and start sessions on). Picking
 * this computer is Home.
 */
export function onlySessionHostFilter(
  filter: SessionHostFilter,
  hostId: ExecutionHostId,
  hosts: readonly SessionHost[]
): SessionHostFilter {
  const kind = kindOf(hostId)
  if (kind === 'local') {
    return homeSessionHostFilter(filter)
  }
  return {
    kinds: SESSION_HOST_KINDS.filter(
      (each) => each === kind || (each === 'ssh' && filter.kinds.includes('ssh'))
    ),
    hiddenHostIds: [
      ...filter.hiddenHostIds.filter((id) => kindOf(id) === 'ssh'),
      ...hostsOfKind(hosts, kind).filter((id) => id !== hostId)
    ]
  }
}
