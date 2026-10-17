import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { WorkflowCheckpointStore, workflowEvidenceDigest } from './workflow-checkpoint-store'
import { projectLocalWorkflow } from './local-workflow-projection'
import { workflowRunResult } from '../../../shared/workflow-run-result'
import { discoverOmniosRun } from '../../../shared/discover-omnios-page'
import { discoverStats, type DiscoverStatsRun } from '../../../shared/workflow-discover-stats'

function json(file: string):
  | {
      ok?: boolean
      result?: { shareUrl?: string; operationId?: string; terminal?: { handle?: string } }
      started?: boolean
      executionId?: string
      state?: string
      findings?: { key: string; n: number }[]
    }
  | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function delivery(folder: string): DiscoverStatsRun['delivery'] {
  const published = json(join(folder, 'published.json'))
  if (
    published?.ok === true &&
    typeof published.result?.shareUrl === 'string' &&
    published.result.shareUrl.startsWith('https://')
  ) {
    return 'published'
  }
  const marker = json(join(folder, 'launch.json'))
  return marker?.state === 'failed' ? 'failed' : marker ? 'pending' : 'unknown'
}

/** Receipt-backed action labels never treat a launch as a completed fix or an adjudication. */
function actionLabel(
  db: Database.Database,
  folder: string,
  n: number
): DiscoverStatsRun['findings'][number]['label'] {
  for (const [prefix, pick] of [
    ['started', 'Start'],
    ['dug', 'Dig deeper']
  ] as const) {
    const receipt = json(join(folder, `${prefix}-${n}.json`))
    if (!receipt) {
      continue
    }
    if (receipt.ok === false || receipt.started === false) {
      return { pick, outcome: 'failed' }
    }
    if (pick === 'Start') {
      const launched =
        receipt.ok === true &&
        typeof receipt.result?.operationId === 'string' &&
        typeof receipt.result?.terminal?.handle === 'string'
      return { pick, outcome: launched ? 'launched' : 'unknown' }
    }
    if (receipt.started === true && typeof receipt.executionId === 'string') {
      const child = db
        .prepare('SELECT state FROM local_workflow_executions WHERE id=?')
        .get(receipt.executionId) as { state: string } | undefined
      return {
        pick,
        outcome:
          child?.state === 'completed'
            ? 'completed'
            : child?.state === 'failed' || child?.state === 'cancelled'
              ? 'failed'
              : 'launched'
      }
    }
    return { pick, outcome: 'unknown' }
  }
  return undefined
}

/** Replays frozen records read-only: no host construction, recovery, delivery, or paid calls. */
export function readDiscoverStats(
  db: Database.Database,
  root: string,
  request: { template?: string; since?: number },
  host: string
) {
  const store = new WorkflowCheckpointStore(db)
  const runs: DiscoverStatsRun[] = []
  let unreadable = 0
  const rows = db
    .prepare(`SELECT id,conversation_id,snapshot_json,snapshot_digest FROM local_workflow_executions
    WHERE CASE WHEN json_valid(snapshot_json) THEN json_extract(snapshot_json,'$.snapshot.graph.spec.template') END IN ('discover','quick-discover') OR NOT json_valid(snapshot_json)`)
    .all() as {
    id: string
    conversation_id: string
    snapshot_json: string
    snapshot_digest: string
  }[]
  for (const row of rows) {
    try {
      if (workflowEvidenceDigest(row.snapshot_json) !== row.snapshot_digest) {
        throw new Error('Snapshot digest mismatch')
      }
      const snapshot = JSON.parse(row.snapshot_json).snapshot as LocalWorkflowHostSnapshot
      const template = snapshot.graph!.spec.template!
      if (
        (request.template && request.template !== template) ||
        (request.since !== undefined && snapshot.host.startedAt < request.since)
      ) {
        continue
      }
      const view = projectLocalWorkflow({
        db,
        store,
        executionId: row.id,
        active: false,
        receipts: new Map()
      })
      const [worktreeId, conversationId] = JSON.parse(row.conversation_id) as [string, string]
      const result = workflowRunResult(
        view,
        { executionId: row.id, worktreeId, conversationId },
        template,
        0
      )
      const final = result.results.targets
      const folder = join(root, row.id)
      const page =
        json(join(folder, 'findings.json')) ??
        discoverOmniosRun(result, { goal: view.prompt, workspace: '' })
      const numbers = new Map<string, number>(
        (page.findings ?? []).map((item: { key: string; n: number }) => [item.key, item.n])
      )
      const find = view.graphRun?.steps.find(
        (step) => step.id === snapshot.graph?.spec.repeat?.do || step.id === 'find'
      )
      const rounds =
        find?.rounds
          .filter((round) => round.items !== undefined)
          .map((round) => ({
            round: round.round,
            newFindings: round.items?.length ?? 0,
            confirmed: final.filter(
              (target) => target.round === round.round && target.tally === 'confirmed'
            ).length
          })) ?? []
      const calls = result.calls.map((call) => {
        const planned = call.id.split('~')[0]!
        const agent = Number(/\/a(\d+)$/.exec(planned)?.[1] ?? -1)
        const step = snapshot.graph!.spec.steps.find((entry) => entry.id === call.stage)
        return {
          id: call.id,
          step: call.stage,
          round: Number(/\/r(\d+)\//.exec(planned)?.[1] ?? 0),
          model: call.model,
          lens: step?.agents[agent]?.angle ?? 'unknown',
          costUsd: call.costUsd,
          ...(call.costPartial ? { costPartial: true } : {})
        }
      })
      runs.push({
        host,
        runId: row.id,
        template,
        goal: snapshot.task.prompt,
        workspace: snapshot.host.workspaceId,
        at: snapshot.host.startedAt,
        state: view.state,
        degraded: !!result.degraded,
        substitutions: result.calls.filter((call) => call.id.includes('~')).length,
        delivery: snapshot.host.isolated ? 'isolated' : delivery(folder),
        rounds,
        calls,
        findings: final.map((target) => ({
          key: target.key,
          round: target.round,
          tally: target.tally,
          title: target.title,
          detail: target.detail,
          location: target.location,
          ...(target.sourceCallId ? { sourceCallId: target.sourceCallId } : {}),
          ...(target.alsoFrom ? { alsoFrom: target.alsoFrom } : {}),
          ...(numbers.has(target.key)
            ? { label: actionLabel(db, folder, numbers.get(target.key)!) }
            : {})
        }))
      })
    } catch {
      unreadable++
    }
  }
  return discoverStats({ version: 1, runs, unreadable })
}
