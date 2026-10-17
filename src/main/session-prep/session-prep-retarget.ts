import { isAbsolute, relative, sep } from 'node:path'
import type { PreparedFields } from '../../shared/session-prep-types'
import type { SessionPrepRepo } from './session-prep-host'
import { matchSessionPrepRepoHint } from './session-prep-target'

/**
 * Measured live: asked from one repository about work that lives in another, the preparer found
 * the right files and cited them by absolute path. The item moves to the repository the preparer
 * named, or else to the ONE other registered repository all its repository references sit in; those
 * references become relative to it, so the gate checks them in the right place and the session
 * launches where the work is. Absolute references outside every repository (a PDF on the Desktop)
 * stay as they are and never block the move.
 */
export function retargetFromReferences(
  repos: SessionPrepRepo[],
  currentRepoId: string,
  fields: PreparedFields
): { repo: SessionPrepRepo; fields: PreparedFields } | null {
  const named = fields.repo ? matchSessionPrepRepoHint(repos, fields.repo) : null
  const owners = new Set(
    fields.references
      .filter((ref) => isAbsolute(ref.path))
      .map((ref) => owningRepo(repos, ref.path)?.id)
      .filter((id): id is string => id !== undefined)
  )
  const repo =
    named ??
    (owners.size === 1 ? (repos.find((candidate) => owners.has(candidate.id)) ?? null) : null)
  if (!repo || repo.id === currentRepoId || repo.isRemote) {
    return null
  }
  return {
    repo,
    fields: {
      ...fields,
      references: fields.references.map((ref) =>
        isAbsolute(ref.path) && owningRepo(repos, ref.path)?.id === repo.id
          ? { ...ref, path: relative(repo.path, ref.path) }
          : ref
      )
    }
  }
}

function owningRepo(repos: SessionPrepRepo[], path: string): SessionPrepRepo | null {
  // Why the longest match: a repository checked out inside another must win over its parent.
  const inside = repos.filter(
    (repo) =>
      path === repo.path || path.startsWith(repo.path.endsWith(sep) ? repo.path : repo.path + sep)
  )
  return inside.sort((left, right) => right.path.length - left.path.length)[0] ?? null
}
