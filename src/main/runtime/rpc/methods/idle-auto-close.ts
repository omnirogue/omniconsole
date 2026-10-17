// `idleAutoClose.*` — agent hibernation and the idle rules write each decision (a sleep, a wake,
// a shadow would-do, a workspace of shells slept, a discard) to the session action trail as actor
// `hibernation`, and read G1 for the panes they are about to act on the way `omni session list`
// reads them. Only the desktop window on this computer may call either.

import { z } from 'zod'
import {
  HIBERNATION_AUDIT_ACTIONS,
  IDLE_AUTO_CLOSE_RPC,
  IDLE_RULE,
  type HibernationAudit,
  type IdleKeepReading
} from '../../../../shared/idle-auto-close-settings'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import { sessionActionsLogFor } from '../../../session-manage/session-actions-log'
import {
  readIdleKeepReadings,
  runtimeIdleKeepReadingDeps
} from '../../../session-manage/session-idle-keep-reading'
import { defineMethod, type RpcMethod } from '../core'
import { assertOrganizationWindowCaller } from './session-organization'

export const IDLE_AUTO_CLOSE_MAX_RECORDS = 50
export const IDLE_AUTO_CLOSE_MAX_READING_TARGETS = 20

const RULE_IDS = Object.values(IDLE_RULE) as [string, ...string[]]

const Evidence = z
  .record(
    z.string().min(1).max(64),
    z.union([z.string().max(512), z.number(), z.boolean(), z.null()])
  )
  .refine((value) => Object.keys(value).length <= 40, 'Too many evidence fields.')

const HibernationRecord = z
  .object({
    action: z.enum(HIBERNATION_AUDIT_ACTIONS),
    target: z
      .object({
        paneKey: z.string().max(512).nullable().optional(),
        tabId: z.string().max(512).nullable().optional(),
        title: z.string().max(200).optional()
      })
      .strict(),
    summary: z.string().trim().min(1).max(500),
    audit: z
      .object({
        rule: z.enum(RULE_IDS),
        mode: z.enum(['shadow', 'on']),
        outcome: z.enum(['would', 'done', 'failed', 'kept']),
        evidence: Evidence
      })
      .strict()
  })
  .strict()

export const IdleAutoCloseRecordParams = z
  .object({ records: z.array(HibernationRecord).min(1).max(IDLE_AUTO_CLOSE_MAX_RECORDS) })
  .strict()

export const IdleAutoCloseKeepReadingsParams = z
  .object({
    targets: z
      .array(
        z
          .object({ worktreeId: z.string().min(1).max(1000), paneKey: z.string().min(1).max(512) })
          .strict()
      )
      .min(1)
      .max(IDLE_AUTO_CLOSE_MAX_READING_TARGETS)
  })
  .strict()

export const IDLE_AUTO_CLOSE_METHODS: RpcMethod[] = [
  defineMethod({
    name: IDLE_AUTO_CLOSE_RPC.record,
    params: IdleAutoCloseRecordParams,
    handler: async (params, context) => {
      assertOrganizationWindowCaller(context)
      const log = sessionActionsLogFor(getProfileUserDataPath())
      let auditError: string | undefined
      for (const record of params.records) {
        const error = await log.append({
          actor: 'hibernation',
          action: record.action,
          target: record.target,
          summary: record.summary,
          reason: record.audit.rule,
          hibernation: record.audit as HibernationAudit
        })
        auditError ??= error
      }
      return { written: params.records.length, ...(auditError ? { auditError } : {}) }
    }
  }),
  defineMethod({
    name: IDLE_AUTO_CLOSE_RPC.keepReadings,
    params: IdleAutoCloseKeepReadingsParams,
    handler: async (params, context): Promise<{ readings: IdleKeepReading[] }> => {
      assertOrganizationWindowCaller(context)
      return {
        readings: await readIdleKeepReadings(
          runtimeIdleKeepReadingDeps(context.runtime),
          params.targets
        )
      }
    }
  })
]
