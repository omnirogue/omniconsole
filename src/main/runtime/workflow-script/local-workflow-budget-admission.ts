import type { AgentBudgetClient } from './agent-budget-client'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import {
  WORKFLOW_BUDGET_CALL_BOUNDS,
  WORKFLOW_BUDGET_ROUTES,
  type WorkflowBudgetSnapshot
} from './workflow-call-budget'

/**
 * At Start: the root this run spends, read from the authority and frozen into its snapshot, or a
 * refusal by name. Only an operator opens a root (owner, ceiling, approval); a Start can only
 * name one. While this computer enforces budgets every Start must name an open root.
 */
export async function admitWorkflowBudget(input: {
  rootId?: string
  snapshot: Pick<LocalWorkflowHostSnapshot, 'seats' | 'graph' | 'capability'>
  authority?: AgentBudgetClient
}): Promise<WorkflowBudgetSnapshot | undefined> {
  if (!input.rootId) {
    if (input.authority) {
      throw new Error(
        'This computer enforces agent budgets: start the run with --budget-root <id>, an approved budget root.'
      )
    }
    return undefined
  }
  if (!input.authority) {
    throw new Error('This computer has no agent budget authority, so a budgeted run cannot start.')
  }
  const root = await input.authority.view(input.rootId)
  if (!root) {
    throw new Error('That budget root is unknown here, or the budget authority cannot be reached.')
  }
  if (root.state !== 'open') {
    throw new Error(`That budget root is ${root.state}: nothing more can be spent from it.`)
  }
  if (input.snapshot.capability?.mode === 'working-agent') {
    throw new Error('Working-agent runs cannot be held to a budget yet.')
  }
  const seats = [...input.snapshot.seats, ...(input.snapshot.graph?.spareSeats ?? [])]
  const unsupported = [...new Set(seats.map((seat) => seat.agent))].filter(
    (route) => !WORKFLOW_BUDGET_ROUTES.has(route)
  )
  if (unsupported.length) {
    throw new Error(
      `A budgeted run can use Claude seats only; ${unsupported.join(', ')} cannot be held to a reservation yet. Start it with --routes claude.`
    )
  }
  return {
    rootId: root.root_id,
    benchmark: root.kind === 'benchmark',
    ...WORKFLOW_BUDGET_CALL_BOUNDS
  }
}
