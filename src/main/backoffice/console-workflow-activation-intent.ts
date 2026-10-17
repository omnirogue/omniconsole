import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomicallyIfUnchanged } from '../codex-accounts/fs-utils'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { redactConsoleWorkflowMemory } from './console-workflow-person'

const identifier = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/)
const intentSchema = z
  .object({ version: z.literal(1), runnerInstance: identifier, claimRequestId: identifier })
  .strict()
export type ConsoleActivationIntent = z.infer<typeof intentSchema>

function intentPath(principal: string, jobId: string, digest: string, directory: string): string {
  if (!/^[a-f0-9]{64}$/.test(principal) || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('The activation transport identity is invalid.')
  }
  const key = createHash('sha256')
    .update(JSON.stringify([principal, jobId, digest]))
    .digest('hex')
  return join(directory, 'console-activation-transport', `${key}.json`)
}

/** Transport deduplication only: no prompt, job state, credential or estate session is stored. */
export function readConsoleActivationIntent(
  principal: string,
  jobId: string,
  digest: string,
  directory = getProfileUserDataPath()
): ConsoleActivationIntent | null {
  try {
    return intentSchema.parse(
      JSON.parse(readFileSync(intentPath(principal, jobId, digest, directory), 'utf8'))
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw new Error('The retained activation request cannot be read; no new claim was made.')
  }
}

export function retainConsoleActivationIntent(
  principal: string,
  jobId: string,
  digest: string,
  directory = getProfileUserDataPath()
): ConsoleActivationIntent {
  const previous = readConsoleActivationIntent(principal, jobId, digest, directory)
  if (previous) {
    return previous
  }
  const intent: ConsoleActivationIntent = {
    version: 1,
    runnerInstance: randomUUID(),
    claimRequestId: randomUUID()
  }
  if (JSON.stringify(intent) !== JSON.stringify(redactConsoleWorkflowMemory(intent))) {
    throw new Error('The activation request contains protected data.')
  }
  mkdirSync(join(directory, 'console-activation-transport'), { recursive: true })
  writeFileAtomicallyIfUnchanged(
    intentPath(principal, jobId, digest, directory),
    null,
    JSON.stringify(intent),
    { mode: 0o600 }
  )
  const retained = readConsoleActivationIntent(principal, jobId, digest, directory)
  if (!retained) {
    throw new Error('The activation request was not retained; no claim was made.')
  }
  return retained
}
