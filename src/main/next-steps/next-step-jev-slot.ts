// Where `nextSteps.linkTask` finds this host's JEV pass; type-only, so the RPC layer stays light.
import type { NextStepJev } from './next-step-jev'

let current: NextStepJev | null = null

export function getNextStepJev(): NextStepJev | null {
  return current
}

export function setNextStepJev(next: NextStepJev | null): void {
  current = next
}
