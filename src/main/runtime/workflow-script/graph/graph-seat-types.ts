import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'

/** Seat rules (graph-seat-substitution.ts), frozen at admission; absent on older runs. */
export type GraphSeatFields = {
  seatRules?: number
  /** Other accounts of a seat's family a call that failed at launch may move to. */
  spareSeats?: ResolvedLocalWorkflowSeat[]
  /** Seats whose account capacity was not verified when the run started. */
  seatNotes?: string[]
}

/** Calls a run lost that no other seat could take, and the steps that lost them. */
export type GraphDegraded = { lostCalls: number; steps: string[] }

/** A call run again on `seatId` as `callId` after it failed at launch (`reason`). */
export type GraphSubstitution = {
  seatId: string
  callId: string
  from: string
  to: string
  reason: string
}
