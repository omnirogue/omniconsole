/**
 * JEV's questions behind the steward's organizing (Phase 3): which existing folder fits an idle
 * session (a choice over folder paths plus "none"), and whether two sessions are the same ongoing
 * project (asked in both orders, the lower answer kept). A failed or missing answer moves nothing.
 */

import type { DecisionRequest, DecisionResult } from '../../../shared/structured-decisions'
import { jevDecide } from '../../structured-decisions/jev-rank'
import { fitJevText } from '../../structured-decisions/jev-rank-rubric'
import { TYPESAFE_DEFAULT_MODEL } from '../../structured-decisions/typesafe-provider'

export const STEWARD_ORGANIZE_JEV_CAPABILITY = 'sessions.steward-organize'
/** JEV reads up to this many folders per session (same repo or top-level folder first). */
export const STEWARD_FOLDER_CHOICES_MAX = 30
export const STEWARD_NO_FOLDER = 'none'

export const STEWARD_FOLDER_FIT_QUESTION =
  'Which folder does this session belong in? Pick the folder whose name describes the same client, product, project or area of work as the session. Pick "none" when no folder clearly fits.'

/** Both orders name their two texts by position; the state carries them in that order. */
export const SESSION_PROJECT_QUESTION =
  'Do the first and the second belong to the same ongoing project (the same product, client or deliverable), so they would be filed together?'

export type StewardJevDecide = (
  request: DecisionRequest
) => Promise<DecisionResult | { failed: string }>

/** What JEV reads about one session. */
export type StewardSessionFacts = {
  title: string
  goal: string | null
  repo: string | null
  host: string
  folder: string | null
}

export type StewardFolderChoice = { id: string; path: string }

export type StewardFolderReading =
  | { folderId: string | null; confidence: number }
  | { failed: string }

function describe(facts: StewardSessionFacts): string {
  return fitJevText(
    [
      `Title: ${facts.title}`,
      `Goal (the person's first request to it): ${facts.goal?.trim() || 'unknown'}`,
      `Repository: ${facts.repo ?? 'none'}`,
      `Computer: ${facts.host}`,
      `Current folder: ${facts.folder ?? 'none'}`
    ].join('\n'),
    4_000
  )
}

/** Criterion ids are positional (`f0`…): folder ids need not fit JEV's identifier pattern. */
export function buildFolderFitRequest(
  facts: StewardSessionFacts,
  folders: readonly StewardFolderChoice[]
): DecisionRequest {
  const criteria: Record<string, string> = {}
  folders.slice(0, STEWARD_FOLDER_CHOICES_MAX).forEach((folder, index) => {
    criteria[`f${index}`] = folder.path
  })
  criteria[STEWARD_NO_FOLDER] = 'none of these folders fits'
  return {
    capability: STEWARD_ORGANIZE_JEV_CAPABILITY,
    model: TYPESAFE_DEFAULT_MODEL,
    state: { session: describe(facts) },
    questions: { folder: { type: 'choice', instructions: STEWARD_FOLDER_FIT_QUESTION, criteria } }
  }
}

/** The chosen folder and its probability; `folderId: null` is "none". */
export async function readFolderFit(
  facts: StewardSessionFacts,
  folders: readonly StewardFolderChoice[],
  decide: StewardJevDecide = jevDecide
): Promise<StewardFolderReading> {
  if (folders.length === 0) {
    return { folderId: null, confidence: 1 }
  }
  const result = await decide(buildFolderFitRequest(facts, folders))
  if ('failed' in result) {
    return result
  }
  const answer = result.answers.folder
  if (answer?.type !== 'choice') {
    return { failed: 'JEV did not answer the folder question' }
  }
  const confidence = answer.probabilities[answer.choice] ?? answer.confidence
  if (!Number.isFinite(confidence)) {
    return { failed: 'JEV gave no probability for its folder choice' }
  }
  if (answer.choice === STEWARD_NO_FOLDER) {
    return { folderId: null, confidence }
  }
  const index = /^f(\d+)$/.exec(answer.choice)?.[1]
  const folder = index === undefined ? undefined : folders[Number(index)]
  return folder
    ? { folderId: folder.id, confidence }
    : { failed: `JEV chose an unknown folder (${answer.choice})` }
}

function projectRequest(first: string, second: string): DecisionRequest {
  return {
    capability: STEWARD_ORGANIZE_JEV_CAPABILITY,
    model: TYPESAFE_DEFAULT_MODEL,
    state: { first, second },
    questions: { project: { type: 'noul', instructions: SESSION_PROJECT_QUESTION } }
  }
}

function noul(result: DecisionResult | { failed: string }): number | null {
  if ('failed' in result) {
    return null
  }
  const answer = result.answers.project
  return answer?.type === 'noul' && Number.isFinite(answer.noul) ? answer.noul : null
}

/** "Same ongoing project" in both orders, the lower kept; null when either order is missing. */
export async function readSameProject(
  left: StewardSessionFacts,
  right: StewardSessionFacts,
  decide: StewardJevDecide = jevDecide
): Promise<number | null> {
  const [first, second] = [describe(left), describe(right)]
  const [ordered, swapped] = await Promise.all([
    decide(projectRequest(first, second)),
    decide(projectRequest(second, first))
  ])
  const a = noul(ordered)
  const b = noul(swapped)
  return a === null || b === null ? null : Math.min(a, b)
}
