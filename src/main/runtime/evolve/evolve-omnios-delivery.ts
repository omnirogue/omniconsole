import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import type { ArtifactReviewOption } from '../../../shared/artifact-review'
import type {
  ArtifactCloudOperation,
  ArtifactPublishResult,
  ArtifactWriteRequest
} from '../../../shared/artifacts'
import { evolveWinnerMetrics } from '../../../shared/evolve-decision-metrics'
import type { EvolveRunRecord } from '../../../shared/evolve-workflow'
import type Database from '../../sqlite/sync-database'
import { discoverOmniosEnabled } from '../workflow-script/discover-omnios-delivery'
import {
  buildOutboxIdempotencyKey,
  discoverOutbox,
  discoverPublishedUrl,
  type EvolveOutboxDecisionRecord
} from '../workflow-script/discover-omnios-outbox'
import {
  evolveDecisionChoices,
  recommendedEvolveChoice,
  renderEvolveDecisionHtml
} from './evolve-decision-page'
import { pushEvolveEvent } from './evolve-run-progress'
import type { EvolveRunStore } from './evolve-run-store'

export type EvolveRunWithDecision = EvolveRunRecord & {
  decision?: EvolveOutboxDecisionRecord
}

/** `OrcaRuntimeService.publishArtifact`: the signed-in publisher, idempotent per source key. */
export type EvolveDecisionPublisher = (
  request: ArtifactWriteRequest
) => Promise<ArtifactCloudOperation<ArtifactPublishResult>>

export type EvolveOmniosDeliveryDeps = {
  db: Database.Database
  store: EvolveRunStore
  root?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  notify?: (record: EvolveRunRecord) => void
  log?: (line: string) => void
  /** Without one the decision is written locally and stays pending. */
  publish?: EvolveDecisionPublisher
}

/** A refused publish waits this long before reconciliation tries it again. */
export const EVOLVE_DECISION_RETRY_MS = 600_000
const publishing = new Set<string>()
const ANSWER_NOTE = 'The answer is recorded here; nothing is promoted automatically.'

export function defaultDiscoverOmniosRoot(): string {
  return join(getAppEnvironment().getPath('userData'), 'discover-omnios')
}

export function attachEvolveDecision(
  db: Database.Database,
  record: EvolveRunRecord
): EvolveRunWithDecision {
  const existing = discoverOutbox(db).readDecision(record.id)
  if (existing) {
    return { ...record, decision: existing }
  }
  const metrics = evolveWinnerMetrics(record)
  if (!metrics) {
    return record
  }
  const idempotencyKey = buildOutboxIdempotencyKey(record.id, metrics.winnerDigest, 'evolve')
  const synthetic: EvolveOutboxDecisionRecord = {
    runId: record.id,
    kind: 'evolve',
    idempotencyKey,
    decisionId: `dec_${record.id}_${metrics.winnerDigest.slice(0, 8)}`,
    state: 'pending',
    ...metrics,
    updatedAt: record.updatedAt
  }
  return { ...record, decision: synthetic }
}

function reviewOptions(decision: EvolveOutboxDecisionRecord): ArtifactReviewOption[] {
  const recommended = recommendedEvolveChoice({
    blindAuditPassed: decision.blindAuditPassed ?? null
  })
  return evolveDecisionChoices(decision).map((choice) => ({
    label: choice.label,
    detail: choice.detail,
    ...(choice.value === recommended ? { recommended: true as const } : {})
  }))
}

/** Publishes the page as an OmniOS review; a refusal is recorded `failed` and tried again later. */
async function publishEvolveDecision(
  deps: EvolveOmniosDeliveryDeps,
  record: EvolveRunRecord,
  decision: EvolveOutboxDecisionRecord,
  html: string,
  dir: string
): Promise<EvolveOutboxDecisionRecord> {
  if (!deps.publish) {
    return decision
  }
  const outbox = discoverOutbox(deps.db)
  try {
    const result = await deps.publish({
      sourceKey: JSON.stringify(['evolve-decision', record.id, decision.winnerDigest]),
      content: html,
      contentType: 'text/html',
      fileName: 'evolve-decision.html',
      title: `Evolve decision: ${record.request.target}`,
      audience: 'team',
      review: {
        question: `Promote winning version ${decision.winnerCandidateId}?`.slice(0, 500),
        summary: [decision.summaryLine, ANSWER_NOTE].filter(Boolean).join(' ').slice(0, 1200),
        options: reviewOptions(decision)
      }
    })
    if (result.status !== 'ok') {
      throw new Error(
        result.status === 'unconfigured'
          ? result.message
          : 'OmniOS needs you to sign in again before it can publish this decision.'
      )
    }
    const url = result.value.item.shareUrl
    // The receipt discoverPublishedUrl reads, so a restart never publishes a second page.
    await writeFile(
      join(dir, 'published.json'),
      `${JSON.stringify({ ok: true, result: { shareUrl: url } }, null, 2)}\n`,
      'utf8'
    )
    outbox.published(record.id, url)
    return { ...decision, state: 'published', url, error: null }
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    outbox.defer(record.id, (deps.now?.() ?? Date.now()) + EVOLVE_DECISION_RETRY_MS)
    return { ...decision, state: 'failed', error: message }
  }
}

function deliveryEvent(decision: EvolveOutboxDecisionRecord): string {
  if (decision.state === 'published') {
    return `Decision ${decision.decisionId} published to OmniOS Decisions: ${decision.url}`
  }
  if (decision.state === 'failed') {
    return `Decision ${decision.decisionId} could not be published to OmniOS Decisions (${decision.error ?? 'no reason given'}); it is tried again later.`
  }
  return `Decision ${decision.decisionId} is written on this computer and not yet in OmniOS Decisions.`
}

/**
 * Writes the summary-first Evolve decision page and publishes it as an OmniOS review,
 * idempotently on (runId, winnerDigest, 'evolve'). A pending or failed entry is published again.
 */
export async function scheduleEvolveToOmnios(
  deps: EvolveOmniosDeliveryDeps,
  record: EvolveRunRecord
): Promise<EvolveOutboxDecisionRecord | null> {
  if (!discoverOmniosEnabled(deps.env)) {
    return null
  }
  const metrics = evolveWinnerMetrics(record)
  if (!metrics) {
    return null
  }
  const root = deps.root ?? defaultDiscoverOmniosRoot()
  const outbox = discoverOutbox(deps.db)
  const idempotencyKey = buildOutboxIdempotencyKey(record.id, metrics.winnerDigest, 'evolve')
  const existing = outbox.readDecision(record.id)
  const current = existing?.idempotencyKey === idempotencyKey ? existing : null
  const publishedUrl = current
    ? (discoverPublishedUrl(root, record.id) ?? current.url ?? null)
    : null
  const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString()

  if (current && (publishedUrl || (current.state !== 'pending' && current.state !== 'failed'))) {
    if (publishedUrl && current.url !== publishedUrl) {
      const updated: EvolveOutboxDecisionRecord = {
        ...current,
        url: publishedUrl,
        state: current.resolution ? current.state : 'published',
        updatedAt: nowIso
      }
      outbox.published(record.id, publishedUrl)
      outbox.writeDecision(record.id, updated)
      return updated
    }
    return current
  }
  if (publishing.has(record.id)) {
    return current
  }
  publishing.add(record.id)
  try {
    const prepared: EvolveOutboxDecisionRecord = {
      runId: record.id,
      kind: 'evolve',
      idempotencyKey,
      decisionId: current?.decisionId ?? `dec_${record.id}_${metrics.winnerDigest.slice(0, 8)}`,
      state: 'pending',
      resolution: current?.resolution ?? null,
      resolvedAt: current?.resolvedAt ?? null,
      url: null,
      ...metrics,
      updatedAt: nowIso
    }
    outbox.enqueue(record.id, {
      kind: 'evolve',
      winnerDigest: metrics.winnerDigest,
      decision: prepared
    })
    outbox.writeDecision(record.id, prepared)

    const dir = join(root, record.id)
    await mkdir(dir, { recursive: true })
    const html = renderEvolveDecisionHtml(record, prepared)
    await writeFile(join(dir, 'page.html'), html, 'utf8')
    const decision = await publishEvolveDecision(deps, record, prepared, html, dir)
    outbox.writeDecision(record.id, decision)
    await writeFile(join(dir, 'decision.json'), `${JSON.stringify(decision, null, 2)}\n`, 'utf8')

    const withDecision: EvolveRunWithDecision = { ...record, decision }
    if (current?.state !== decision.state) {
      pushEvolveEvent(withDecision, deliveryEvent(decision), nowIso)
    }
    deps.store.save(withDecision)
    deps.notify?.(withDecision)
    deps.log?.(
      `Evolve ${record.id}: decision ${decision.decisionId} ${decision.state} (${idempotencyKey})`
    )
    return decision
  } finally {
    publishing.delete(record.id)
  }
}
