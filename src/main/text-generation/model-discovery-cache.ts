import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import { MODEL_LISTING_LIFETIME_MS } from '../../shared/model-listing-lifetime'
import {
  findFirstExecutable,
  getExecutableNames,
  splitPath
} from '../../shared/node-cli-command-resolution'
import { isQuietBackgroundAgentRunsEnabled } from './quiet-background-runs'
import type { DiscoverCommitMessageModelsResult } from './source-control-text-generation-types'

/**
 * How long a CLI's own model listing is reused while that CLI binary is unchanged. Why twice the
 * app's listing lifetime: the renderer asks again once its own copy is that old, and the answer
 * should come from here rather than another CLI run. Locally an update to the binary or another
 * account is a different key, so a listing never outlives the CLI version that produced it; an SSH
 * host has no binary to pin, so an update there shows within this window.
 */
export const MODEL_DISCOVERY_CACHE_TTL_MS = 2 * MODEL_LISTING_LIFETIME_MS
/**
 * How long a failed listing (signed out, timed out, no models) is answered from its record. Why
 * shorter: a CLI the person has just signed in to lists again within minutes, while a broken CLI
 * still runs at most once per window however often a launcher opens.
 */
export const MODEL_DISCOVERY_FAILURE_CACHE_TTL_MS = 5 * 60_000
const MAX_ENTRIES = 64

export type ModelDiscoveryCacheInput = {
  agentId: string
  plan: Pick<CommitMessagePlan, 'binary' | 'args' | 'stdinPayload'>
  env: NodeJS.ProcessEnv | undefined
  wslDistro?: string
} & ModelDiscoveryRefresh

/**
 * `force`: a launch is about to start this agent, so a failed answer on record is computed again
 * at once. A good answer is still reused, and one already being computed is shared.
 */
export type ModelDiscoveryRefresh = { force?: boolean }

/**
 * A host listing looked up before its agent's account is set up. `account` is the one settings
 * select for this host (null: the system default), never the seat a launch would balance to.
 */
export type AccountModelDiscoveryInput = {
  agentId: string
  plan: Pick<CommitMessagePlan, 'binary' | 'args' | 'stdinPayload' | 'env'>
  account: string | null
} & ModelDiscoveryRefresh

/**
 * Whether a dynamic CLI really listed its models. Why not just `success`: exit 0 with nothing
 * parsable falls back to the seed catalog, which launches refuse, so it is kept only as a failure.
 */
export function isModelListingSuccess(result: DiscoverCommitMessageModelsResult): boolean {
  return result.success && result.catalogOrigin === 'probe'
}

export type ModelDiscoveryCache = {
  /** A fresh listing for the same binary, arguments and environment, else runs `discover`. */
  run: (
    input: ModelDiscoveryCacheInput,
    discover: () => Promise<DiscoverCommitMessageModelsResult>
  ) => Promise<DiscoverCommitMessageModelsResult>
  /**
   * `run` for a Claude or Codex listing on this host, looked up before its account is set up:
   * keyed on the selected account and this process's environment rather than the prepared one,
   * so `setUpAndList` (set the account up, then list) runs only on a miss. Why: setting an account
   * up refreshes usage, balances seats, reads the keychain and syncs seat files, and a launcher
   * opening answered from here needs none of it; a balanced seat moving keeps the listing.
   */
  runForAccount: (
    input: AccountModelDiscoveryInput,
    setUpAndList: () => Promise<DiscoverCommitMessageModelsResult>
  ) => Promise<DiscoverCommitMessageModelsResult>
  /**
   * `compute`'s answer for this key while it is fresh (a remote host's listing, OMP's routing
   * check): a good answer for the listing lifetime, a failed one for the failure window.
   */
  remember: <T>(
    key: readonly unknown[],
    compute: () => Promise<T>,
    succeeded: (value: T) => boolean,
    refresh?: ModelDiscoveryRefresh
  ) => Promise<T>
  /** The pinned CLI file, as `resolveModelDiscoveryBinaryFingerprint` reads it. */
  fingerprint: typeof resolveModelDiscoveryBinaryFingerprint
}

/**
 * The CLI the plan would run, as `realpath:mtime:size`, or null when it cannot be pinned (WSL,
 * not on PATH). Why the resolved file: an update replaces the binary (or retargets the
 * `~/.local/bin/claude` symlink), so its listing is never reused across a CLI version.
 */
export async function resolveModelDiscoveryBinaryFingerprint(
  binary: string,
  env: NodeJS.ProcessEnv | undefined,
  wslDistro?: string
): Promise<string | null> {
  if (wslDistro) {
    return null
  }
  const source = env ?? process.env
  const candidate = isAbsolute(binary)
    ? binary
    : findFirstExecutable(
        process.platform,
        splitPath(source.PATH ?? source.Path),
        getExecutableNames(process.platform, binary)
      )
  if (!candidate) {
    return null
  }
  try {
    const resolved = await realpath(candidate)
    const info = await stat(resolved)
    return `${resolved}:${info.mtimeMs}:${info.size}`
  } catch {
    return null
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Why the whole environment, hashed: it carries the account (config dir, home, API key), and
 *  only its digest is kept so no credential sits in the cache key. */
function environmentDigest(env: NodeJS.ProcessEnv | undefined): string {
  return digest(
    Object.entries(env ?? process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

export function createModelDiscoveryCache(
  options: {
    now?: () => number
    ttlMs?: number
    failureTtlMs?: number
    fingerprint?: typeof resolveModelDiscoveryBinaryFingerprint
  } = {}
): ModelDiscoveryCache {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? MODEL_DISCOVERY_CACHE_TTL_MS
  const failureTtlMs = options.failureTtlMs ?? MODEL_DISCOVERY_FAILURE_CACHE_TTL_MS
  const fingerprint = options.fingerprint ?? resolveModelDiscoveryBinaryFingerprint
  const entries = new Map<string, { at: number; keepFor: number; ok: boolean; value: unknown }>()
  const inFlight = new Map<string, Promise<unknown>>()
  const remember = <T>(
    parts: readonly unknown[],
    compute: () => Promise<T>,
    succeeded: (value: T) => boolean,
    refresh: ModelDiscoveryRefresh = {}
  ): Promise<T> => {
    const key = digest(parts)
    const cached = entries.get(key)
    if (cached && now() - cached.at < cached.keepFor && (cached.ok || !refresh.force)) {
      return Promise.resolve(cached.value as T)
    }
    const running = inFlight.get(key)
    if (running) {
      return running as Promise<T>
    }
    const request = compute()
      .then((value) => {
        const ok = succeeded(value)
        entries.delete(key)
        entries.set(key, { at: now(), keepFor: ok ? ttlMs : failureTtlMs, ok, value })
        while (entries.size > MAX_ENTRIES) {
          entries.delete(entries.keys().next().value as string)
        }
        return value
      })
      .finally(() => inFlight.delete(key))
    inFlight.set(key, request)
    return request
  }
  return {
    remember,
    fingerprint,
    async run(input, discover) {
      const binary = await fingerprint(input.plan.binary, input.env, input.wslDistro)
      if (!binary) {
        return discover()
      }
      return remember(
        [
          'local',
          input.agentId,
          binary,
          input.plan.args,
          input.plan.stdinPayload,
          input.wslDistro ?? null,
          environmentDigest(input.env)
        ],
        discover,
        isModelListingSuccess,
        { force: input.force }
      )
    },
    async runForAccount(input, setUpAndList) {
      // Why this process's PATH: a prepared account changes only its config home, never PATH.
      const binary = await fingerprint(input.plan.binary, process.env)
      if (!binary) {
        return setUpAndList()
      }
      return remember(
        [
          'local-account',
          input.agentId,
          binary,
          input.plan.args,
          input.plan.stdinPayload,
          input.plan.env ?? null,
          input.account,
          environmentDigest(process.env)
        ],
        setUpAndList,
        isModelListingSuccess,
        { force: input.force }
      )
    }
  }
}

let installed: ModelDiscoveryCache | null = null

/** Main startup installs the app's one cache; without it (tests, tools) every listing runs. */
export function installLocalModelDiscoveryCache(cache: ModelDiscoveryCache | null): void {
  installed = cache
}

/** The installed cache while quiet background agent runs are on; null runs every listing. */
export function activeModelDiscoveryCache(): ModelDiscoveryCache | null {
  return isQuietBackgroundAgentRunsEnabled() ? installed : null
}

/**
 * An SSH host's OMP route listing (one relay call that runs `omp` there and attests its routes),
 * reused per connection like any other remote listing. A transport error reads as a failure.
 */
export function discoverRemoteOmpRoutes(
  connectionId: string,
  discover: () => Promise<DiscoverCommitMessageModelsResult>,
  refresh?: ModelDiscoveryRefresh
): Promise<DiscoverCommitMessageModelsResult> {
  const settle = (): Promise<DiscoverCommitMessageModelsResult> =>
    discover().catch((error: unknown) => ({
      success: false as const,
      error: error instanceof Error ? error.message : String(error)
    }))
  const cache = activeModelDiscoveryCache()
  return cache
    ? cache.remember(['remote', connectionId, 'omp-routes'], settle, isModelListingSuccess, refresh)
    : settle()
}
