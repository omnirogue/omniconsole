import { z } from 'zod'
import { handoffDigest } from './console-handoff-contract'
import type { handoffManifestFile } from './handoff-manifest'

/**
 * What the main process is asked to do before a handoff is sent, and what it answers with.
 *
 * The renderer knows which files the run produced; only the main process can ask git whether a
 * file is inside the repository and not ignored, make the WIP commit, and write the manifest. So
 * the renderer hands over the captured pins and gets back the pins that still travel as bytes,
 * the commit that carries the rest, and the lines the memo should say.
 */
export const handoffRoutePin = z
  .object({
    /** Absolute path on the execution host; null for the generated session summary. */
    sourcePath: z.string().min(1).max(4096).nullable(),
    name: z.string().min(1).max(255),
    sha256: handoffDigest,
    size: z.number().int().nonnegative()
  })
  .strict()

export const handoffRoutePreparationRequest = z
  .object({
    workspacePath: z.string().min(1).max(4096),
    /** Where the WIP commit goes; one branch per chain or session. */
    branch: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !value.startsWith('-')),
    /** Names the folder the manifest is written into, and the commit message. */
    label: z.string().min(1).max(500),
    memo: z.string().max(8192),
    pins: z.array(handoffRoutePin).max(64),
    trail: z
      .object({
        ledgerId: z.string().max(128).optional(),
        ledgerUrl: z.string().max(2048).optional(),
        requestThreadId: z.string().max(128).optional()
      })
      .strict()
      .optional(),
    /** `person` and `machine` move files; `agent` on the same worktree moves nothing. */
    next: z.enum(['person', 'machine', 'agent']).default('person'),
    sameWorktree: z.boolean().default(false),
    /**
     * Commit everything uncommitted in the repository too, not only the named files. This is what
     * handing over a session mid-flight means: the other person needs the work in progress, not
     * just its outputs.
     */
    includeWorkingTree: z.boolean().default(false)
  })
  .strict()

export type HandoffRoutePreparationRequest = z.infer<typeof handoffRoutePreparationRequest>

export type HandoffRoutePreparation = {
  /** The pushed commit carrying every repo file, or null when none travelled by git. */
  git: {
    repo: string
    branch: string
    sha: string
    baseBranch: string | null
    remote: string
  } | null
  /** Pins that still travel as bytes, the manifest last. Empty when nothing needs to move. */
  pins: z.infer<typeof handoffRoutePin>[]
  /** Lines to append to the memo: the branch, the trail, what went where. */
  memoLines: string[]
  /** Files that could not travel, with the reason to show the sender. */
  refused: { name: string; reason: string }[]
  manifest: z.infer<typeof handoffManifestFile>[]
}

/** The branch a session's or chain's handoff commits go to. */
export function handoffBranchName(key: string): string {
  const safe = key
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 80)
  return `handoff/${safe || 'session'}`
}
