import { findJudgeText } from '../../../../shared/find-judge-text'
import type { WorkflowFind, WorkflowStep } from '../../../../shared/workflow-graph'
import type { GraphItem } from './graph-items'
import type { GraphNamedText } from './graph-plan-types'
import type { GraphScope } from './graph-scope'

/** One option in the pool: what it says and who proposed it. */
export type FindOption = {
  key: string
  title: string
  detail: string
  /** A link the option carries (an import's URL column, or a GitHub search result's repo link). */
  url?: string
  seatId: string
  by: string
  agentIndex?: number
  /** What the judges read, when it is not the title and detail: a version, without its angle. */
  text?: string
  /** GitHub's facts for the repository it names, fetched by the host. */
  facts?: string
  /** A complete version: the call that wrote it, which its check sits beside. */
  callId?: string
}

/** The seat the person's own options are recorded under: no judge's own work, so all may vote. */
export const FIND_PERSON_SEAT = 'your-list'

/** Before findRules 4: title/detail shown as given, whatever it says. A run admitted under an
 * earlier revision must keep replaying exactly what it actually asked, forever. */
const legacyOptionText = (option: FindOption) =>
  option.text ?? (option.detail ? `${option.title}: ${option.detail}` : option.title)

// The judge-safe projection (findJudgeText) is the one function every judge path and every
// continuation uses from findRules 4 on; here it is only ever combined with the host's own
// fetched facts. Gated so an older run's saved prompts never silently change on replay.
export const findOptionText = (option: FindOption, findRules?: number) => {
  const body = (findRules ?? 0) >= 4 ? findJudgeText(option) : legacyOptionText(option)
  return `${body}${option.facts ? `\n${option.facts}` : ''}`
}

export function poolFromItems(
  scope: GraphScope,
  options: WorkflowStep,
  items: GraphItem[]
): FindOption[] {
  return items.map((item) => {
    const agentIndex = Number(/\/a(\d+)$/.exec(item.sourceCallId)?.[1] ?? 0)
    const seatId = scope.config.agentSeats[options.id]?.[agentIndex] ?? ''
    return {
      key: item.key,
      title: item.title,
      detail: item.detail,
      seatId,
      by: scope.nameOf(seatId),
      agentIndex
    }
  })
}

/** Complete versions: each is judged on its own text, named by its maker's angle. */
export function poolFromTexts(scope: GraphScope, options: WorkflowStep, texts: GraphNamedText[]) {
  return texts.map((text): FindOption => {
    const angle = options.agents[text.agentIndex]?.angle
    return {
      key: `version.${text.agentIndex + 1}`,
      title: `Version ${text.agentIndex + 1}${angle ? `: ${angle}` : ''}`,
      detail: text.markdown,
      seatId: text.seatId,
      by: scope.nameOf(text.seatId),
      agentIndex: text.agentIndex,
      text: text.markdown,
      callId: text.callId
    }
  })
}

/** Plain strings retain the original pool shape and exact text. */
export function poolFromGivenItems(
  items: readonly string[],
  itemDetails?: NonNullable<WorkflowFind['itemDetails']>
): FindOption[] {
  return items.map((title, index) => {
    const extra = itemDetails?.[index]
    return {
      key: `list.${index + 1}`,
      title,
      detail: extra?.detail ?? '',
      ...(extra?.url ? { url: extra.url } : {}),
      seatId: FIND_PERSON_SEAT,
      by: 'your list'
    }
  })
}
