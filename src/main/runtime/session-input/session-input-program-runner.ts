/** Executes one submitted program inside a queue item's cancel-gated context. */

import type { SessionInputProgram } from '../../../shared/session-input-program'
import type { SessionInputDeliveryContext } from './session-input-delivery-context'

export async function runSessionInputProgram(
  program: SessionInputProgram,
  ctx: SessionInputDeliveryContext
): Promise<void> {
  for (const step of program.steps) {
    ctx.assertActive()
    if (step.kind === 'pause') {
      await ctx.pause(step.ms)
      continue
    }
    if (step.kind === 'clear-confirm') {
      await ctx.pause(step.afterMs)
      // Why: the host cannot read the client's input line, so the clear counts as
      // unobserved and widens — the branch the client itself took when its probe
      // could not answer. An overshooting clear burst is a no-op on an empty line.
      await writeStep(ctx, step.widenTo)
      continue
    }
    await writeStep(ctx, step.data)
  }
}

async function writeStep(ctx: SessionInputDeliveryContext, data: string): Promise<void> {
  if (!(await ctx.write(data))) {
    throw new Error('terminal_not_writable')
  }
}
