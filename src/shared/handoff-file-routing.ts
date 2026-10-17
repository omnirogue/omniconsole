import { HANDOFF_FILE_MAX_BYTES } from './console-handoff-contract'

/**
 * How one file travels on a handoff, decided before anything is uploaded or committed.
 *
 * - `none`: the next step is an agent on the same worktree; nothing moves, it reads the disk.
 * - `git`: the file sits under the session's repo root, is not ignored and fits the git ceiling;
 *   it travels as a WIP commit on the handoff branch, pushed, and the sha is recorded.
 * - `pin`: any other readable file that fits the thread-pin ceiling; it is uploaded to the card
 *   workspace (or attached to a card-less thread) and pinned by sha256. The hub delivers it.
 * - `card`: a file above the pin ceiling but within the card upload ceiling; it is uploaded to the
 *   card workspace and delivered through `POST /api/board/{id}/deliver` (Drive when declared).
 * - `refused`: nothing fits; the reason is shown to the sender and the send does not proceed.
 *
 * Ceilings are the ones already in force, referenced, never restated. Raising them is its own lane.
 */
export const HANDOFF_GIT_ROUTE_MAX_BYTES = HANDOFF_FILE_MAX_BYTES
export const HANDOFF_PIN_ROUTE_MAX_BYTES = HANDOFF_FILE_MAX_BYTES
/** Matches `MAX_FILE_BYTES` in `main/backoffice/console-board-delivery.ts` (32 MB per file). */
export const HANDOFF_CARD_ROUTE_MAX_BYTES = 32 * 1024 * 1024

export type HandoffNextStep = {
  kind: 'agent' | 'person' | 'machine'
  /** True when the next step runs on the very worktree the file lives in. */
  sameWorktree: boolean
}

export type HandoffRouteFile = {
  /** Absolute path on the execution host. */
  path: string
  size: number
  /** Absolute path of the session's repo root on the same host; null when the session has no repo. */
  repoRoot: string | null
  /** True when git ignores the path (build output, secrets, caches); such files never go by git. */
  ignored: boolean
  /** False when the host could not read the file at all. */
  readable?: boolean
}

export type HandoffFileRoute =
  | { route: 'none'; path: string }
  | { route: 'git'; path: string; rel: string }
  | { route: 'pin'; path: string; name: string }
  | { route: 'card'; path: string; name: string }
  | { route: 'refused'; path: string; reason: string }

export type HandoffRoutePlan = {
  git: Extract<HandoffFileRoute, { route: 'git' }>[]
  pin: Extract<HandoffFileRoute, { route: 'pin' }>[]
  card: Extract<HandoffFileRoute, { route: 'card' }>[]
  refused: Extract<HandoffFileRoute, { route: 'refused' }>[]
  /** True when every file stays where it is (agent step on the same worktree). */
  none: boolean
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function fileName(path: string): string {
  const parts = normalizeSlashes(path).split('/')
  return parts.at(-1) ?? path
}

/** The path relative to `root`, or null when the file is not inside it (or is the root itself). */
export function relativeInside(root: string, path: string): string | null {
  const normalizedRoot = normalizeSlashes(root)
  const normalizedPath = normalizeSlashes(path)
  if (!normalizedRoot || !normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return null
  }
  const rel = normalizedPath.slice(normalizedRoot.length + 1)
  if (!rel || rel.split('/').some((segment) => segment === '..' || segment === '')) {
    return null
  }
  return rel
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

export function routeHandoffFile(file: HandoffRouteFile, next: HandoffNextStep): HandoffFileRoute {
  const { path } = file
  if (next.kind === 'agent' && next.sameWorktree) {
    return { route: 'none', path }
  }
  if (file.readable === false) {
    return {
      route: 'refused',
      path,
      reason: `${fileName(path)} could not be read on its computer.`
    }
  }
  if (!Number.isFinite(file.size) || file.size < 0) {
    return {
      route: 'refused',
      path,
      reason: `${fileName(path)} has no readable size.`
    }
  }
  const rel = file.repoRoot ? relativeInside(file.repoRoot, path) : null
  if (rel && !file.ignored && file.size <= HANDOFF_GIT_ROUTE_MAX_BYTES) {
    return { route: 'git', path, rel }
  }
  const name = fileName(path)
  if (file.size <= HANDOFF_PIN_ROUTE_MAX_BYTES) {
    return { route: 'pin', path, name }
  }
  if (file.size <= HANDOFF_CARD_ROUTE_MAX_BYTES) {
    return { route: 'card', path, name }
  }
  return {
    route: 'refused',
    path,
    reason: `${name} is ${megabytes(file.size)}; the card upload ceiling is ${megabytes(HANDOFF_CARD_ROUTE_MAX_BYTES)}. Raising ceilings is a separate lane.`
  }
}

/** Route every file; a plan is usable only when `refused` is empty. */
export function routeHandoffFiles(
  files: readonly HandoffRouteFile[],
  next: HandoffNextStep
): HandoffRoutePlan {
  const plan: HandoffRoutePlan = {
    git: [],
    pin: [],
    card: [],
    refused: [],
    none: false
  }
  const routes = files.map((file) => routeHandoffFile(file, next))
  if (routes.length > 0 && routes.every((route) => route.route === 'none')) {
    plan.none = true
    return plan
  }
  for (const route of routes) {
    switch (route.route) {
      case 'git':
        plan.git.push(route)
        break
      case 'pin':
        plan.pin.push(route)
        break
      case 'card':
        plan.card.push(route)
        break
      case 'refused':
        plan.refused.push(route)
        break
      case 'none':
        break
    }
  }
  return plan
}

/** True when a plan moves nothing at all; a person step with such a plan sends the memo alone. */
export function isEmptyRoutePlan(plan: HandoffRoutePlan): boolean {
  return plan.git.length + plan.pin.length + plan.card.length === 0
}
