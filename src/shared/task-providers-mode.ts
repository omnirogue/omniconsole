/* OmniConsole-only layer over the upstream task-provider settings.
 * Kept in its own module (instead of editing `task-providers.ts`) so upstream
 * syncs of the shared provider contract stay conflict-free: nothing here is
 * upstream code, and every consumer opts in through one helper. */
import {
  TASK_PROVIDERS,
  isTaskProvider,
  normalizeVisibleTaskProviders,
  type TaskProvider
} from './task-providers'

/** 'console-only' shows just the OmniConsole backoffice provider; 'all' is upstream behaviour. */
export type TaskSourcesMode = 'console-only' | 'all'

/** The provider that IS the console. */
export const CONSOLE_TASK_PROVIDER: TaskProvider = 'backoffice'

/** Why: every task source (GitHub PRs/Issues, Jira, Linear, GitLab, …) is shown
 * unless the person switched to console-only in Settings -> Tasks. A mode that
 * was only auto-stamped at load is not a choice — see resolveTaskSourcesMode. */
export const DEFAULT_TASK_SOURCES_MODE: TaskSourcesMode = 'all'

export function isTaskSourcesMode(value: unknown): value is TaskSourcesMode {
  return value === 'console-only' || value === 'all'
}

/** Read-time lens: a stored value that is missing or corrupt falls back to the default mode. */
export function readTaskSourcesMode(value: unknown): TaskSourcesMode {
  return isTaskSourcesMode(value) ? value : DEFAULT_TASK_SOURCES_MODE
}

/**
 * The one shared helper every provider-listing surface routes through.
 * In 'console-only' the answer is always exactly the console provider — a list
 * must never be empty, and the console is the only source this mode offers.
 * In 'all' the caller's providers are returned untouched (upstream behaviour).
 */
export function applyTaskSourcesMode(
  mode: unknown,
  providers: readonly TaskProvider[]
): TaskProvider[] {
  if (readTaskSourcesMode(mode) === 'console-only') {
    return [CONSOLE_TASK_PROVIDER]
  }
  return [...providers]
}

/** Settings -> effective visible providers. Never mutates the persisted list:
 *  switching back to 'all' restores exactly what the person had. */
export function selectVisibleTaskProviders(
  settings: { taskSourcesMode?: unknown; visibleTaskProviders?: unknown } | null | undefined
): TaskProvider[] {
  return applyTaskSourcesMode(
    settings?.taskSourcesMode,
    normalizeVisibleTaskProviders(settings?.visibleTaskProviders)
  )
}

/** Which task-source cards Settings -> Tasks renders in this mode. */
export function selectTaskProviderCards(mode: unknown): readonly TaskProvider[] {
  return readTaskSourcesMode(mode) === 'console-only'
    ? [CONSOLE_TASK_PROVIDER]
    : [...TASK_PROVIDERS]
}

/** Persisted evidence that a provider was actually set up by this person. */
export type PersistedTaskProviderEvidence = {
  defaultTaskSource?: unknown
  defaultLinearTeamSelection?: unknown
  githubProjects?: { pinned?: unknown; recent?: unknown } | null
  gitlabProjects?: { pinned?: unknown; recent?: unknown } | null
}

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

/**
 * Providers a saved profile demonstrably used. Credentials live in the main
 * process (keychain/CLI auth) and are not readable while settings load, so this
 * reads the settings a provider only writes once it has been used:
 *  - a last-used task source other than 'github' (github is the factory default),
 *  - a Linear team selection,
 *  - pinned/recent GitHub or GitLab projects.
 */
export function getConfiguredTaskProviders(
  settings: PersistedTaskProviderEvidence | null | undefined
): TaskProvider[] {
  const configured = new Set<TaskProvider>()
  const lastUsed = settings?.defaultTaskSource
  if (isTaskProvider(lastUsed) && lastUsed !== 'github') {
    configured.add(lastUsed)
  }
  if (hasEntries(settings?.defaultLinearTeamSelection)) {
    configured.add('linear')
  }
  if (
    hasEntries(settings?.githubProjects?.pinned) ||
    hasEntries(settings?.githubProjects?.recent)
  ) {
    configured.add('github')
  }
  if (
    hasEntries(settings?.gitlabProjects?.pinned) ||
    hasEntries(settings?.gitlabProjects?.recent)
  ) {
    configured.add('gitlab')
  }
  return TASK_PROVIDERS.filter((provider) => configured.has(provider))
}

/**
 * Load-time resolution. A stored mode wins only when the person picked it in
 * Settings -> Tasks (`storedModeChosen`). Earlier builds auto-stamped
 * 'console-only' on every profile; without the chosen flag that stamp is undone
 * and every task source comes back.
 */
export function resolveTaskSourcesMode(input: {
  storedMode?: unknown
  storedModeChosen?: unknown
}): TaskSourcesMode {
  if (input.storedModeChosen === true && isTaskSourcesMode(input.storedMode)) {
    return input.storedMode
  }
  return DEFAULT_TASK_SOURCES_MODE
}
