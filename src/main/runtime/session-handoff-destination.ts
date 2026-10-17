import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type * as nodePath from 'node:path'
import { writeExclusiveFile } from '../filesystem-exclusive-file'
import {
  handoffPackageFileNames,
  type HandoffPackageFileNames
} from '../../shared/session-handoff-package-file-names'

export type HandoffDestinationIo = {
  path: Pick<
    typeof nodePath,
    'basename' | 'dirname' | 'isAbsolute' | 'join' | 'relative' | 'resolve' | 'sep'
  >
  realpath: (path: string) => Promise<string>
}

/** Canonical destination: symlinked ancestors (/tmp, ~/code) are fine, symlinks inside the workspace are not. */
export async function chosenDestination(
  root: string,
  workspacePath: string,
  selected: string,
  io: HandoffDestinationIo = {
    path: { basename, dirname, isAbsolute, join, relative, resolve, sep },
    realpath
  }
): Promise<string> {
  const { basename, dirname, isAbsolute, join, relative, resolve, sep } = io.path
  const outside = (path: string): boolean =>
    path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
  const inside = [workspacePath, root]
    .map((base) => relative(base, resolve(base, selected)))
    .find((path) => path && !outside(path))
  if (inside !== undefined) {
    // Why: the candidate may carry committed symlinks; inside the workspace the folder must be real.
    const destination = resolve(root, inside)
    const parent = dirname(destination)
    if ((await io.realpath(parent).catch(() => null)) !== parent) {
      throw new Error('The chosen handoff folder changed or resolves through a symbolic link.')
    }
    return destination
  }
  const chosen = resolve(root, selected)
  const parent = await io.realpath(dirname(chosen)).catch(() => null)
  if (!parent) {
    throw new Error(`The chosen handoff folder does not exist: ${dirname(chosen)}`)
  }
  // Why: `root` is already canonical (its sole caller realpath()s the workspace); a path that spells
  // the workspace through a different alias (e.g. an OS tmp-dir symlink, or an attacker-planted
  // symlink elsewhere) still canonically resolves here even though it matched neither known spelling
  // above. Refuse it exactly like the in-workspace branch would, instead of silently accepting
  // whatever this alias's own symlink chain resolves to.
  if (parent === root || parent.startsWith(root + sep)) {
    throw new Error('The chosen handoff folder changed or resolves through a symbolic link.')
  }
  return join(parent, basename(chosen))
}

/** Whether the destination already holds something other than exactly these bytes. */
export async function destinationHoldsOtherBytes(
  destination: string,
  bytes: Buffer
): Promise<boolean> {
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (!existing) {
    return false
  }
  if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== bytes.length) {
    return true
  }
  const handle = await open(destination, 'r')
  try {
    return !(await handle.readFile()).equals(bytes)
  } finally {
    await handle.close()
  }
}

export async function materializeOne(destination: string, bytes: Buffer): Promise<void> {
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error('The chosen handoff destination is not a regular file.')
    }
    const handle = await open(destination, 'r')
    try {
      const current = await handle.readFile()
      if (current.length !== bytes.length || !current.equals(bytes)) {
        throw new Error('The chosen handoff destination changed; select a new path or remove it.')
      }
    } finally {
      await handle.close()
    }
    return
  }
  try {
    await writeExclusiveFile(destination, bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('The chosen handoff destination changed during materialization.')
    }
    throw error
  }
}

/** Names for the generated files that clash with no other work already in the chosen folder. */
export function packageNamesFreeInFolder(args: {
  topic: string
  keptSummaryName?: string
  folder?: string
  bytes: { summary?: Buffer; transcript?: Buffer }
  owner: {
    path: Pick<typeof nodePath, 'isAbsolute' | 'join'>
    destinationHoldsOtherBytes: (destination: string, bytes: Buffer) => Promise<boolean>
  }
}): Promise<HandoffPackageFileNames> {
  const { folder, owner } = args
  // Why: a probe that cannot answer is no reason to stop; the save itself reports the folder.
  const otherWorkAt = async (name: string, bytes: Buffer | undefined): Promise<boolean> =>
    !!bytes &&
    !!folder &&
    owner.path.isAbsolute(folder) &&
    owner.destinationHoldsOtherBytes(owner.path.join(folder, name), bytes).catch(() => false)
  return handoffPackageFileNames({
    topic: args.topic,
    keptSummaryName: args.keptSummaryName,
    clashes: async (candidate) =>
      (await otherWorkAt(candidate.summary, args.bytes.summary)) ||
      (await otherWorkAt(candidate.transcript, args.bytes.transcript))
  })
}
