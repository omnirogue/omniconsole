import { z } from 'zod'
import {
  parseSessionReference,
  rowsForSessionReference
} from '../../../../shared/session-reference'
import { readSidebarRows } from '../../../session-manage/session-manage-runtime-actions'
import { workBinder } from '../../../work-delivery/work-delivery-bind'
import { defineMethod, type RpcAnyMethod } from '../core'

const BindParams = z
  .object({
    jira: z.string().min(1).max(40),
    paneKey: z.string().min(1).max(200).optional(),
    ref: z.string().min(1).max(300).optional(),
    routine: z.string().min(1).max(200).optional(),
    prNumbers: z.array(z.number().int().positive()).max(20).optional(),
    source: z.string().min(1).max(60).optional()
  })
  .strict()

export const WORK_DELIVERY_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'work.bind',
    params: BindParams,
    handler: async (params, { runtime }) => {
      const bind = workBinder()
      if (!bind) {
        throw new Error(
          'Work delivery is not running on this computer (signed out of OmniOS, or turned off).'
        )
      }
      if (params.routine) {
        return bind({ jira: params.jira, routine: params.routine, source: params.source ?? 'cli' })
      }
      const rows = (await readSidebarRows(runtime)).filter(
        (row) => !row.folded && row.paneKey !== null
      )
      const reference = params.ref ? parseSessionReference(params.ref) : null
      if (params.ref && !reference) {
        throw new Error(`${params.ref} is not a session reference (<claude|codex>:<id>@<host>).`)
      }
      const matches = reference
        ? rowsForSessionReference(reference, rows)
        : rows.filter((row) => row.paneKey === params.paneKey)
      if (matches.length !== 1) {
        throw new Error(
          matches.length === 0
            ? 'No open session on this computer matches; open it first, or bind it from inside it.'
            : `${matches.length} sessions match; name one with --pane.`
        )
      }
      const row = matches[0]!
      return bind({
        jira: params.jira,
        source: params.source ?? 'cli',
        pane: { paneKey: row.paneKey!, worktreeId: row.worktreeId, title: row.title },
        ...(params.prNumbers ? { prNumbers: params.prNumbers } : {})
      })
    }
  })
]
