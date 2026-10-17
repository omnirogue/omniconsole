import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  graphLaneGit,
  graphLaneGitFailure,
  type GraphCheckLane,
  type GraphCheckLanes
} from './graph-check-lane'
import {
  GRAPH_PATCH_NO_DIFF,
  GRAPH_PATCH_REFUSED,
  GRAPH_PATCH_UNAPPLIED,
  graphPatchExits,
  graphPatchModeProblem,
  graphPatchNumstat,
  graphPatchPathProblem,
  graphPatchText
} from './graph-check-patch'
import type { GraphCheckRequest, GraphCheckResult } from './graph-plan-types'

function rethrowIfStopped(signal: AbortSignal | undefined, error: unknown): void {
  if (signal?.aborted) {
    throw signal.reason ?? error
  }
}

/** The first path, or a folder above it, that is a symbolic link in the copy (any case, as the disk sees it). */
async function linkOnTheWay(cwd: string, paths: readonly string[]): Promise<string | undefined> {
  const prefixes = new Set(
    paths.flatMap((path) =>
      path.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))
    )
  )
  for (const prefix of prefixes) {
    const info = await lstat(join(cwd, ...prefix.split('/'))).catch(() => undefined)
    if (info?.isSymbolicLink()) {
      return prefix
    }
  }
  return undefined
}

/** Paths Git ignores: the reset between versions keeps them, so no version may write one. */
async function ignoredPaths(
  cwd: string,
  paths: readonly string[],
  signal: AbortSignal | undefined
): Promise<string[]> {
  try {
    const out = await graphLaneGit(cwd, ['check-ignore', '-z', '--stdin'], {
      stdin: `${paths.join('\0')}\0`,
      ...(signal ? { signal } : {})
    })
    return out.split('\0').filter(Boolean)
  } catch (error) {
    // Exit 1: none of them is ignored.
    if (graphLaneGitFailure(error).code === 1) {
      return []
    }
    throw error
  }
}

/**
 * Why this patch may not be applied, or undefined when it may. Git names every file it touches
 * (`--numstat`, and reversed, the files a rename or copy reads); a problem with the change is a
 * reason, and a problem with Git or the copy throws.
 */
async function patchRefusal(
  cwd: string,
  patch: string,
  protect: readonly string[],
  signal: AbortSignal | undefined
): Promise<string | undefined> {
  const withSignal = signal ? { signal } : {}
  let forward: string
  let backward: string
  try {
    // Read with the same --recount the apply uses, so both see the same hunks.
    forward = await graphLaneGit(cwd, ['apply', '--recount', '--numstat', '--summary', '-z'], {
      stdin: patch,
      ...withSignal
    })
    backward = await graphLaneGit(cwd, ['apply', '--recount', '-R', '--numstat', '-z'], {
      stdin: patch,
      ...withSignal
    })
  } catch (error) {
    rethrowIfStopped(signal, error)
    return `Git could not read the diff: ${graphLaneGitFailure(error).message}`
  }
  // With -z the numstat records end in NUL; the summary lines follow the last one.
  const end = forward.lastIndexOf('\0') + 1
  const written = graphPatchNumstat(forward.slice(0, end))
  if (!written.paths.length) {
    return 'The diff changes no file.'
  }
  if (written.binary.length) {
    return `It changes binary content (${written.binary[0]}), which a diff cannot show.`
  }
  const paths = [...new Set([...written.paths, ...graphPatchNumstat(backward).paths])]
  const problem =
    graphPatchModeProblem(forward.slice(end), patch) ??
    paths.map((path) => graphPatchPathProblem(path, protect)).find(Boolean)
  if (problem) {
    return problem
  }
  const link = await linkOnTheWay(cwd, paths)
  if (link) {
    return `${link} is a symbolic link in your code, which a version may not change or write through.`
  }
  const ignored = await ignoredPaths(cwd, written.paths, signal)
  return ignored.length
    ? `${ignored[0]} is a file Git ignores, which the reset between versions would keep.`
    : undefined
}

/**
 * Tests one version that is a change to the code, in a private copy and never in the person's
 * files: the diff is read and refused if it touches what it may not, applied, and only then the
 * person's command runs there (`test`). "No change" runs the command on the code as it is. A
 * refused or failing diff is the version's fault (a failed check); a copy that cannot be made or
 * used is unknown (`unavailable`), never a pass.
 */
export async function runGraphPatchCheck(
  request: GraphCheckRequest,
  options: {
    lanes: GraphCheckLanes
    test: (cwd: string) => Promise<GraphCheckResult>
    signal?: AbortSignal
  }
): Promise<GraphCheckResult> {
  const { signal } = options
  const patch = request.unchanged ? undefined : graphPatchText(request.candidate)
  if (!request.unchanged && !patch) {
    return { passed: false, detail: GRAPH_PATCH_NO_DIFF }
  }
  let lane: GraphCheckLane
  try {
    // The final test never runs where an earlier version's test left anything behind.
    lane = await options.lanes.acquire(request.prepare, request.sealed === true)
  } catch (error) {
    rethrowIfStopped(signal, error)
    const reason = error instanceof Error ? error.message : String(error)
    return {
      passed: false,
      unavailable: true,
      detail: `The test could not run: no private copy of your code could be made. ${reason}`
    }
  }
  let known = false
  try {
    if (patch) {
      const refused = await patchRefusal(lane.path, patch, request.protect ?? [], signal)
      if (refused) {
        known = true
        return { passed: false, detail: `${GRAPH_PATCH_REFUSED} ${refused}` }
      }
      try {
        await graphLaneGit(lane.path, ['apply', '--recount', '--whitespace=nowarn'], {
          stdin: patch,
          ...(signal ? { signal } : {})
        })
      } catch (error) {
        rethrowIfStopped(signal, error)
        known = true
        return {
          passed: false,
          detail: `${GRAPH_PATCH_UNAPPLIED}\n${graphLaneGitFailure(error).message}`
        }
      }
    }
    const result = await options.test(lane.path)
    known = !signal?.aborted
    const exits = patch ? graphPatchExits(patch) : []
    return exits.length
      ? {
          ...result,
          exits,
          detail: `Flagged: this change adds ${exits.join(', ')}, which ends the process early; a test run can then pass without testing.\n${result.detail}`
        }
      : result
  } catch (error) {
    rethrowIfStopped(signal, error)
    return {
      passed: false,
      unavailable: true,
      detail: `The test could not run in the private copy: ${graphLaneGitFailure(error).message}`
    }
  } finally {
    // A copy is reset before its next use; one left in an unknown state is removed instead.
    if (known && !request.sealed) {
      options.lanes.release(lane)
    } else {
      options.lanes.discard(lane)
    }
  }
}
