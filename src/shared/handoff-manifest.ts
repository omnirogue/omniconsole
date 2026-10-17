import { z } from 'zod'
import { handoffDigest } from './console-handoff-contract'

/**
 * The work package's index, sent as the first file of every handoff that carries files:
 * which files travelled by which route, where they came from relative to the repo root or
 * the session folder, their exact bytes (sha256 + size), the pushed branch and sha, and the
 * trail pointer. The receiver materializes files into the same relative folders from it.
 */
export const HANDOFF_MANIFEST_NAME = 'handoff-manifest.json'
export const HANDOFF_MANIFEST_VERSION = 1
/** The memo travels in the thread body; this is the budget the objective fixed. */
export const HANDOFF_MEMO_MAX_BYTES = 4096

const rel = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isSafeRelativePath(value), 'relative path must stay inside the folder')

export const handoffManifestFile = z
  .object({
    /** Path relative to the repo root (git) or to the session workspace (pin, card). */
    rel,
    name: z.string().min(1).max(255),
    route: z.enum(['git', 'pin', 'card']),
    sha256: handoffDigest,
    size: z.number().int().nonnegative(),
    /** Card workspace path the upload returned (pin, card routes). */
    taskPath: z.string().min(1).max(4096).optional(),
    /** Delivery receipt id when the card route delivered it (dlv_…). */
    deliveryId: z.string().min(1).max(128).optional()
  })
  .strict()

export const handoffManifest = z
  .object({
    version: z.literal(HANDOFF_MANIFEST_VERSION),
    createdAt: z.string().datetime({ offset: true }),
    source: z
      .object({
        sessionLabel: z.string().max(500),
        chainId: z.string().max(128).optional(),
        stepId: z.string().max(128).optional(),
        hostLabel: z.string().max(200).optional(),
        /** Absolute workspace path on the sender's computer; informational only. */
        workspacePath: z.string().max(4096).optional()
      })
      .strict(),
    git: z
      .object({
        /** GitHub `owner/repo` slug or the origin URL. */
        repo: z.string().min(1).max(2048),
        branch: z.string().min(1).max(1024),
        sha: z.string().regex(/^[a-f0-9]{7,64}$/),
        /** Branch the handoff branch was cut from, when known. */
        baseBranch: z.string().max(1024).optional()
      })
      .strict()
      .optional(),
    trail: z
      .object({
        ledgerId: z.string().max(128).optional(),
        ledgerUrl: z.string().url().max(2048).optional(),
        requestThreadId: z.string().max(128).optional()
      })
      .strict()
      .optional(),
    memo: z.string().max(HANDOFF_MEMO_MAX_BYTES),
    files: z.array(handoffManifestFile).max(64)
  })
  .strict()

export type HandoffManifestFile = z.infer<typeof handoffManifestFile>
export type HandoffManifest = z.infer<typeof handoffManifest>

/** No absolute paths, no drive letters, no `..`, no empty segments, no NUL. */
export function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes('\0') || /^[A-Za-z]:/.test(value)) {
    return false
  }
  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('/')) {
    return false
  }
  return normalized
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** Cut a memo to the byte budget on a character boundary, marking the cut. */
export function clampHandoffMemo(memo: string, maxBytes = HANDOFF_MEMO_MAX_BYTES): string {
  const encoder = new TextEncoder()
  if (encoder.encode(memo).length <= maxBytes) {
    return memo
  }
  const marker = '\n…'
  const budget = maxBytes - encoder.encode(marker).length
  let cut = memo
  while (cut.length > 0 && encoder.encode(cut).length > budget) {
    cut = cut.slice(0, Math.max(0, cut.length - Math.ceil(cut.length * 0.05) - 1))
  }
  return `${cut}${marker}`
}

export function buildHandoffManifest(input: {
  createdAt: Date
  source: HandoffManifest['source']
  git?: HandoffManifest['git']
  trail?: HandoffManifest['trail']
  memo: string
  files: HandoffManifestFile[]
}): HandoffManifest {
  const manifest = {
    version: HANDOFF_MANIFEST_VERSION as 1,
    createdAt: input.createdAt.toISOString(),
    source: input.source,
    ...(input.git ? { git: input.git } : {}),
    ...(input.trail ? { trail: input.trail } : {}),
    memo: clampHandoffMemo(input.memo),
    files: input.files
  }
  return handoffManifest.parse(manifest)
}

/** Stable, human-readable JSON: keys in declaration order, two-space indent, trailing newline. */
export function serializeHandoffManifest(manifest: HandoffManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export function parseHandoffManifest(text: string): HandoffManifest | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = handoffManifest.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The lines a memo carries so a person or a machine can find the work without the manifest. */
export function handoffMemoLines(
  manifest: Pick<HandoffManifest, 'git' | 'trail' | 'files'>
): string[] {
  const lines: string[] = []
  if (manifest.git) {
    lines.push(
      `Branch: ${manifest.git.branch} @ ${manifest.git.sha.slice(0, 12)} (${manifest.git.repo})`
    )
  }
  if (manifest.trail?.ledgerUrl) {
    lines.push(`Trail: ${manifest.trail.ledgerUrl}`)
  }
  const counts = { git: 0, pin: 0, card: 0 }
  for (const file of manifest.files) {
    counts[file.route] += 1
  }
  const parts = [
    counts.git ? `${counts.git} by git` : null,
    counts.pin ? `${counts.pin} on the thread` : null,
    counts.card ? `${counts.card} on the card` : null
  ].filter((part): part is string => part !== null)
  if (parts.length > 0) {
    lines.push(`Files: ${parts.join(', ')} (see ${HANDOFF_MANIFEST_NAME})`)
  }
  return lines
}
