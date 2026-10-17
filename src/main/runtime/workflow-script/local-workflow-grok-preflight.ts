import { access, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import {
  assertBinaryVersion,
  grokHome,
  workflowProgram,
  inspectLegacyGrok
} from './local-workflow-cli-programs'
import { COUNCIL_REVISION } from './workflow-program-revisions'
export async function grokSandboxProblem(
  inspect: (path: string) => Promise<{ isSymbolicLink(): boolean }> = lstat,
  // Tests point this at a path they control; the machine's own socket decides otherwise.
  socket = process.env.OMNI_GROK_RUNTIME_SOCKET ?? '/var/run/docker.sock'
): Promise<string | undefined> {
  try {
    if ((await inspect(socket)).isSymbolicLink()) {
      return "Grok's sandbox cannot start on this computer: /var/run/docker.sock is a symlink."
    }
  } catch {
    // No socket at all is fine: there is nothing for the sandbox to resolve.
  }
  return undefined
}

export async function grokStreamProblem(): Promise<string | undefined> {
  try {
    await assertBinaryVersion('grok', undefined, workflowProgram('grok', true))
  } catch (cause) {
    return cause instanceof Error ? cause.message : 'Grok CLI is unavailable.'
  }
  try {
    await access(join(grokHome(), 'auth.json'))
  } catch {
    return 'Sign in to Grok (grok login) to use it in workflows.'
  }
  return await grokSandboxProblem()
}

export async function preflightGrok(
  snapshot: LocalWorkflowHostSnapshot,
  env: NodeJS.ProcessEnv
): Promise<void> {
  if (
    snapshot.access === 'workspace-read' ||
    snapshot.councilProgramRevision === COUNCIL_REVISION ||
    snapshot.graphProgramRevision !== undefined
  ) {
    const problem = await grokStreamProblem()
    if (problem) {
      throw new Error(problem)
    }
    return
  }
  await assertBinaryVersion('grok')
  await inspectLegacyGrok(env)
}
