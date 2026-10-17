import {
  isRuntimePathAbsolute,
  isWindowsAbsolutePathLike,
  resolveRuntimePath
} from './cross-platform-path'

/** The estate convention: every company keeps its folders under `~/Work/<Company>`. */
export const DEFAULT_COMPANY_WORK_ROOT = '~/Work'

export type CompanyFolderIdentity = { slug?: string | null; name?: string | null }

export type EnsureCompanyFolderResult =
  | { ok: true; created: boolean }
  | { ok: false; message: string }

function hasHomePrefix(value: string): boolean {
  return value === '~' || value.startsWith('~/') || value.startsWith('~\\')
}

/**
 * `~` and `~/…` against the given home. A bare `~user` is left verbatim — this
 * process cannot resolve another account's home, and guessing would lie.
 */
export function expandHome(value: string, home: string): string {
  const trimmed = value.trim()
  if (!trimmed || !hasHomePrefix(trimmed)) {
    return trimmed
  }
  const rest = trimmed.slice(1).replace(/^[\\/]+/, '')
  return rest ? resolveRuntimePath(home, rest) : home.replace(/[\\/]+$/, '') || home
}

/** A folder setting is either an absolute path or a `~`-rooted one; nothing else. */
export function isValidFolderSetting(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.split(/[\\/]/).includes('..')) {
    return false
  }
  if (hasHomePrefix(trimmed)) {
    return true
  }
  return isRuntimePathAbsolute(trimmed, isWindowsAbsolutePathLike(trimmed) ? 'windows' : 'posix')
}

/**
 * One path segment from a display name. Separators and `..` would silently move
 * the folder out of the company root, so they collapse to a dash.
 */
export function companyFolderSegment(displayName: string): string {
  const collapsed = displayName
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, ' ')
  return collapsed === '.' || collapsed === '..' ? collapsed.replace(/\./g, '-') : collapsed
}

function readOverride(
  overrides: Record<string, string> | null | undefined,
  company: CompanyFolderIdentity
): string | null {
  if (!overrides) {
    return null
  }
  for (const key of [company.slug, company.name]) {
    const candidate = key ? overrides[key] : undefined
    if (candidate && candidate.trim()) {
      return candidate.trim()
    }
  }
  return null
}

/**
 * Where this company's work lives on this machine: the saved override if there
 * is one, otherwise `<work root>/<Company name>`. Always absolute (`~` expanded).
 */
export function resolveCompanyFolder(args: {
  workRoot?: string | null
  overrides?: Record<string, string> | null
  company: CompanyFolderIdentity
  home: string
}): string {
  const override = readOverride(args.overrides, args.company)
  if (override) {
    return expandHome(override, args.home)
  }
  const root = expandHome(args.workRoot?.trim() || DEFAULT_COMPANY_WORK_ROOT, args.home)
  const segment = companyFolderSegment(args.company.name?.trim() || args.company.slug?.trim() || '')
  return segment ? resolveRuntimePath(root, segment) : root
}

/** The department's display name verbatim, e.g. `…/omnirogue/Customer Service`. */
export function resolveDomainFolder(companyFolder: string, domainName: string): string {
  const segment = companyFolderSegment(domainName)
  return segment ? resolveRuntimePath(companyFolder, segment) : companyFolder
}
