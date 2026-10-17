import type { GraphItem } from './graph-items'
import type { GraphTally, GraphVerdict } from './graph-parse'
import type { GraphWebCheck } from './graph-web-citation-marks'

/** A reviewed for-each item: its votes, their texts and the tally they reach. */
export type GraphTarget = {
  item: GraphItem
  votes: (GraphVerdict | null)[]
  texts: (string | null)[]
  /** The agent index behind each vote, when not simply its position (one review, escalated). */
  voters?: number[]
  tally: GraphTally
  /** Over the for-each limit: never sent to a reviewer, carried on as unverified. */
  unchecked?: true
  /** Unchecked because JEV scored it a non-finding (graph-triage.ts), not for want of room. */
  screened?: true
  /** Set aside by JEV, then reported again in a later round: JEV never saw that report. */
  resurfaced?: true
  /** Resurfaced after live JEV verify set it aside at this probability. */
  setAsideAt?: number
  /** Cross-family: a reviewer of a family other than every finder's passed it. */
  crossChecked?: true
  /** Cross-family: only reviewers of a finder's family passed it, so it stays unverified. */
  sameFamilyOnly?: true
  /** A run that reads pages: the app's checks of the item's quotes, from the pages it kept. */
  webChecks?: GraphWebCheck[]
  /** Page-fed and passed, but the app found none of its quotes: it stays unverified. */
  webUnbacked?: true
  /** JEV verify: its probability that the item is a real defect; shadow runs never read it. */
  jevVerify?: number
  /** Live JEV verify confirmed it (p >= confirmAt) after the reviewers left it unverified. */
  confirmedBy?: 'jev'
  /** Live JEV verify set it aside (refuted at p <= rejectAt) once reviewers left it unverified. */
  refutedBy?: 'jev'
}
