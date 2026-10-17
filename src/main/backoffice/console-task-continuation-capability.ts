import { z } from 'zod'
import type { ConsoleTaskContinuationCapability } from '../../shared/console-local-execution'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { taskId } from '../../shared/console-workflow-schemas'
import { getNativeLocalPtyProvider } from '../ipc/pty/provider/registry'
import { requestConsoleWorkflow, validated } from './console-workflow-transport'

const capabilityRequest = z.object({ taskId: taskId.optional() }).strict()

const capabilityResponse = z.object({
  ok: z.literal(true),
  task_continuation: z.object({
    available: z.boolean(),
    openrouter_routing: z.boolean().optional(),
    reason: z.string().max(1500).optional()
  })
})

/** Never infer task admission from installed CLIs or older local-execution methods. */
export async function readConsoleTaskContinuationCapability(
  args?: { taskId?: string },
  expectedPrincipal?: string
): Promise<ConsoleWorkflowResult<ConsoleTaskContinuationCapability>> {
  return validated(args ?? {}, capabilityRequest, async (input) => {
    if (getNativeLocalPtyProvider().supportsLaunchGateObservation?.() !== true) {
      return {
        ok: true,
        data: {
          available: false,
          reason: 'This execution host cannot verify the held process birth and exit.'
        }
      }
    }
    const query = input.taskId ? `?task_id=${input.taskId}` : ''
    const result = await requestConsoleWorkflow(
      `/api/gtd/task-continuation/capabilities${query}`,
      'GET',
      capabilityResponse,
      undefined,
      15_000,
      false,
      expectedPrincipal
    )
    return result.ok ? { ok: true, data: result.data.task_continuation } : result
  })
}
