import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { CapturedFleetSource } from '../runtime/conversation-fleet-source-snapshot'
import type { CaptureFleetSourceRequest } from '../../shared/conversation-fleet-source-snapshot'
import type { SessionOutcomeCurrentSnapshot } from '../../shared/session-outcome-current-inputs'
import { taskId } from '../../shared/console-workflow-schemas'
import { consoleConversationSourcePath } from '../../shared/console-conversation-source-files'
import { handoffDigest, HANDOFF_FILE_MAX_BYTES } from '../../shared/console-handoff-contract'
import { FLEET_SOURCE_MAX_FILES } from '../../shared/conversation-fleet-source-snapshot'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { readOwnedInputTask } from './console-parent-task-inputs'
import { requestConsoleWorkflow, requestConsoleWorkflowUpload } from './console-workflow-transport'

const retainedFile = z.object({
  rel: consoleConversationSourcePath,
  sha256: handoffDigest,
  size_bytes: z.number().int().nonnegative().max(HANDOFF_FILE_MAX_BYTES)
})
const indexedFile = retainedFile
  .omit({ size_bytes: true })
  .extend({
    size_bytes: retainedFile.shape.size_bytes.optional(),
    size: retainedFile.shape.size_bytes.optional()
  })
  .refine((file) => file.size_bytes !== undefined || file.size !== undefined)
/** Zod v4 accumulates length checks, so a later `.min(0)` cannot relax an earlier `.min(1)`.
 *  The unbounded-below shape is therefore built once and the floor applied only where a manual
 *  selection really is required (#284: a response-only source carries no selected paths). */
const sourcePaths = z.array(z.string().min(1).max(4096)).max(FLEET_SOURCE_MAX_FILES)
const request = z
  .object({
    taskId,
    worktree: z.string().min(1).max(4096),
    principal: handoffDigest,
    selectedSourcePaths: sourcePaths.min(1)
  })
  .strict()
const sourceRequest = request.extend({
  selectedSourcePaths: sourcePaths,
  sourceResult: z
    .object({
      path: consoleConversationSourcePath,
      content: z.string().min(1).max(512_000)
    })
    .strict()
})
export type OutcomeCurrentInputFile = z.infer<typeof retainedFile> & {
  name: string
  target_path: string
}

export type OutcomeCurrentInputRuntime = {
  captureFleetSourceSnapshot(request: CaptureFleetSourceRequest): Promise<CapturedFleetSource>
}

/** Capture only selected current bytes; their old execution reports are not byte attestations. */
export async function captureOutcomeCurrentInputs(
  runtime: OutcomeCurrentInputRuntime,
  input: z.infer<typeof request>
): Promise<OutcomeCurrentInputFile[]> {
  return (await captureCurrentInputs(runtime, request.parse(input))).files
}

/** The completed source response and current Git edits travel through the same pinned-file store. */
export async function captureOutcomeSourceInputs(
  runtime: OutcomeCurrentInputRuntime,
  input: z.infer<typeof sourceRequest>
): Promise<SessionOutcomeCurrentSnapshot> {
  const args = sourceRequest.parse(input)
  return captureCurrentInputs(runtime, args, args.sourceResult)
}

async function captureCurrentInputs(
  runtime: OutcomeCurrentInputRuntime,
  args: z.infer<typeof request>,
  sourceResult?: z.infer<typeof sourceRequest>['sourceResult']
): Promise<SessionOutcomeCurrentSnapshot> {
  const capturedPerson = await captureConsoleWorkflowPerson()
  if (!capturedPerson.ok || capturedPerson.data.principal !== args.principal) {
    throw new Error('Sign in as the person who owns this saved outcome.')
  }
  const person = capturedPerson.data
  const owner = await readOwnedInputTask(args.taskId, person)
  const snapshot = await runtime.captureFleetSourceSnapshot({
    worktree: args.worktree,
    paths: args.selectedSourcePaths,
    includeDirtyTracked: Boolean(sourceResult),
    ...(sourceResult ? { includeUntracked: true } : {}),
    expectedConnectionId: null
  })
  if (
    !person.isCurrent() ||
    snapshot.manifest.source.connectionId !== null ||
    (!sourceResult &&
      (snapshot.manifest.baseCommit ||
        snapshot.manifest.deletions.length ||
        snapshot.manifest.files.length !== new Set(args.selectedSourcePaths).size))
  ) {
    throw new Error('The selected source inputs or their execution host changed during capture.')
  }
  if (sourceResult) {
    if (snapshot.manifest.files.some((file) => file.targetPath === sourceResult.path)) {
      throw new Error('The source-result snapshot path conflicts with an existing selected file.')
    }
    const bytes = Buffer.from(sourceResult.content)
    const id = randomUUID()
    snapshot.bytes.set(id, bytes)
    snapshot.manifest.files.push({
      id,
      name: 'source-result.md',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      targetPath: sourceResult.path,
      executable: false
    })
  }
  const listed = await requestConsoleWorkflow(
    `/api/gtd/hub/api/board/${args.taskId}/files`,
    'GET',
    z.object({ files: z.array(indexedFile) }),
    undefined,
    15_000,
    true,
    person.principal,
    person.isCurrent
  )
  if (!listed.ok) {
    throw new Error(listed.error.message)
  }
  const files: OutcomeCurrentInputFile[] = []
  for (const file of snapshot.manifest.files) {
    if (!person.isCurrent()) {
      throw new Error('The signed-in person changed before retaining inputs.')
    }
    const bytes = snapshot.bytes.get(file.id)
    if (
      !bytes ||
      bytes.length !== file.size ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    ) {
      throw new Error('The captured input bytes no longer match their exact manifest.')
    }
    let saved = listed.data.files.find(
      (candidate) =>
        candidate.sha256 === file.sha256 && (candidate.size_bytes ?? candidate.size) === file.size
    )
    if (!saved) {
      const uploaded = await requestConsoleWorkflowUpload(
        `/api/gtd/hub/api/board/${args.taskId}/files/upload`,
        z.object({ files: z.array(retainedFile) }),
        {
          files: [
            {
              name: file.name,
              contentType: 'application/octet-stream',
              bytes: new Uint8Array(bytes)
            }
          ],
          instructions: 'Current selected input for the saved outcome.'
        },
        120_000,
        person.principal,
        person.isCurrent
      )
      if (!uploaded.ok) {
        throw new Error(uploaded.error.message)
      }
      saved = uploaded.data.files.find(
        (candidate) => candidate.sha256 === file.sha256 && candidate.size_bytes === file.size
      )
    }
    if (!saved) {
      throw new Error('The retained current input does not match the captured bytes.')
    }
    files.push({
      rel: saved.rel,
      sha256: file.sha256,
      size_bytes: file.size,
      name: file.name,
      target_path: file.targetPath
    })
  }
  if (!isDeepStrictEqual(await readOwnedInputTask(args.taskId, person), owner)) {
    throw new Error('The task filing or owner changed while retaining current inputs.')
  }
  return {
    files,
    ...(snapshot.manifest.baseCommit
      ? {
          git: {
            head_sha: snapshot.manifest.baseCommit,
            deleted_paths: snapshot.manifest.deletions
          }
        }
      : {})
  }
}
