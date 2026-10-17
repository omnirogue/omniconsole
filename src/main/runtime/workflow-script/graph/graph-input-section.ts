import type { GraphItem } from './graph-items'
import type { GraphStanding, GraphTally, GraphVerdict } from './graph-parse'

/** The inputs one step hands the prompts of the steps that read it. */
export type GraphText = { label: string; name: string; markdown: string }
export type GraphReviewText = GraphText & { verdict: GraphVerdict | null }
export type GraphTargetView = {
  item: GraphItem
  tally: GraphTally
  unchecked?: boolean
  /** Set aside by a JEV screen as a non-finding. */
  screened?: boolean
  /** Set aside, then reported again in a later round: unverified, never rejected. */
  resurfaced?: boolean
  /** Resurfaced after live JEV verify set it aside at this probability. */
  setAsideAt?: number
  /** Only reviewers from its finders' own families passed it (cross-family steps). */
  sameFamilyOnly?: boolean
  /** Live JEV verify confirmed it after the reviewers left it unverified, at `jevVerify`. */
  confirmedBy?: 'jev'
  /** Live JEV verify set it aside (refuted) after the reviewers left it unverified. */
  refutedBy?: 'jev'
  jevVerify?: number
  votes: { name: string; verdict: GraphVerdict | null; markdown?: string }[]
}

/** A confirmed result: a reviewer's, or live JEV's even where no reviewer saw it. */
export const graphConfirmedResult = (
  target: Pick<GraphTargetView, 'tally' | 'unchecked' | 'confirmedBy'>
): boolean => target.tally === 'confirmed' && (!target.unchecked || target.confirmedBy === 'jev')

/** A refuted result: a reviewer's, or live JEV's even where no reviewer saw it. */
export const graphRefutedResult = (target: GraphTargetView): boolean =>
  target.tally === 'refuted' && (!target.unchecked || target.refutedBy === 'jev')

/** What a step hands its consumers, in the form each prompt section renders. */
/** `web`: a reader's sources by host and path, for the steps that read its answers. */
export type GraphInputSection =
  | { kind: 'texts'; title: string; texts: GraphText[]; web?: string }
  | { kind: 'items'; title: string; items: GraphItem[]; web?: string; legacy?: true }
  | { kind: 'reviews'; title: string; reviews: GraphReviewText[]; approved?: boolean }
  /**
   * `compact`: the step screens or escalates, so later prompts get compact evidence.
   * `oneReview`: say which results only one review confirmed (steps whose spec asks for it).
   * `keyed`: each result shows its key, for a write-up that ranks them.
   */
  | {
      kind: 'targets'
      title: string
      targets: GraphTargetView[]
      compact?: true
      legacy?: true
      oneReview?: true
      keyed?: true
    }
  | {
      kind: 'ranking'
      title: string
      standings: (GraphStanding & { name: string })[]
      ballots: GraphText[]
    }
