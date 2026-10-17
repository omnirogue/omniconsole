import { z } from 'zod'

/**
 * What each handoff write must look like to be accepted, transcribed from the two services that
 * refuse it — never from the IDE's own zod, which is the thing under test:
 *  - the console relay door: `omnirogue/omni-console` `bff/omni_bff/card_writes.py` RULES
 *    (`validate_body`, `_references_verdict`, `_attachments_verdict`) at `eea4e456`
 *  - the hub: `omnirogue/omniconsole` `omniagentos/api/routes/handoffs.py` request models
 *    (all `extra="forbid", strict=True`) and `collab/handoffs.py::validate_entry` at `06cce1f732`
 * Each shape is the stricter of the two, because a body has to pass both.
 */
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length
const text = (max: number) =>
  z
    .string()
    .min(1)
    .refine((value) => utf8Bytes(value) <= max)
const ACTIONS = ['review', 'approve', 'decide', 'edit', 'fyi'] as const
// Author re-asks use status: admitted by both relay HANDOFF_ENTRY_KINDS and hub EntryBody.
const ENTRY_KINDS = ['handoff', 'status', 'reply', 'done'] as const
const COMMUNICATION_TYPES = ['decision', 'request', 'question', 'plan', 'information'] as const
const employeeId = z.string().regex(/^emp_[a-z0-9_-]+$/)
const cardKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const cardlessKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
const dueAt = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$/)
// Why: the door's grouped pattern overflows V8's regex stack on a 7 MB string; this is the same rule.
const base64 = z
  .string()
  .min(1)
  .refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value))
const fileName = z
  .string()
  // eslint-disable-next-line no-control-regex -- the door's own filename rule names control bytes
  .regex(/^[^\x00-\x1f\x7f]{1,255}$/)
  .refine((value) => {
    const stored = storedBasename(value)
    return stored !== '' && !stored.startsWith('.') && stored !== '_instructions.md'
  })

function storedBasename(value: string): string {
  return value.replace(/\\/g, '/').split('/').at(-1)!.trim()
}

/** `validate_entry`: a bare string, or a pointer of strings keyed only by kind, ref and label. */
const reference = z.union([
  text(512),
  z.object({ kind: z.string().optional(), ref: z.string(), label: z.string().optional() }).strict()
])
const references = z
  .array(reference)
  .max(16)
  .refine((value) => utf8Bytes(JSON.stringify(value)) <= 4096)
const files = z.array(z.string().min(1).max(1024)).max(25)
const fileVersions = z
  .array(
    z
      .object({
        path: z.string().trim().min(1).max(1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict()
  )
  .max(25)
const attachments = z
  .array(z.object({ filename: fileName, content_base64: base64 }).strict())
  .max(32)
  .refine((value) => {
    const stored = value.map((file) => storedBasename(file.filename))
    return new Set(stored).size === stored.length
  }, 'an attachment name is repeated')
const opening = {
  recipient_employee_id: employeeId,
  title: text(160),
  kind: z.enum(ENTRY_KINDS).optional(),
  body: text(8192),
  action: z.enum(ACTIONS).optional(),
  communication_type: z.enum(COMMUNICATION_TYPES).optional(),
  due_at: dueAt.optional(),
  references: references.optional()
}

export const hubHandoffRequestShapes = {
  /** `POST /api/team/tasks/{task_id}/handoffs` — relay rule `task-handoff`, hub `ThreadBody`. */
  send: z
    .object({
      ...opening,
      files: files.optional(),
      file_versions: fileVersions.optional(),
      idempotency_key: cardKey
    })
    .strict(),
  /** `POST /api/handoffs` — relay rule `handoff-create`, hub `CardlessThreadBody`. */
  sendCardless: z
    .object({
      ...opening,
      attachments: attachments.optional(),
      origin_session_id: z.string().max(128).optional(),
      idempotency_key: cardlessKey
    })
    .strict(),
  /** `POST /api/handoffs/{id}/forward` — relay rule `handoff-forward`, hub `ForwardBody`. */
  forward: z
    .object({
      to: z.string().min(1).max(200),
      action: z.enum(ACTIONS),
      communication_type: z.enum(COMMUNICATION_TYPES).optional(),
      note: text(8192),
      files: files.optional(),
      file_versions: fileVersions.optional(),
      due_at: dueAt.optional(),
      idempotency_key: cardKey.optional()
    })
    .strict(),
  /** `POST /api/handoffs/{id}/entries` — relay rule `handoff-entry`, hub `EntryBody`. */
  respond: z
    .object({
      kind: z.enum(ENTRY_KINDS),
      body: text(8192),
      references: references.optional(),
      idempotency_key: cardKey
    })
    .strict(),
  /** `POST /api/handoffs/{id}/review` — relay rule `handoff-review`, hub `ReviewBody`. */
  review: z
    .object({
      decision: z.enum(['approve', 'request_changes']),
      version_ids: z
        .array(z.string().regex(/^[A-Za-z0-9_-]{4,128}$/))
        .max(25)
        .refine((value) => new Set(value).size === value.length),
      note: text(8192),
      idempotency_key: cardKey
    })
    .strict(),
  /** `POST /api/handoffs/{id}/files/upload` — relay rule `handoff-file-upload`, hub `UploadFileBody`. */
  uploadThreadFile: z
    .object({
      filename: fileName,
      content_base64: base64.max(34_952_536),
      note: text(8192),
      idempotency_key: cardlessKey,
      author_session_id: z.string().max(128).optional()
    })
    .strict(),
  /** `POST /api/handoffs/{id}/files/return` — relay rule `handoff-return`, hub `ReturnFileBody`. */
  returnFile: z
    .object({
      filename: z.string().min(1).max(255),
      content_base64: z.string().min(1).max(14_000_000),
      base_version_id: z.string().min(1).max(128),
      note: text(8192),
      idempotency_key: cardKey
    })
    .strict(),
  /** `POST /api/handoffs/{id}/bind` — relay rule `handoff-bind`, hub `BindBody`. */
  bindThread: z.object({ board_task_id: z.string().regex(/^btk_[A-Za-z0-9]{4,64}$/) }).strict()
} as const

export type HubHandoffVerb = keyof typeof hubHandoffRequestShapes

const THREAD_VERBS: Record<string, HubHandoffVerb | undefined> = {
  forward: 'forward',
  entries: 'respond',
  review: 'review',
  'files/upload': 'uploadThreadFile',
  'files/return': 'returnFile',
  bind: 'bindThread'
}

/** Which shape a relayed request must satisfy, by the hub path it names. */
export function hubHandoffVerbForPath(path: string): HubHandoffVerb | null {
  const hubPath = path.replace(/^.*\/api\/gtd\/hub\/api/, '').replace(/\?.*$/, '')
  if (/^\/team\/tasks\/[^/]+\/handoffs$/.test(hubPath)) {
    return 'send'
  }
  if (hubPath === '/handoffs') {
    return 'sendCardless'
  }
  const segment = /^\/handoffs\/[^/]+\/(.+)$/.exec(hubPath)?.[1]
  return (segment && THREAD_VERBS[segment]) || null
}
