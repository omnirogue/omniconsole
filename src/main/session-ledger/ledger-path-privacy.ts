import { LEDGER_DETAIL_LIMITS } from '../../shared/session-ledger-contract'

/** What a path becomes when a home directory could still be read off it after stripping. */
export const REDACTED_PATH = '~/[redacted]'

// Why: matched before any path leaves the process; the console never learns an OS username.
// Case-insensitive because Windows, macOS and WSL mounts spell the same home in any case.
const HOME_PREFIXES = [
  /^\/Users\/[^/]+(?=\/|$)/i,
  /^\/home\/[^/]+(?=\/|$)/i,
  /^\/root(?=\/|$)/i,
  /^[A-Za-z]:\/Users\/[^/]+(?=\/|$)/i,
  /^\/mnt\/[A-Za-z]\/Users\/[^/]+(?=\/|$)/i,
  /^\/\/wsl(?:\$|\.localhost)\/[^/]+\/(?:home\/[^/]+|root)(?=\/|$)/i
]

// Why: fail closed — a home-shaped segment that survived stripping is replaced, never published.
const HOME_SEGMENT = /(?:^|\/)(?:Users|home)\/[^/]+\/|^\/root(?:\/|$)|^\/mnt\/[A-Za-z]\/Users\//i

function toForwardSlashes(value: string): string {
  return value.replaceAll('\\', '/')
}

/** `/Users/<x>/…`, `/home/<x>/…`, `C:\Users\<x>\…`, `/mnt/c/Users/<x>/…` → `~/…`; unchanged otherwise. */
export function stripUsernameFromPath(path: string): string {
  const normalized = toForwardSlashes(path.trim())
  for (const prefix of HOME_PREFIXES) {
    if (prefix.test(normalized)) {
      const rest = normalized.replace(prefix, '')
      return rest ? `~${rest}` : '~/'
    }
  }
  return normalized
}

function withoutHomeSegments(path: string): string {
  return HOME_SEGMENT.test(path) ? REDACTED_PATH : path
}

/**
 * The path as the ledger publishes it: repo-relative when inside the workspace root,
 * otherwise home-relative, never longer than the contract's path limit.
 */
export function publishablePath(path: string, workspaceRoot?: string | null): string {
  const normalized = toForwardSlashes(path.trim())
  const root = workspaceRoot ? toForwardSlashes(workspaceRoot.trim()).replace(/\/+$/, '') : ''
  const result = withoutHomeSegments(
    root && (normalized === root || normalized.startsWith(`${root}/`))
      ? normalized.slice(root.length + 1) || '.'
      : stripUsernameFromPath(normalized)
  )
  return result.length > LEDGER_DETAIL_LIMITS.path
    ? result.slice(result.length - LEDGER_DETAIL_LIMITS.path)
    : result
}
