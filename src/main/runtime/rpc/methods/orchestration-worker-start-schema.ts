import { openrouterCandidates } from '../../../../shared/openrouter-route'
import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { consoleLocalAttemptSchema } from '../../../console-workflows/console-local-execution-schema'

export const OptionalWorkerLaunchPreference = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim(), 'Surrounding whitespace is invalid')
  .optional()

export const WorkerStartParams = z.object({
  task: requiredString('Missing --task'),
  on: OptionalString,
  run: OptionalString,
  from: requiredString('Missing --from'),
  worktree: OptionalString,
  /**
   * Folder inside the resolved workspace the agent starts in. Folder workspaces
   * cannot create worktrees, so this is how two parallel workers on one folder get
   * their own working directory. Refused when it resolves outside the workspace.
   */
  cwd: OptionalString,
  /**
   * `managed:<id>` / `profile:<id>` from the agent's account choices. The launch
   * starts under that config directory; no credential is ever passed here.
   */
  accountChoiceId: OptionalString,
  name: OptionalString,
  repo: OptionalString,
  baseBranch: OptionalString,
  displayName: OptionalString,
  comment: OptionalString,
  setup: z.enum(['run', 'skip', 'inherit']).optional(),
  terminal: OptionalString,
  agent: OptionalString,
  openrouterCandidates: openrouterCandidates.optional(),
  model: OptionalWorkerLaunchPreference,
  effort: OptionalWorkerLaunchPreference,
  permissionMode: z.enum(['yolo', 'read-only']).optional(),
  retryOf: OptionalString,
  executionBrief: z.string().min(1).max(100_000).optional(),
  consoleExecution: consoleLocalAttemptSchema.optional(),
  continueFrom: OptionalString,
  timeoutMs: OptionalFiniteNumber,
  /** True opts in, false retains; absent defaults eligible new local workers to accepted release. */
  closeOnCompletion: z.boolean().optional(),
  devMode: z.boolean().optional(),
  /** A Conversations folder (id or path) in the project the worker joins; default: its coordinator's. */
  project: OptionalString,
  /** Starts the worker without its coordinator's project. */
  noProject: z.boolean().optional()
})

export type WorkerStartInput = z.infer<typeof WorkerStartParams>
