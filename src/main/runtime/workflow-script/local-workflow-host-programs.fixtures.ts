import type { WorkflowProgramCall, WorkflowProgramContext } from './workflow-program-context'

/**
 * Stand-ins for the Council revision 6 and Discover revision 7 programs, which their own packages
 * own and test. Host tests need only a deterministic program that phases, logs and calls seats.
 */
const answerSchema: WorkflowProgramCall['schema'] = {
  type: 'object',
  properties: { markdown: { type: 'string' } },
  required: ['markdown']
}

function call(id: string, seatId: string, prompt: string): WorkflowProgramCall {
  return {
    id,
    seatId,
    prompt,
    schema: answerSchema,
    dependencies: [],
    validateSemantics: () => null
  }
}

export async function fakeCouncilProgram(
  context: WorkflowProgramContext,
  config: { memberIds: string[]; chairId: string },
  task: { prompt: string }
): Promise<unknown> {
  context.phase('First opinions')
  context.log(`Asking ${config.memberIds.length} members`)
  await context.parallel(
    config.memberIds.map(
      (seatId) => () => context.agent(call(`answer/${seatId}`, seatId, task.prompt))
    )
  )
  context.phase('Chairman')
  return context.agent(call('chair/final', config.chairId, `Conclude: ${task.prompt}`))
}

export async function fakeDiscoverProgram(
  context: WorkflowProgramContext,
  config: { rankerId: string },
  task: { prompt: string }
): Promise<unknown> {
  context.phase('Rank')
  return context.agent(call('rank/final', config.rankerId, task.prompt))
}

export function fakeFinalMarkdown(value: unknown): string | undefined {
  return value && typeof value === 'object' && 'markdown' in value
    ? String(value.markdown)
    : undefined
}
