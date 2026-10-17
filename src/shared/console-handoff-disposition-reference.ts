import { z } from 'zod'
import { artifactReviewReference, type HandoffArtifactReview } from './handoff-artifact-review'

export const handoffDisposition = z.enum(['ownership-transfer', 'feedback'])
export type HandoffDisposition = z.infer<typeof handoffDisposition>

/**
 * One entry of the hub's `references` list (`validate_entry`): a bare string, or a pointer
 * whose only keys are `kind`, `ref` and `label`, all strings. Anything else is refused by
 * the console relay before it reaches the hub.
 */
export const handoffReference = z.union([
  z.string().min(1).max(512),
  z.object({ kind: z.string().optional(), ref: z.string(), label: z.string().optional() }).strict()
])
export type HandoffReference = z.infer<typeof handoffReference>

const DISPOSITION_KIND = 'disposition'
const dispositionPointer = z.object({ kind: z.literal(DISPOSITION_KIND), ref: handoffDisposition })

/** The hub has no disposition field; it rides as a pointer on the opening entry's references. */
export function handoffDispositionReferences(disposition: HandoffDisposition): HandoffReference[] {
  return [{ kind: DISPOSITION_KIND, ref: disposition }]
}

const SUMMARY_FILE_KIND = 'summary-file'
const TRANSCRIPT_FILE_KIND = 'transcript-file'
// Why: a thread without the pointers is still read by its generated names, id-based or readable.
const GENERATED_SUMMARY_NAME =
  /^(session-[0-9a-f-]{36}|Summary - (.* - )?\d{4}-\d\d-\d\d \d{6})\.md$/i
const GENERATED_TRANSCRIPT_NAME =
  /^(transcript-.+-[0-9a-f]{16}|Conversation transcript - (.* - )?\d{4}-\d\d-\d\d \d{6})\.md$/i
const fileName = z.string().min(1).max(255)

/** What the opening entry says about its own package, so the reader need not guess from names. */
export type HandoffPackageParts = {
  disposition?: HandoffDisposition
  /** The generated summary among the files, by name. */
  summaryFile?: string
  /** The generated session transcript among the files, by name. */
  transcriptFile?: string
  /** The omnios page the recipient decides on (`handoff-artifact-review.ts`). */
  artifactReview?: HandoffArtifactReview
}

export function handoffPackageReferences(parts: HandoffPackageParts): HandoffReference[] {
  return [
    ...(parts.disposition ? handoffDispositionReferences(parts.disposition) : []),
    ...(parts.summaryFile ? [{ kind: SUMMARY_FILE_KIND, ref: parts.summaryFile }] : []),
    ...(parts.transcriptFile ? [{ kind: TRANSCRIPT_FILE_KIND, ref: parts.transcriptFile }] : []),
    ...(parts.artifactReview ? [artifactReviewReference(parts.artifactReview)] : [])
  ]
}

function referencedFile(
  entries: readonly { references?: readonly unknown[] | null }[],
  kind: string
): string | null {
  const pointer = z.object({ kind: z.literal(kind), ref: fileName })
  for (const entry of entries) {
    for (const reference of entry.references ?? []) {
      const parsed = pointer.safeParse(reference)
      if (parsed.success) {
        return parsed.data.ref
      }
    }
  }
  return null
}

/**
 * A thread's files as the person reads them: the generated summary, the generated transcript, and
 * the work itself. A thread sent before the pointers existed is read by its generated file names.
 */
export function handoffPackageOf<File extends { name: string; current: boolean }>(detail: {
  entries: readonly { references?: readonly unknown[] | null }[]
  files: readonly File[]
}): {
  disposition: HandoffDisposition | null
  summary: File | null
  transcript: File | null
  work: File[]
} {
  const current = detail.files.filter((file) => file.current)
  const summaryName = referencedFile(detail.entries, SUMMARY_FILE_KIND)
  const transcriptName = referencedFile(detail.entries, TRANSCRIPT_FILE_KIND)
  const summary =
    current.find((file) => file.name === summaryName) ??
    (summaryName ? null : (current.find((file) => GENERATED_SUMMARY_NAME.test(file.name)) ?? null))
  const transcript =
    current.find((file) => file.name === transcriptName) ??
    (transcriptName
      ? null
      : (current.find((file) => GENERATED_TRANSCRIPT_NAME.test(file.name)) ?? null))
  return {
    disposition: handoffDispositionOf(detail.entries),
    summary,
    transcript,
    work: current.filter((file) => file !== summary && file !== transcript)
  }
}

/** The disposition a thread was opened with, read back from the references the hub stored. */
export function handoffDispositionOf(
  entries: readonly { references?: readonly unknown[] | null }[]
): HandoffDisposition | null {
  for (const entry of entries) {
    for (const reference of entry.references ?? []) {
      const pointer = dispositionPointer.safeParse(reference)
      if (pointer.success) {
        return pointer.data.ref
      }
    }
  }
  return null
}
