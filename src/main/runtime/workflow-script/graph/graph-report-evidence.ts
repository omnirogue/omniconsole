import { graphEvidencePhrase } from './graph-evidence-pack'
import type { GraphItem } from './graph-items'
import { graphConfirmedResult, graphRefutedResult } from './graph-input-section'
import type { GraphInputBudget, GraphTargetView } from './graph-prompts'

/** Evidence kept per item: enough to rank and explain it, never whole reviews. */
const DETAIL_CHARS = 900
// Leave room for each merged report's separate evidence fields and verdict.
const VARIANT_CHARS = 240
const REASON_CHARS = 240
const TITLE_CHARS = 160

function fields(
  item: Pick<GraphItem, 'trigger' | 'excerpt' | 'fix'> & Partial<Pick<GraphItem, 'evidence'>>,
  budget: GraphInputBudget,
  label: string
): string[] {
  return [
    ['Trigger', item.trigger, 400],
    ['Quote source', item.evidence?.location, 1000],
    ['Checked excerpt', item.evidence?.excerpt, 1200],
    ['Excerpt', item.excerpt, 1200],
    ['Fix / next step', item.fix, 600]
  ].flatMap(([name, value, limit]) =>
    typeof value === 'string' && value
      ? [budget.take(`${label}, ${name}`, `${name}: ${clip(value, Number(limit))}`)]
      : []
  )
}

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit).trimEnd()} …` : text

/** A review's point: its first line of prose, with headings and markup stripped. */
export function graphReviewGist(markdown: string): string {
  const line = markdown
    .split('\n')
    .map((entry) =>
      entry
        .replace(/^[#>*\-\s]+/, '')
        .replace(/\*\*/g, '')
        .trim()
    )
    .find((entry) => entry.length > 20 && !/^verdict\b/i.test(entry))
  return clip(line ?? '', REASON_CHARS)
}

function head(item: GraphItem, index: number, keyed?: boolean): string {
  const severity = item.severity !== 'none' ? `[${item.severity}] ` : ''
  const where = item.location ? ` — ${item.location}` : ''
  const impact = item.impact
    ? ` · impact ${item.impact.score}/5 (${clip(item.impact.why, 120)})`
    : ''
  const jev = item.jev ? ` · JEV ${item.jev.score.toFixed(1)}/4` : ''
  const quote = graphEvidencePhrase(item.evidence)
  return `${index + 1}. ${keyed ? `[${item.key}] ` : ''}${severity}**${clip(item.title, TITLE_CHARS)}**${where}${impact}${jev}${quote ? ` · ${quote}` : ''}`
}

/** Says plainly that JEV, not a reviewer, confirmed it or set it aside, and at what probability. */
export function graphJevVerdictNote(
  target: Pick<GraphTargetView, 'confirmedBy' | 'refutedBy' | 'jevVerify' | 'setAsideAt'>
) {
  const p = `p ${target.jevVerify?.toFixed(2) ?? 'unknown'}`
  if (target.setAsideAt !== undefined) {
    return ` · JEV set it aside (p ${target.setAsideAt.toFixed(2)}) before a later report it never saw`
  }
  return target.confirmedBy === 'jev'
    ? ` · confirmed by JEV (${p}), not by a reviewer`
    : target.refutedBy === 'jev'
      ? ` · set aside by JEV (${p}), not refuted by a reviewer`
      : ''
}

/** A report merged into the item as the same one: it may still be a different claim. */
function variant(
  other: NonNullable<GraphItem['alsoReported']>[number],
  detail: boolean,
  legacy = false
): string {
  const where = other.location ? ` — ${other.location}` : ''
  const text =
    detail && other.detail
      ? `: ${clip(other.detail.replace(/\s+/g, ' '), legacy ? 300 : VARIANT_CHARS)}`
      : ''
  return `   also reported as: ${clip(other.title, TITLE_CHARS)}${where}${text}`
}

/** In a run that reads pages: the app's facts on their own line, what models wrote fenced after. */
function fencedEntry(
  target: GraphTargetView,
  index: number,
  gists: readonly string[],
  options: {
    budget: GraphInputBudget
    label: string
    detail: boolean
    notes: string
    keyed?: boolean
    legacy?: boolean
  }
): string {
  const { item } = target
  const jev = item.jev ? ` · JEV ${item.jev.score.toFixed(1)}/4` : ''
  const quote = graphEvidencePhrase(item.evidence)
  const votes = target.votes
    .map((vote) => `${vote.name} ${(vote.verdict ?? 'no answer').toUpperCase()}`)
    .join('; ')
  const facts = `${index + 1}. ${options.keyed ? `[${item.key}] ` : ''}${target.tally}${jev}${quote ? ` · ${quote}` : ''}${target.unchecked ? ' · not checked' : ` · reviewers: ${votes}`}${options.notes}`
  const severity = item.severity !== 'none' ? `[${item.severity}] ` : ''
  const impact = item.impact
    ? ` · impact ${item.impact.score}/5 (${clip(item.impact.why, 120)})`
    : ''
  const written = [
    `${severity}**${clip(item.title, TITLE_CHARS)}**${item.location ? ` — ${item.location}` : ''}${impact}`,
    ...gists,
    ...(options.detail ? [`   ${clip(item.detail, DETAIL_CHARS).replace(/\n+/g, '\n   ')}`] : [])
  ]
  const merged = (item.alsoReported ?? []).flatMap((other, at) => [
    options.budget.take(
      `${options.label}, merged report ${at + 1}`,
      variant(other, options.detail, options.legacy)
    ),
    ...(!options.legacy && options.detail
      ? fields(other, options.budget, `${options.label}, merged report ${at + 1}`)
      : [])
  ])
  const kept = options.budget.take(options.label, written.join('\n'))
  return [
    facts,
    options.budget.fence(
      [
        kept,
        ...(!options.legacy && options.detail ? fields(item, options.budget, options.label) : []),
        ...merged
      ].join('\n')
    )
  ].join('\n')
}

/**
 * The review step's results as compact structured evidence, for a step that screens or escalates:
 * checked items with a capped detail and one line per reviewer, the rest one line each. An item's
 * entry (identifying line, reasons, then detail) and each merged report are budgeted inputs of
 * their own, so a cut shortens detail but never loses an item or a merged claim.
 */
export function renderGraphReportEvidence(
  title: string,
  targets: readonly GraphTargetView[],
  budget: GraphInputBudget,
  options: { oneReview?: boolean; keyed?: boolean; legacy?: boolean } = {}
): string {
  const entry = (target: GraphTargetView, index: number, detail: boolean) => {
    const votes = target.votes
      .map((vote) => `${vote.name} ${(vote.verdict ?? 'no answer').toUpperCase()}`)
      .join('; ')
    // A single passing review is weaker evidence than two; the report must say which it is.
    const single =
      options.oneReview &&
      target.tally === 'confirmed' &&
      target.votes.filter((vote) => vote.verdict).length === 1
    const gists = target.votes
      .filter((vote) => vote.markdown)
      .map((vote) => `   > ${vote.name}: ${graphReviewGist(vote.markdown!)}`)
    const notes = `${single ? ' · confirmed by one review' : ''}${options.oneReview && target.sameFamilyOnly ? " · passed only by reviewers from its finders' own model families" : ''}${graphJevVerdictNote(target)}`
    const lines = [
      `${head(target.item, index, options.keyed)}${target.unchecked ? '' : ` · reviewers: ${votes}`}${notes}`,
      ...gists,
      ...(detail ? [`   ${clip(target.item.detail, DETAIL_CHARS).replace(/\n+/g, '\n   ')}`] : [])
    ]
    const label = `${title}, item ${target.item.key}`
    if (budget.fencing) {
      return fencedEntry(target, index, gists, { ...options, budget, label, detail, notes })
    }
    return [
      budget.take(label, lines.join('\n')),
      ...(!options.legacy && detail ? fields(target.item, budget, label) : []),
      ...(!options.legacy ? [budget.take(`${label}, verdict`, `Verdict: ${target.tally}`)] : []),
      ...(target.item.alsoReported ?? []).flatMap((other, at) => [
        budget.take(`${label}, merged report ${at + 1}`, variant(other, detail, options.legacy)),
        ...(!options.legacy && detail
          ? fields(other, budget, `${label}, merged report ${at + 1}`)
          : [])
      ])
    ].join('\n')
  }
  const block = (heading: string, list: readonly GraphTargetView[], detail: boolean) =>
    list.length
      ? [
          `### ${heading} (${list.length})`,
          ...list.map((target, index) => entry(target, index, detail))
        ].join(detail ? '\n\n' : '\n')
      : ''
  // A resurfaced item shows once, under its own heading with the later report's detail.
  const checked = (tally: GraphTargetView['tally']) =>
    targets.filter((target) => !target.unchecked && !target.resurfaced && target.tally === tally)
  // JEV-decided items show only under Confirmed or Refuted, even the ones no reviewer saw.
  const byJev = (target: GraphTargetView) =>
    target.confirmedBy === 'jev' || target.refutedBy === 'jev'
  const notReviewed = (target: GraphTargetView) =>
    target.unchecked && !target.screened && !target.resurfaced && !byJev(target)
  const dropped = (target: GraphTargetView) => !!target.item.evidence?.preVerify?.dropped
  return [
    `## ${title}`,
    block('Confirmed', targets.filter(graphConfirmedResult), true),
    block('Unverified after review', checked('unverified'), true),
    block('Refuted', targets.filter(graphRefutedResult), false),
    block(
      'Unverified: reported again after JEV set it aside, not checked',
      targets.filter((target) => target.resurfaced && target.unchecked && !byJev(target)),
      true
    ),
    block(
      'Unverified after review: reported again after JEV set it aside',
      targets.filter((target) => target.resurfaced && !target.unchecked && !byJev(target)),
      true
    ),
    block(
      'Not checked, over the verification limit',
      targets.filter((target) => notReviewed(target) && !dropped(target)),
      false
    ),
    block(
      'Not checked, dropped before review: no file it cites exists',
      targets.filter((target) => notReviewed(target) && dropped(target)),
      false
    ),
    block(
      'Set aside by JEV as non-findings',
      targets.filter((target) => target.screened && !byJev(target)),
      false
    )
  ]
    .filter(Boolean)
    .join('\n\n')
}
