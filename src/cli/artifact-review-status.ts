import { resolve } from 'node:path'
import {
  ARTIFACT_REVIEW_WAIT_MAX_SECONDS,
  ARTIFACT_SLUG_PATTERN,
  artifactLifecycleSnapshot,
  type ArtifactReviewStatus,
  type ArtifactReviewStatusRequest
} from '../shared/artifact-review'
import { ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV } from '../shared/orchestration-compatibility-evidence'
import { RuntimeClientError } from './runtime-client'

type CliFlags = ReadonlyMap<string, string | boolean>

export const ARTIFACT_REVIEW_POLL_INTERVAL_MS = 3_000

const WHOLE_NUMBER = /^\d+$/

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

function stringValue(flags: CliFlags, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseWaitSeconds(raw: string): number {
  if (!WHOLE_NUMBER.test(raw)) {
    throw invalid(
      `--wait takes a whole number of seconds (max ${ARTIFACT_REVIEW_WAIT_MAX_SECONDS}).`
    )
  }
  return Math.min(Number(raw), ARTIFACT_REVIEW_WAIT_MAX_SECONDS)
}

export type ArtifactStatusInvocation = {
  target: string
  waitSeconds: number
}

/**
 * `--wait` is a global boolean flag, so `status plan.html --wait 60` leaves `60` as a second
 * positional (`wait-seconds`), and `status --wait 60 plan.html` puts it first. `--wait=60`
 * arrives as the flag's own value. All three spellings mean the same thing.
 */
export function parseArtifactStatusInvocation(flags: CliFlags): ArtifactStatusInvocation {
  let target = stringValue(flags, 'file')
  let extra = stringValue(flags, 'wait-seconds')
  const wait = flags.get('wait')
  if (target && extra && WHOLE_NUMBER.test(target) && !WHOLE_NUMBER.test(extra)) {
    ;[target, extra] = [extra, target]
  }
  if (!target) {
    throw invalid('Missing required file (a shared file path or an artifact id).')
  }
  if (typeof wait === 'string') {
    if (extra) {
      throw invalid(`Unexpected argument: ${extra}`)
    }
    return { target, waitSeconds: parseWaitSeconds(wait.trim()) }
  }
  if (wait === true) {
    if (!extra) {
      throw invalid(
        `--wait needs a number of seconds, e.g. --wait 300 (max ${ARTIFACT_REVIEW_WAIT_MAX_SECONDS}).`
      )
    }
    return { target, waitSeconds: parseWaitSeconds(extra) }
  }
  if (extra) {
    throw invalid(`Unexpected argument: ${extra}`)
  }
  return { target, waitSeconds: 0 }
}

/**
 * A path identifies the file's share record (same path + profile rule as `update`); a
 * slug-shaped argument is also sent as a raw artifact id, used when no record matches.
 */
export function artifactStatusRequestTarget(
  target: string,
  cwd: string,
  remoteSourceKey?: string
): Pick<ArtifactReviewStatusRequest, 'sourceKey' | 'slug'> {
  return {
    sourceKey: remoteSourceKey ?? resolve(cwd, target),
    ...(ARTIFACT_SLUG_PATTERN.test(target) ? { slug: target } : {})
  }
}

export const ARTIFACT_SSH_FILE_FORM_UNSUPPORTED_MESSAGE =
  "Over SSH, this relay does not send the file's identity for this command, so a file path could name a different page on this computer. Pass the page id or link instead (see `omni artifacts list`)."

/** True when the desktop runs this CLI for an SSH caller (set by the host passthrough). */
export function isSshArtifactCaller(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV] === 'ssh'
}

/**
 * Like `artifactStatusRequestTarget`, but an SSH caller whose relay sent no file identity may
 * use only the page id: an unqualified local path could match a desktop share record.
 */
export function artifactMutationRequestTarget(
  target: string,
  cwd: string,
  remoteSourceKey: string | undefined,
  sshCaller: boolean
): Pick<ArtifactReviewStatusRequest, 'sourceKey' | 'slug'> {
  if (remoteSourceKey || !sshCaller) {
    return artifactStatusRequestTarget(target, cwd, remoteSourceKey)
  }
  if (ARTIFACT_SLUG_PATTERN.test(target)) {
    return { slug: target }
  }
  throw new RuntimeClientError('invalid_argument', ARTIFACT_SSH_FILE_FORM_UNSUPPORTED_MESSAGE)
}

/**
 * What `--wait` watches: a closed or superseded page is final even while its review still
 * reads `pending`, and so is a review or study whose answers are in (`responses_in`).
 */
export function artifactReviewWaitStatus(status: ArtifactReviewStatus): string | null {
  const { lifecycle, supersededBy } = artifactLifecycleSnapshot(status)
  if (lifecycle) {
    return `closed:${lifecycle}`
  }
  if (supersededBy) {
    return 'superseded'
  }
  return status.status === 'pending' && status.progress?.ready === true
    ? 'responses_in'
    : status.status
}

export type ArtifactReviewPollOptions = {
  waitSeconds: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Re-reads while the review is `pending` and time remains; any other status is final. */
export async function pollArtifactReviewStatus<T>(
  read: () => Promise<T>,
  statusOf: (value: T) => string | null,
  options: ArtifactReviewPollOptions
): Promise<T> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const intervalMs = options.intervalMs ?? ARTIFACT_REVIEW_POLL_INTERVAL_MS
  const deadline = now() + options.waitSeconds * 1000
  let result = await read()
  while (statusOf(result) === 'pending' && now() < deadline) {
    await sleep(Math.min(intervalMs, deadline - now()))
    result = await read()
  }
  return result
}
