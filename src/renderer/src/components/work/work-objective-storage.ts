import { z } from 'zod'
import {
  SESSION_PREP_MAX_ITEMS,
  SESSION_PREP_MAX_REQUEST_CHARS,
  SESSION_PREP_PARAMS
} from '../../../../shared/session-prep-types'
import {
  readNativeChatComposerStorage,
  writeNativeChatComposerStorage
} from '../native-chat/native-chat-composer-storage'
import type { WorkObjectives } from './work-objective-state'

const kind = 'need-speed'
const rowSchema = z
  .object({
    id: z.string().min(1).max(128),
    text: z.string().max(SESSION_PREP_MAX_REQUEST_CHARS),
    request: SESSION_PREP_PARAMS.request.optional(),
    batchId: z.string().min(1).max(128).optional(),
    error: z.string().optional()
  })
  .refine(
    (row) =>
      (!row.batchId || Boolean(row.request)) &&
      (!row.request ||
        (row.request.requestId === row.id &&
          row.request.text === row.text.trim() &&
          row.request.source.entryPoint === 'need-speed'))
  )
const schema = z.object({
  version: z.literal(1),
  rows: z.array(rowSchema).min(1).max(SESSION_PREP_MAX_ITEMS),
  sending: z.boolean()
})

/** The scope includes profile, project and source workspace; no recovery dispatch runs here. */
export function readWorkObjectiveStorage(scope: string): WorkObjectives | undefined {
  const stored = readNativeChatComposerStorage<unknown>(kind, scope)
  if (stored === undefined) {
    return undefined
  }
  const result = schema.safeParse(stored)
  if (!result.success) {
    throw new Error('Invalid saved prompts')
  }
  // An interrupted renderer cannot still own an in-flight request.
  return { rows: result.data.rows, sending: false }
}

export function writeWorkObjectiveStorage(scope: string, value: WorkObjectives): void {
  if (typeof localStorage === 'undefined') {
    throw new Error('Prompt storage unavailable')
  }
  writeNativeChatComposerStorage(kind, scope, {
    version: 1,
    rows: value.rows,
    sending: value.sending
  })
}
