import { companyPlaceForPath, type CompanyPlace } from '@/lib/company-place'
import type { WorkFolderCompany } from '../../../shared/console-work-folders-contract'

const TITLE_MAX = 160

export type InferredTask = {
  title: string
  place: CompanyPlace | null
}

/**
 * What a task created from this conversation should say, before the person corrects it.
 * The title is what the conversation is already called; the filing is where its folder
 * sits in the estate — a default at creation, never the task's identity afterwards.
 */
export function inferTaskFromSession(input: {
  /** The conversation's own name, generated or renamed. */
  conversationTitle: string
  /** A first line the person has already typed, which beats the name when present. */
  note?: string | null
  /** The folder the conversation runs in. */
  path?: string | null
  companies: readonly WorkFolderCompany[]
  home: string
  workRoot?: string | null
  overrides?: Record<string, string> | null
}): InferredTask {
  const noteLine = (input.note ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  const title = (noteLine ?? input.conversationTitle ?? '').trim().slice(0, TITLE_MAX)
  return {
    title,
    place: companyPlaceForPath(input.companies, input.path, {
      home: input.home,
      workRoot: input.workRoot,
      overrides: input.overrides
    })
  }
}

/** "OmniRogue › Development › OmniConsole" — the filing as one readable line. */
export function describeTaskPlace(place: CompanyPlace | null): string | null {
  if (!place) {
    return null
  }
  return [place.company.name, place.domain?.name, place.project?.name]
    .filter((part): part is string => Boolean(part))
    .join(' › ')
}
