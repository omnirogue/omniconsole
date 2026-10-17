import { WORKFLOW_SCREEN_SET_ASIDE } from '../../../../shared/workflow-graph'
import { findBestFirst, readFindScreen } from './graph-find-rows'
import type { GraphShortlistPlan } from './graph-frame-limits'
import type { GraphItem } from './graph-items'
import { graphPlural, type GraphOutcome } from './graph-plan-types'

export type GraphShortlist = {
  /** The shortlist, in the order it was picked; never more than the limit. */
  ordered: GraphItem[]
  /** Never a reviewer's target: a Do step's shortlist sets nothing aside for review. */
  setAside: GraphItem[]
  note: string
  /** Why nothing is left to work on, when every option broke a hard limit. */
  empty?: string
  /** What the screen could not settle, each a gap of the run. */
  unranked?: string
}

/** Alternates between the models that proposed the items, each in the order it proposed them. */
function alternate(items: readonly GraphItem[]): GraphItem[] {
  const bySource = new Map<string, GraphItem[]>()
  for (const item of items) {
    bySource.set(item.sourceCallId, [...(bySource.get(item.sourceCallId) ?? []), item])
  }
  const queues = [...bySource.values()]
  const out: GraphItem[] = []
  for (let index = 0; out.length < items.length; index++) {
    for (const queue of queues) {
      if (queue[index]) {
        out.push(queue[index]!)
      }
    }
  }
  return out
}

const titles = (items: readonly GraphItem[]) => items.map((item) => item.title).join('; ')

/** What the frame's limits leave unchecked for every option, as gaps. */
function limitGaps(plan: GraphShortlistPlan): string[] {
  return [
    ...(plan.limits.state === 'unreadable'
      ? [
          "the frame's hard limits could not be read as a list, so no option was checked against them"
        ]
      : []),
    ...(plan.unscreened.length
      ? [
          `${graphPlural(plan.unscreened.length, 'hard limit')} did not fit JEV's screen, so no option was checked against ${plan.unscreened.length === 1 ? 'it' : 'them'} (${plan.unscreened.join('; ')})`
        ]
      : [])
  ]
}

/**
 * Decide's narrowing, from JEV's screen of every option: an option it scores below the set-aside
 * line on any hard limit is dropped. Of the rest it keeps the best overall, then every option JEV
 * could not score in full (never ranked, never dropped), then each rubric line's leader and one
 * wildcard (the strongest single score left), then the next best, up to `limit`. Unscored options
 * that still do not fit make the shortlist inconclusive, as a gap. Pure, so the program, its
 * replay and the view agree.
 */
export function graphShortlist(
  where: string,
  items: readonly GraphItem[],
  outcome: GraphOutcome,
  limit: number,
  plan: GraphShortlistPlan,
  below: number = WORKFLOW_SCREEN_SET_ASIDE
): GraphShortlist {
  const screen = readFindScreen(outcome)
  if ('error' in screen) {
    const ordered = alternate(items).slice(0, limit)
    const unranked = `JEV could not screen the options (${screen.error}), so ${graphPlural(ordered.length, 'option')} went on in the order the models proposed them, alternating between models, and none was checked against the hard limits.`
    return { ordered, setAside: [], note: `${where}: ${unranked}`, unranked }
  }
  const hard = screen.criteria.slice(0, plan.limitLines)
  const lines = screen.criteria.slice(plan.limitLines)
  const known = (item: GraphItem) =>
    Number.isFinite(screen.scores[item.key]) &&
    hard.every((line) => Number.isFinite(line.scores[item.key]))
  const scored = items.map((item) =>
    Number.isFinite(screen.scores[item.key])
      ? { ...item, jev: { score: screen.scores[item.key]! } }
      : { ...item }
  )
  const unknown = scored.filter((item) => !known(item))
  const broke = (item: GraphItem) => hard.some((line) => line.scores[item.key]! < below)
  const dropped = scored.filter((item) => known(item) && broke(item))
  const rest = scored.filter((item) => known(item) && !broke(item))
  const byOverall = findBestFirst(rest, scored, (item) => item.jev!.score)
  const picks: { item: GraphItem; why: string }[] = []
  const add = (item: GraphItem | undefined, why: string) => {
    if (item && picks.length < limit && !picks.some((pick) => pick.item.key === item.key)) {
      picks.push({ item, why })
    }
  }
  add(byOverall[0], 'best overall')
  // An option JEV could not score may be the best: it is developed before optional picks.
  unknown.forEach((item) => add(item, 'not scored in full by JEV'))
  // The last place stays for the wildcard whenever the limit allows one.
  const leaders = limit > 2 ? limit - 1 : limit
  for (const line of lines) {
    if (picks.length < leaders) {
      const best = findBestFirst(rest, scored, (item) => line.scores[item.key] ?? -1)[0]
      add(best, `leads on ${line.label}`)
    }
  }
  const spike = (item: GraphItem) =>
    Math.max(-1, ...lines.map((line) => line.scores[item.key] ?? -1))
  const left = rest.filter((item) => !picks.some((pick) => pick.item.key === item.key))
  add(findBestFirst(left, scored, spike)[0], 'wildcard')
  byOverall.forEach((item) => add(item, 'next best'))
  const missed = unknown.filter((item) => !picks.some((pick) => pick.item.key === item.key))
  const gaps = [
    ...limitGaps(plan),
    ...(unknown.length
      ? [
          `JEV could not score ${graphPlural(unknown.length, 'option')} in full, so ${unknown.length === 1 ? 'it was' : 'they were'} neither ranked nor dropped${missed.length ? `; the shortlist is inconclusive: ${missed.length} of them did not fit and ${missed.length === 1 ? 'was' : 'were'} not developed (${titles(missed)})` : ''}`
        ]
      : [])
  ]
  const unranked = gaps.length ? `${gaps.join('. ')}.` : undefined
  const note = [
    `${where}: JEV screened ${graphPlural(items.length, 'option')}`,
    plan.limits.state === 'none'
      ? 'the frame named no hard limits, so none was dropped'
      : `${graphPlural(dropped.length, 'option')} broke a hard limit and ${dropped.length === 1 ? 'was' : 'were'} dropped${dropped.length ? ` (${titles(dropped)})` : ''}`,
    `the shortlist: ${picks.map((pick) => `${pick.item.title} (${pick.why})`).join('; ') || 'nothing'}${unranked ? `. ${unranked}` : '.'}`
  ].join('; ')
  return {
    ordered: picks.map((pick) => pick.item),
    setAside: [],
    note,
    ...(unranked ? { unranked } : {}),
    ...(picks.length
      ? {}
      : {
          empty: `Nothing to develop: JEV judged that all ${graphPlural(items.length, 'option')} break a hard limit.`
        })
  }
}
