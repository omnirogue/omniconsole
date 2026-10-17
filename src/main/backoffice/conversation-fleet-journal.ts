import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import {
  assertConversationFleetProgress,
  conversationFleetReceipt,
  type ConversationFleetReceipt
} from '../../shared/conversation-fleet-receipt'
import type { ConsoleConversationFleetAdmitRequest } from '../../shared/console-conversation-fleet-types'
import type {
  ConsoleWorkflowAdmission,
  ConsoleWorkflowProgress
} from '../../shared/console-workflow-types'

const entry = z.object({
  receipt: conversationFleetReceipt,
  attempted: z.boolean(),
  settled: z.boolean(),
  admissionReceipt: z.unknown().optional(),
  replayAuthorized: z.boolean().default(false)
})
const journal = z.array(entry)
type Entry = z.infer<typeof entry>

/** This journal owns admission intent only; execution and source processes remain on their hosts. */
export class ConversationFleetJournal {
  constructor(private readonly path: string) {}

  private read(): Entry[] {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
    return journal.parse(JSON.parse(raw))
  }

  private write(rows: Entry[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileDurableSync(durableWriteTempPath(this.path), this.path, JSON.stringify(rows))
  }

  list(): Entry['receipt'][] {
    return this.read().map((row) => row.receipt)
  }

  unattempted(): NonNullable<ConversationFleetReceipt['intent']>['request'][] {
    return this.read().flatMap((row) =>
      !row.attempted && row.receipt.intent ? [row.receipt.intent.request] : []
    )
  }

  pendingRequests(): NonNullable<ConversationFleetReceipt['intent']>['request'][] {
    return this.read().flatMap((row) =>
      row.receipt.admission === 'pending' &&
      row.receipt.intent &&
      (row.replayAuthorized || !row.attempted)
        ? [row.receipt.intent.request]
        : []
    )
  }

  unresolved(): Entry['receipt'][] {
    return this.read()
      .filter((row) => !row.settled)
      .map((row) => row.receipt)
  }

  importLegacy(values: ConversationFleetReceipt[]): void {
    const rows = this.read()
    for (const value of values) {
      const receipt = conversationFleetReceipt.parse({ ...value, intent: undefined })
      if (!rows.some((row) => row.receipt.workflowId === receipt.workflowId)) {
        rows.push({ receipt, attempted: true, settled: false, replayAuthorized: false })
      }
    }
    this.write(rows)
  }

  begin(value: ConversationFleetReceipt): boolean {
    const receipt = conversationFleetReceipt.parse({ ...value, admission: 'pending' })
    const intent = receipt.intent
    if (
      !intent ||
      receipt.workflowId !== intent.request.graph.dispatch_id ||
      receipt.digest !== intent.request.digest ||
      receipt.taskId !== intent.request.taskId
    ) {
      throw new Error('The durable intent does not match the reviewed workflow.')
    }
    const rows = this.read()
    if (
      rows.some(
        (row) =>
          row.receipt.workflowId === receipt.workflowId ||
          row.receipt.intent?.operationId === intent.operationId ||
          (!row.settled &&
            (row.receipt.taskId === receipt.taskId || row.receipt.rowKey === receipt.rowKey))
      )
    ) {
      return false
    }
    rows.push({ receipt, attempted: false, settled: false, replayAuthorized: true })
    this.write(rows)
    return true
  }

  claim(request: ConsoleConversationFleetAdmitRequest): 'send' | 'reconcile' {
    const rows = this.read()
    const row = rows.find((candidate) => candidate.receipt.workflowId === request.graph.dispatch_id)
    if (!row?.receipt.intent || !isDeepStrictEqual(row.receipt.intent.request, request)) {
      throw new Error('Commit this exact dispatch intent before admission.')
    }
    if (row.attempted) {
      if (!row.replayAuthorized) {
        throw new Error('This legacy receipt has no durable main-process replay authority.')
      }
      return 'reconcile'
    }
    row.attempted = true
    row.replayAuthorized = true
    this.write(rows)
    return 'send'
  }

  observe(progress: ConsoleWorkflowProgress, admission?: ConsoleWorkflowAdmission): void {
    const rows = this.read()
    const row = rows.find((candidate) => candidate.receipt.workflowId === progress.workflow_id)
    if (!row) {
      return
    }
    assertConversationFleetProgress(row.receipt, progress)
    const nodes = row.receipt.intent?.request.graph.nodes
    if (
      nodes &&
      (nodes.length !== progress.jobs.length ||
        nodes.some((node) => !progress.jobs.some((job) => job.policy.workflow.key === node.key)))
    ) {
      throw new Error('The server has not returned the complete reviewed workflow.')
    }
    row.receipt.admission = 'accepted'
    row.attempted = true
    row.settled = progress.jobs.every(
      (job) => !job.can_decide && ['done', 'completed', 'merged', 'skipped'].includes(job.status)
    )
    if (admission) {
      row.admissionReceipt = admission.receipt
    }
    this.write(rows)
  }
}
