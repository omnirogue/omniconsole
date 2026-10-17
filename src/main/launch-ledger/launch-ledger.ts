import { attemptLaunchProvenance, warnLaunchProvenanceFailure } from './launch-provenance-guard'
import { callerLaunchClaims } from './launch-caller-claims'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { isLaunchUuid } from '../../shared/launch-identifiers'
import { ledgerIdentifier } from './launch-ledger-identifiers'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createAsyncLocalFileSink,
  type AsyncLocalFileSink
} from '../observability/async-local-file-sink'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { normalizeLaunchCause, type LaunchCause } from '../../shared/launch-cause'
import type { LaunchLedgerRow, RuntimeTerminalWhy } from '../../shared/launch-ledger'
export type { LaunchLedgerRow } from '../../shared/launch-ledger'

// Spawn records belong outside session-actions.jsonl: rotating them must not erase organization history.
// The organization reader requires actor/action/summary; launches have a separate row contract.
export const LAUNCH_LEDGER_FILE = 'launch-ledger.ndjson'
export const LAUNCH_LEDGER_MAX_BYTES = 2 * 1024 * 1024
export const LAUNCH_LEDGER_MAX_FILES = 3
export type LaunchLedgerInput = Omit<
  LaunchLedgerRow,
  'v' | 'ts' | 'cause' | 'reference' | 'actor' | 'requestId' | 'parentPaneKey'
> & {
  cause?: LaunchCause | null
  ts?: string
}
let activeLaunchProducers = new Set<Promise<unknown>>()
let directory: string | null = null
let sink: AsyncLocalFileSink | null = null
let maxBytes = LAUNCH_LEDGER_MAX_BYTES

function ledgerPath(): string {
  return join(directory ?? getProfileUserDataPath(), LAUNCH_LEDGER_FILE)
}

function rowFields(input: LaunchLedgerInput): Omit<LaunchLedgerRow, 'v' | 'ts'> {
  const normalized = normalizeLaunchCause({
    ...input.cause,
    ...(input.cause?.claimedReference
      ? callerLaunchClaims({ reference: input.cause.claimedReference })
      : {})
  })
  delete normalized.claimedReference
  const { trigger, ...causeFields } = normalized
  const row: Omit<LaunchLedgerRow, 'v' | 'ts'> = {
    pipeline:
      input.pipeline === 'structured-agent-session'
        ? 'structured-agent-session'
        : input.pipeline === 'renderer-ipc'
          ? 'renderer-ipc'
          : 'runtime-controller',
    ptyId: ledgerIdentifier('ptyId', input.ptyId),
    cause: trigger,
    ...causeFields,
    hasStartupCommand: input.hasStartupCommand === true,
    process: ['attachment-intent', 'prepared', 'created', 'attached', 'failed', 'unknown'].includes(
      input.process
    )
      ? input.process
      : 'unknown'
  }
  for (const key of ['paneKey', 'tabId', 'worktreeId'] as const) {
    const id = ledgerIdentifier(key, input[key])
    if (id) {
      row[key] = id
    }
  }
  if (input.agent && isTuiAgent(input.agent)) {
    row.agent = input.agent
  }
  if (isLaunchUuid(input.incarnationId)) {
    row.incarnationId = input.incarnationId
  }
  if (isLaunchUuid(input.launchId)) {
    row.launchId = input.launchId
  }
  if (input.outcome === 'failed-after-start') {
    row.outcome = input.outcome
  }
  if (input.intent === 'attach' || input.intent === 'create-or-attach') {
    row.intent = input.intent
  }
  if (typeof input.visible === 'boolean') {
    row.visible = input.visible
  }
  return row
}

/** Queue ordered appends without awaiting disk; crashes may lose unflushed diagnostics. */
export function recordLaunch(input: LaunchLedgerInput): void {
  try {
    const row = {
      v: 1 as const,
      ts:
        typeof input.ts === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.ts)
          ? input.ts
          : new Date().toISOString(),
      ...rowFields(input)
    }
    if (row.cause === 'unknown' && !['prepared', 'attachment-intent'].includes(row.process)) {
      console.warn(`[launch-ledger] ${row.pipeline}: creator omitted a valid cause`)
    }
    sink ??= createAsyncLocalFileSink({
      filePath: ledgerPath(),
      maxBytes,
      maxFiles: LAUNCH_LEDGER_MAX_FILES
    })
    sink.push(row)
  } catch {
    warnLaunchProvenanceFailure('spawn-record')
  }
}

export async function flushLaunchLedger(): Promise<void> {
  try {
    await sink?.flush()
  } catch {
    /* Diagnostics cannot fail a launch. */
  }
}

/** Track receipt producers without changing when or whether they run. */
export function trackLaunchProducer<T>(run: () => Promise<T>): Promise<T> {
  const pending = run()
  const forget = (): void => {
    try {
      activeLaunchProducers.delete(pending)
    } catch {
      warnLaunchProvenanceFailure('launch-producers')
      // A broken delete must not leave quit looping over an already settled producer.
      activeLaunchProducers = new Set(
        [...activeLaunchProducers].filter((entry) => entry !== pending)
      )
    }
  }
  const tracked = attemptLaunchProvenance(
    'launch-producers',
    () => {
      activeLaunchProducers.add(pending)
      void pending.then(
        () => attemptLaunchProvenance('launch-producers', forget, undefined),
        () => attemptLaunchProvenance('launch-producers', forget, undefined)
      )
      return true
    },
    false
  )
  if (!tracked) {
    attemptLaunchProvenance('launch-producers', forget, undefined)
  }
  return pending
}

/** Join the caller's bounded quit barrier after its producers have settled. */
export async function drainLaunchLedgerAfterProducersStop(
  producers: readonly Promise<unknown>[]
): Promise<void> {
  await Promise.allSettled(producers)
  while (activeLaunchProducers.size) {
    await Promise.allSettled(activeLaunchProducers)
  }
  await flushLaunchLedger()
}

export async function findLaunchHistory(target: {
  ptyId?: string
  paneKey?: string
  incarnationId?: string
}): Promise<
  Pick<
    RuntimeTerminalWhy,
    'launch' | 'attachments' | 'currentStartUnrecorded' | 'previousCreations'
  >
> {
  try {
    await flushLaunchLedger()
    const rows: LaunchLedgerRow[] = []
    for (let index = 0; index < LAUNCH_LEDGER_MAX_FILES; index++) {
      const file = index === 0 ? ledgerPath() : `${ledgerPath()}.${index}`
      const text = await readFile(file, 'utf8').catch(() => '')
      for (const line of text.trim().split('\n').toReversed()) {
        try {
          const row = JSON.parse(line) as LaunchLedgerRow
          if (
            row.v !== 1 ||
            typeof row.ts !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.ts) ||
            (typeof row.ptyId !== 'string' && row.ptyId !== null) ||
            !['renderer-ipc', 'runtime-controller', 'structured-agent-session'].includes(
              row.pipeline
            ) ||
            !['attachment-intent', 'prepared', 'created', 'attached', 'failed', 'unknown'].includes(
              row.process
            ) ||
            typeof row.hasStartupCommand !== 'boolean'
          ) {
            continue
          }
          rows.push({
            v: 1,
            ts: row.ts,
            ...rowFields({
              ...row,
              cause: {
                trigger: row.cause,
                reference: row.reference,
                actor: row.actor,
                requestId: row.requestId,
                requestIdHash: row.requestIdHash,
                clientMutationIdHash: row.clientMutationIdHash,
                claimedTrigger: row.claimedTrigger,
                claimedTriggerHash: row.claimedTriggerHash,
                claimedReference: row.claimedReference,
                claimedReferenceHashes: row.claimedReferenceHashes,
                parentPaneKey: row.parentPaneKey
              }
            })
          })
        } catch {
          /* A torn line does not hide retained history. */
        }
      }
    }
    const seen = new Set<string>()
    const launches = rows.filter((row) => {
      if (!row.launchId) {
        return true
      }
      if (seen.has(row.launchId)) {
        return false
      }
      seen.add(row.launchId)
      return true
    })
    for (const key of ['ptyId', 'paneKey'] as const) {
      if (!target[key]) {
        continue
      }
      const matches = launches.filter((row) => row[key] === ledgerIdentifier(key, target[key]))
      const current = target.incarnationId
        ? matches.filter((row) => row.incarnationId === target.incarnationId)
        : matches
      const launch =
        current.find((row) => row.process === 'created') ??
        (target.incarnationId ? null : current[0])
      if (matches.length) {
        const attachments = current
          .slice(0, launch ? current.indexOf(launch) : undefined)
          .filter(
            (row) =>
              row.process === 'attached' ||
              row.process === 'attachment-intent' ||
              row.intent === 'attach'
          )
          .toReversed()
        const previousCreations = target.incarnationId
          ? matches
              .filter(
                (row) => row.process === 'created' && row.incarnationId !== target.incarnationId
              )
              .toReversed()
          : []
        return {
          launch: launch ?? null,
          ...(attachments.length ? { attachments } : {}),
          ...(target.incarnationId && !launch ? { currentStartUnrecorded: true } : {}),
          ...(previousCreations.length ? { previousCreations } : {})
        }
      }
    }
    return { launch: null }
  } catch {
    return { launch: null }
  }
}
export async function findLaunchRecord(target: {
  ptyId?: string
  paneKey?: string
}): Promise<LaunchLedgerRow | null> {
  return (await findLaunchHistory(target)).launch
}

export async function setLaunchLedgerDirectory(
  value: string | null,
  limits?: { maxBytes: number }
): Promise<void> {
  await flushLaunchLedger()
  sink = null
  directory = value
  maxBytes =
    limits && Number.isSafeInteger(limits.maxBytes) && limits.maxBytes > 0
      ? Math.min(limits.maxBytes, LAUNCH_LEDGER_MAX_BYTES)
      : LAUNCH_LEDGER_MAX_BYTES
}
export async function _resetLaunchLedgerForTests(): Promise<void> {
  await setLaunchLedgerDirectory(null)
}
