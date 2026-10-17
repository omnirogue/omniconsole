import { z } from 'zod'
import { handoffId } from '../../shared/console-handoff-contract'
import {
  HANDOFF_MANIFEST_NAME,
  parseHandoffManifest,
  type HandoffManifest
} from '../../shared/handoff-manifest'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { consoleHandoffClient } from './console-handoff-client'
import { downloadHandoffFile } from './console-handoff-files'
import { failure, validated } from './console-workflow-transport'
import { checkoutHandoffBranch } from './handoff-git-checkout'
import { resolveHandoffRemote } from './handoff-git-route'
import { HandoffGitRouteError } from './handoff-git-exec'
import {
  attachmentsManifest,
  defaultMaterializeRoot,
  materializeHandoffFiles,
  readHandoffManifestFile,
  type MaterializeHandoffResult
} from './handoff-materialize'

/**
 * Put a received handoff on this machine: check out the branch its repo files travelled on, then
 * write every other file back into the folder it came from.
 *
 * This is the step that was missing entirely — a handoff could be read but never worked on. Each
 * half reports for itself, because either can succeed while the other cannot: a branch that will
 * not check out over local edits is a different problem from a file that failed to verify.
 */
export const handoffReceiveRequest = z
  .object({
    threadId: handoffId,
    /** The workspace to put the work in; the person picks it, this never invents one. */
    workspacePath: z.string().min(1).max(4096),
    /** Skip the checkout and only write the loose files. */
    filesOnly: z.boolean().default(false)
  })
  .strict()

export type HandoffReceiveResult = {
  manifest: HandoffManifest
  git: { branch: string; sha: string } | { refused: string } | null
  files: MaterializeHandoffResult
}

/** The manifest, from the thread's own files; plain attachments have none and are saved flat. */
async function manifestForThread(
  threadId: string,
  title: string,
  files: { id: string; name: string; path: string; sha256: string; size: number }[]
): Promise<HandoffManifest> {
  if (!files.some((file) => file.name === HANDOFF_MANIFEST_NAME)) {
    return attachmentsManifest(title, files)
  }
  return readHandoffManifestFile(files, async (file) => {
    const result = await downloadHandoffFile({
      threadId,
      file: files.find((row) => row.id === file.id)
    })
    if (!result.ok) {
      throw new Error(result.error.message)
    }
    return result.data
  })
}

export async function receiveHandoff(
  request: z.infer<typeof handoffReceiveRequest>,
  store: Store
): Promise<HandoffReceiveResult> {
  const workspacePath = await resolveAuthorizedPath(request.workspacePath, store)
  const detail = await consoleHandoffClient.get({ threadId: request.threadId })
  if (!detail.ok) {
    throw new Error(detail.error.message)
  }
  const available = detail.data.files.filter((file) => file.current && file.available)
  const manifest = await manifestForThread(request.threadId, detail.data.thread.title, available)
  let git: HandoffReceiveResult['git'] = null
  if (manifest.git && !request.filesOnly) {
    try {
      // Why not a hard-coded origin: a contributor fork or a second remote is the normal case in
      // this estate, and fetching from the wrong one reports a missing commit that is really there.
      const checkout = await checkoutHandoffBranch({
        worktreePath: workspacePath,
        remote: await resolveHandoffRemote(workspacePath),
        branch: manifest.git.branch,
        sha: manifest.git.sha,
        expectations: manifest.files.filter((file) => file.route === 'git')
      })
      git = { branch: checkout.branch, sha: checkout.sha }
    } catch (error) {
      // A checkout that will not run is reported, never forced: the person's own work wins.
      git =
        error instanceof HandoffGitRouteError
          ? { refused: error.message }
          : { refused: error instanceof Error ? error.message : String(error) }
    }
  }
  const files = await materializeHandoffFiles({
    workspacePath,
    root: defaultMaterializeRoot(workspacePath, manifest),
    manifest,
    threadFiles: available,
    io: {
      download: async (file) => {
        const row = available.find((candidate) => candidate.id === file.id)
        const result = await downloadHandoffFile({ threadId: request.threadId, file: row })
        if (!result.ok) {
          throw new Error(result.error.message)
        }
        return result.data
      }
    }
  })
  return { manifest, git, files }
}

export const materializeHandoff = (args: unknown, store: Store) =>
  validated(args, handoffReceiveRequest, async (request) => {
    try {
      return { ok: true as const, data: await receiveHandoff(request, store) }
    } catch (error) {
      return failure(
        'file_unavailable',
        error instanceof Error
          ? error.message
          : 'This handoff could not be put on this computer. Try again.'
      )
    }
  })

export { parseHandoffManifest }
