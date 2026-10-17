/** Owner-local identities; titles never establish protection or permission to stop. */
export type AutomaticSessionCleanupProtectionConfig = {
  protectedWorkspacePaths: string[]
  protectedPaneKeys: string[]
  protectStartedToday: boolean
  timeZone: string
}

export type CleanupKeepReason =
  | 'protection-unconfigured'
  | 'protection-unknown'
  | 'protected-workspace'
  | 'protected-session'
  | 'routine'
  | 'pinned'
  | 'saved'
  | 'started-today'
  /** A review decision or a Question still waits on the person; only the person removes it. */
  | 'awaiting-answer'

/** Lexical, platform-independent paths; ambiguous aliases fail closed at the caller. */
function workspacePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    return null
  }
  const separated = value.replaceAll('\\', '/')
  const path = /^[a-z]:\/+$/i.test(separated)
    ? `${separated.slice(0, 2)}/`
    : separated.replace(/\/+$/, '') || '/'
  if (!path.startsWith('/') && !/^[a-z]:\//i.test(path)) {
    return null
  }
  if (path.split('/').some((part) => part === '.' || part === '..')) {
    return null
  }
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path
}

export function normalizeAutomaticSessionCleanupProtection(
  value: unknown
): AutomaticSessionCleanupProtectionConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const config = value as Record<string, unknown>
  if (
    !Array.isArray(config.protectedWorkspacePaths) ||
    !Array.isArray(config.protectedPaneKeys) ||
    typeof config.protectStartedToday !== 'boolean' ||
    typeof config.timeZone !== 'string' ||
    !config.timeZone
  ) {
    return null
  }
  const paths = config.protectedWorkspacePaths.map(workspacePath)
  if (paths.some((path) => path === null)) {
    return null
  }
  if (config.protectedPaneKeys.some((key) => typeof key !== 'string' || !key.trim())) {
    return null
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone }).format(0)
  } catch {
    return null
  }
  return {
    protectedWorkspacePaths: [...new Set(paths as string[])],
    protectedPaneKeys: [...new Set(config.protectedPaneKeys as string[])],
    protectStartedToday: config.protectStartedToday,
    timeZone: config.timeZone
  }
}

export type AutomaticSessionCleanupProtectionInput = {
  config: unknown
  target: { worktreePath: string | null; paneKey: string | null; createdAt: number | null }
  facts: {
    routine: boolean | null
    pinned: boolean | null
    saved: boolean | null
    /** Opt-in per caller: an open answer wait (`answer-wait.ts`) for this session. */
    answerWait?: boolean
  }
  now: number
}

/** A null verdict only permits the existing idle/process/checkpoint guards to continue. */
export function automaticSessionCleanupKeep({
  config: rawConfig,
  target,
  facts,
  now
}: AutomaticSessionCleanupProtectionInput): CleanupKeepReason | null {
  // Why first: no configuration releases a session the person still owes an answer.
  if (facts.answerWait === true) {
    return 'awaiting-answer'
  }
  const config = normalizeAutomaticSessionCleanupProtection(rawConfig)
  if (!config) {
    return 'protection-unconfigured'
  }
  if (facts.routine === true) {
    return 'routine'
  }
  if (facts.pinned === true) {
    return 'pinned'
  }
  if (facts.saved === true) {
    return 'saved'
  }
  if (target.paneKey && config.protectedPaneKeys.includes(target.paneKey)) {
    return 'protected-session'
  }
  const path = workspacePath(target.worktreePath)
  if (
    path &&
    config.protectedWorkspacePaths.some(
      (root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
    )
  ) {
    return 'protected-workspace'
  }
  if (
    !path ||
    !target.paneKey ||
    typeof facts.routine !== 'boolean' ||
    typeof facts.pinned !== 'boolean' ||
    typeof facts.saved !== 'boolean' ||
    typeof target.createdAt !== 'number' ||
    !Number.isFinite(target.createdAt) ||
    target.createdAt <= 0 ||
    !Number.isFinite(new Date(target.createdAt).getTime()) ||
    !Number.isFinite(new Date(now).getTime()) ||
    !Number.isFinite(now) ||
    now <= 0 ||
    target.createdAt > now
  ) {
    return 'protection-unknown'
  }
  try {
    const day = new Intl.DateTimeFormat('en-US', {
      timeZone: config.timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    })
    if (config.protectStartedToday && day.format(target.createdAt) === day.format(now)) {
      return 'started-today'
    }
  } catch {
    return 'protection-unknown'
  }
  return null
}
