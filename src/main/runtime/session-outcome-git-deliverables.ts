import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import { chosenDestination, materializeOne } from './session-handoff-destination'
import { gitExecFileAsync, gitExecFileAsyncBuffer } from '../git/runner'
import type { SessionFollowUpRule } from '../../shared/session-follow-up-rule'

const candidateSha = /^[a-f0-9]{40,64}$/

function repositoryPath(path: string): boolean {
  return (
    !!path &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')
  )
}

async function readAcceptedBlob(
  workspacePath: string,
  sha: string,
  destination: string
): Promise<Buffer> {
  const tree = await gitExecFileAsync(
    ['ls-tree', '-r', '--name-only', '-z', '--end-of-options', sha],
    { cwd: workspacePath, maxBuffer: 4 * 1024 * 1024 }
  )
  const name = basename(destination)
  const matches = tree.stdout
    .split('\0')
    .filter((path) => repositoryPath(path) && basename(path) === name)
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? `The accepted candidate has multiple files named ${name}; choose an unambiguous output path.`
        : `The accepted candidate does not contain the chosen output ${name}.`
    )
  }
  return (
    await gitExecFileAsyncBuffer(['show', '--end-of-options', `${sha}:${matches[0]}`], {
      cwd: workspacePath,
      maxBuffer: 10 * 1024 * 1024
    })
  ).stdout
}

/** Materialize only missing explicitly chosen files from one accepted Git candidate. */
export async function materializeSessionOutcomeGitDeliverables(args: {
  workspacePath: string
  candidateSha: string
  handoff: SessionFollowUpRule
}): Promise<void> {
  if (
    !candidateSha.test(args.candidateSha) ||
    !args.handoff.deliverables ||
    args.handoff.deliverables.kind !== 'files'
  ) {
    return
  }
  const root = await realpath(args.workspacePath)
  for (const selected of args.handoff.deliverables.paths) {
    const destination = await chosenDestination(root, args.workspacePath, selected)
    const bytes = await readAcceptedBlob(root, args.candidateSha, destination)
    if (bytes.length > 10 * 1024 * 1024) {
      throw new Error(
        `The chosen handoff file exceeds its supported transfer size: ${basename(destination)}`
      )
    }
    await materializeOne(destination, bytes)
  }
}
