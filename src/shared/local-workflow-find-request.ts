import { z } from 'zod'
import { localWorkflowLaunchFields } from './local-workflow-launch'
import { composeReviewStepInstructions, type SavedReviewRubric } from './review-rubrics'
import { rubricLibrary } from './rubric-library'
import {
  WORKFLOW_FIND_MAX_COUNT,
  WORKFLOW_FIND_MAX_ITEM_CHARS,
  WORKFLOW_FIND_MAX_ITEMS,
  WORKFLOW_FIND_MAX_KEEP,
  WORKFLOW_MAX_RANK_CANDIDATES,
  type WorkflowRoute,
  type WorkflowSpec
} from './workflow-graph'
import { workflowPatchStep } from './workflow-graph-edit'
import { findJudgeStep, workflowSetFind } from './workflow-graph-find'
import { workflowTemplate } from './workflow-graph-templates'

/** `omni find-best` asks the app to open a Find the best conversation and starts it; the app replies. */
export const LOCAL_WORKFLOW_FIND_REQUEST_CHANNEL = 'ui:startLocalWorkflowFind'
export const LOCAL_WORKFLOW_FIND_REPLY_CHANNEL = 'localWorkflow:findReply'

const findImportReceiptSchema = z
  .object({
    read: z.number().int().nonnegative(),
    imported: z.number().int().nonnegative(),
    skipped: z.array(z.object({ line: z.number().int().positive(), reason: z.string() })),
    merged: z.number().int().nonnegative()
  })
  .strict()

export const localWorkflowFindRequestSchema = z
  .object({
    ...localWorkflowLaunchFields,
    prompt: z.string().trim().min(1).max(32_000),
    /** The person's own options, one each; when set, nothing is generated. */
    items: z
      .array(
        z.union([
          z.string().max(WORKFLOW_FIND_MAX_ITEM_CHARS),
          z
            .object({
              title: z.string().trim().min(1).max(WORKFLOW_FIND_MAX_ITEM_CHARS),
              detail: z.string().max(WORKFLOW_FIND_MAX_ITEM_CHARS).optional(),
              url: z.string().max(WORKFLOW_FIND_MAX_ITEM_CHARS).optional()
            })
            .strict()
        ])
      )
      .min(2)
      .max(WORKFLOW_FIND_MAX_ITEMS)
      .optional(),
    /** How this list was actually imported (rows read, kept, skipped with why): from the file or
     * paste that produced `items`, whether or not any row carried detail/url. */
    importReceipt: findImportReceiptSchema.optional(),
    /** Each model writes one complete version instead of listing short options. */
    versions: z.boolean().optional(),
    count: z.number().int().min(2).max(WORKFLOW_FIND_MAX_COUNT).optional(),
    top: z.number().int().min(1).max(WORKFLOW_MAX_RANK_CANDIDATES).optional(),
    keep: z.number().int().min(1).max(WORKFLOW_FIND_MAX_KEEP).optional(),
    /** A rubric from the library, built in or saved, by its name. */
    rubric: z.string().trim().min(1).max(200).optional(),
    /** What good means in the person's own words; one criterion per line. */
    good: z.string().trim().min(1).max(16_000).optional()
  })
  .strict()
  .refine((request) => !(request.items && request.versions), {
    message: 'a list is judged as given, so it cannot also be complete versions',
    path: ['versions']
  })

export type LocalWorkflowFindRequest = z.infer<typeof localWorkflowFindRequestSchema>

export type LocalWorkflowFindStarted = {
  worktreeId: string
  conversationId: string
  executionId: string
}

export type LocalWorkflowFindReply = { requestId: string } & (
  | { conversationId: string; executionId: string }
  | { error: string }
)

/**
 * The Find the best spec a request asks for, built as the Options panel builds it: a rubric from
 * the library by name, and what else is good in the person's words. An unknown rubric name is an
 * error that lists the names there are, never a silent general rubric.
 */
export function localWorkflowFindSpec(
  request: LocalWorkflowFindRequest,
  routes: readonly WorkflowRoute[],
  saved: readonly SavedReviewRubric[]
): WorkflowSpec {
  const spec = workflowSetFind(
    workflowTemplate('find', routes),
    {
      ...(request.items ? { items: request.items } : {}),
      ...(request.importReceipt ? { importReceipt: request.importReceipt } : {}),
      ...(request.versions && !request.items ? { versions: true } : {}),
      ...(request.count !== undefined ? { count: request.count } : {}),
      ...(request.top !== undefined ? { top: request.top } : {}),
      ...(request.keep !== undefined ? { keep: request.keep } : {})
    },
    routes
  )
  if (!request.rubric && !request.good) {
    return spec
  }
  const library = rubricLibrary(saved)
  const named = request.rubric
    ? library.find((entry) => entry.rubric.name.toLowerCase() === request.rubric!.toLowerCase())
    : undefined
  if (request.rubric && !named) {
    throw new Error(
      `No rubric is named "${request.rubric}". Choose one of: ${library.map((entry) => entry.rubric.name).join(', ')}.`
    )
  }
  return workflowPatchStep(spec, findJudgeStep(spec)!.id, {
    instruction: composeReviewStepInstructions({
      ...(named ? { shared: named.rubric } : {}),
      perReviewer: [],
      focus: request.good ?? ''
    })
  })
}
