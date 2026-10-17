import { withinRoutineSlackDeadline } from './routine-slack-deadline'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import { requestConsoleWorkflow } from '../backoffice/console-workflow-transport'
import {
  routineSlackChannelSchema,
  routineSlackPayloadSchema,
  routineSlackResultSchema,
  routineSlackStatusSchema,
  type RoutineSlackChannel,
  type RoutineSlackPayload,
  type RoutineSlackResult,
  type RoutineSlackStatus
} from '../../shared/routine-alert-contract'

const path = '/api/gtd/hub/api/routine-alerts/slack'
export class HubSlackClient {
  private cache:
    | { principal: string; baseUrl: string; expires: number; channels: RoutineSlackChannel[] }
    | undefined

  async status(): Promise<RoutineSlackStatus> {
    try {
      return await withinRoutineSlackDeadline(async (signal) => {
        const result = await requestConsoleWorkflow(
          `${path}/status`,
          'GET',
          routineSlackStatusSchema,
          undefined,
          10_000,
          false,
          undefined,
          undefined,
          signal
        )
        return result.ok
          ? result.data
          : { authenticated: false, connection: null, error: result.error.message }
      })
    } catch {
      return {
        authenticated: false,
        connection: null,
        error: 'Slack status is unavailable. Refresh to try again.'
      }
    }
  }

  async listChannels(refresh = false): Promise<RoutineSlackChannel[]> {
    return withinRoutineSlackDeadline(async (signal) => {
      const captured = await captureConsoleWorkflowPerson()
      if (!captured.ok) {
        throw new Error(captured.error.message)
      }
      const { principal, baseUrl, isCurrent } = captured.data
      if (
        !refresh &&
        this.cache?.principal === principal &&
        this.cache.baseUrl === baseUrl &&
        this.cache.expires > Date.now() &&
        isCurrent()
      ) {
        return this.cache.channels
      }
      this.cache = undefined
      const result = await requestConsoleWorkflow(
        `${path}/channels`,
        'GET',
        routineSlackChannelSchema.array(),
        undefined,
        10_000,
        false,
        principal,
        isCurrent,
        signal
      )
      if (!result.ok) {
        throw new Error(result.error.message)
      }
      this.cache = { principal, baseUrl, expires: Date.now() + 600_000, channels: result.data }
      return result.data
    })
  }

  /** No retry: an uncertain answer may already have posted. The hub records the run's attempt. */
  async send(
    payload: RoutineSlackPayload,
    person?: Extract<Awaited<ReturnType<typeof captureConsoleWorkflowPerson>>, { ok: true }>['data']
  ): Promise<RoutineSlackResult> {
    try {
      const input = routineSlackPayloadSchema.safeParse(payload)
      if (!input.success) {
        return { ok: false, error: 'The Slack destination or message is invalid.' }
      }
      const result = await withinRoutineSlackDeadline((signal) =>
        requestConsoleWorkflow(
          `${path}/send`,
          'POST',
          routineSlackResultSchema,
          input.data,
          10_000,
          false,
          person?.principal,
          person?.isCurrent,
          signal
        )
      )
      return result.ok ? result.data : { ok: false, error: result.error.message }
    } catch {
      return {
        ok: false,
        error: 'Slack delivery could not be confirmed. Check the hub delivery receipt.'
      }
    }
  }
}
export const hubSlackClient = new HubSlackClient()
