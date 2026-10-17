import { describe, expect, it } from 'vitest'
import {
  decideCouncilFinalCheck,
  type CouncilFinalCheckJudgment
} from './workflow-council-final-check'

// decideCouncilFinalCheck is the seam: a future JEV NOUL decider can replace this pure function
// (no graph-runtime types, no I/O) behind a new optional spec field without touching the graph
// step or the renderer. A consumer must be able to ship purely off `winner` — `decisive` only
// changes the note — so every row here checks `winner` is never 'defender' unless a vote
// actually put the first opinion ahead.
const base: CouncilFinalCheckJudgment = {
  decisiveVotes: true,
  defenderWon: false,
  unjudged: false,
  modelVoted: false,
  jevUnsure: false,
  everyPairJudged: true,
  jevFailed: false
}

describe('decideCouncilFinalCheck', () => {
  it('decisive win: the chairman keeps it when the defender did not win', () => {
    const verdict = decideCouncilFinalCheck(base)
    expect(verdict).toEqual({
      winner: 'challenger',
      decisive: true,
      reason: "The chairman's answer was judged better.",
      judgedBy: ['jev']
    })
  })

  it('decisive win: the first opinion ships when the defender won', () => {
    const verdict = decideCouncilFinalCheck({ ...base, defenderWon: true })
    expect(verdict).toEqual({
      winner: 'defender',
      decisive: true,
      reason: 'The best first opinion was judged better.',
      judgedBy: ['jev']
    })
  })

  it('tie: keeps the chairman, winner is challenger (never defender), no judge credited', () => {
    const verdict = decideCouncilFinalCheck({ ...base, decisiveVotes: false })
    expect(verdict).toEqual({
      winner: 'challenger',
      decisive: false,
      reason: "The comparison was not decisive, so the chairman's answer was kept.",
      judgedBy: []
    })
  })

  it('tie: even when the defender would have won the raw vote, winner still stays challenger', () => {
    const verdict = decideCouncilFinalCheck({ ...base, decisiveVotes: false, defenderWon: true })
    expect(verdict.winner).toBe('challenger')
    expect(verdict.decisive).toBe(false)
  })

  it('reports both jev and models when JEV was unsure and a model judge settled it', () => {
    const verdict = decideCouncilFinalCheck({
      ...base,
      defenderWon: true,
      jevUnsure: true,
      modelVoted: true
    })
    expect(verdict.judgedBy).toEqual(['jev', 'models'])
    expect(verdict.winner).toBe('defender')
    expect(verdict.decisive).toBe(true)
  })

  it('JEV unsure with no model judge able to settle it: not decisive, no judge credited', () => {
    const verdict = decideCouncilFinalCheck({
      ...base,
      jevUnsure: true,
      everyPairJudged: false
    })
    expect(verdict).toEqual({
      winner: 'challenger',
      decisive: false,
      reason: "The comparison was not decisive, so the chairman's answer was kept.",
      judgedBy: []
    })
  })

  it('unjudged fallback: not decisive, "could not be settled", no judge credited', () => {
    const verdict = decideCouncilFinalCheck({ ...base, unjudged: true })
    expect(verdict).toEqual({
      winner: 'challenger',
      decisive: false,
      reason: "The comparison could not be settled, so the chairman's answer was kept.",
      judgedBy: []
    })
  })

  it('credits only models when JEV produced no ballot at all (failed, not unsure)', () => {
    const verdict = decideCouncilFinalCheck({
      ...base,
      defenderWon: true,
      modelVoted: true,
      jevUnsure: false,
      jevFailed: true
    })
    expect(verdict.judgedBy).toEqual(['models'])
    expect(verdict.winner).toBe('defender')
    expect(verdict.decisive).toBe(true)
  })

  it('never credits JEV when it failed, even alongside an unsure flag left stale', () => {
    // Defensive: jevFailed always wins over jevUnsure for attribution, since a failed JEV
    // produced no ballot to be unsure about.
    const verdict = decideCouncilFinalCheck({
      ...base,
      defenderWon: false,
      modelVoted: true,
      jevUnsure: true,
      jevFailed: true
    })
    expect(verdict.judgedBy).toEqual(['models'])
  })
})
