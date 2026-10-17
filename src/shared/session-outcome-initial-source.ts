import { z } from 'zod'
import {
  sessionOutcomeCurrentGit,
  sessionOutcomeCurrentInputFile,
  sessionOutcomeCurrentProducer
} from './session-outcome-current-inputs'

/** Host-captured source bytes and actor; a completed source is not an accepted producer receipt. */
export const sessionOutcomeInitialSource = z
  .object({
    sourceVersion: z.string().min(1),
    paneKey: z.string().min(1),
    worktreeId: z.string().min(1),
    handle: z.string().min(1),
    processIncarnation: z.string().min(1),
    producer: sessionOutcomeCurrentProducer,
    effort: z.string().min(1).optional(),
    files: z.array(sessionOutcomeCurrentInputFile).min(1).max(32),
    git: sessionOutcomeCurrentGit.optional()
  })
  .strict()
