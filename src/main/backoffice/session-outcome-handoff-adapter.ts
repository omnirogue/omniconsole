import { z } from 'zod'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { installSessionOutcomeHandoffReader } from '../runtime/session-outcome-external-evidence'
import { installSessionOutcomeHandoffTransport } from '../runtime/session-outcome-handoff'
import { consoleHandoffClient } from './console-handoff-client'
import { installSessionHandoffSource } from '../runtime/session-handoff-source'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { uploadHandoffFile } from './console-handoff-files'
import { getConsolePublicationPrincipal } from './console-workflow-person'
import { installSessionOutcomeAgentReader } from '../runtime/session-outcome-agent-evidence'
import {
  installSessionOutcomePullRequestReader,
  installSessionOutcomeWaitFactsReader
} from '../runtime/session-outcome-event-evidence'
import { readConsoleWaitFacts } from './console-waits-client'
import { publishSessionWaits } from './console-session-waits'
import { installSessionOutcomeWaitsListener } from '../runtime/session-outcome-waits-listener'
import { readSessionPullRequestFacts } from '../github/session-pull-request-facts'

class OutcomeHandoffTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}
function data<T>(result: ConsoleWorkflowResult<T>): T {
  if (!result.ok) {
    throw new OutcomeHandoffTransportError(
      result.error.code,
      result.error.message,
      result.error.status
    )
  }
  return result.data
}

type HandoffSourceRuntime = Pick<
  OrcaRuntimeService,
  'listSessionChains' | 'getSessionOutcomeTranscriptSource'
>

/** The existing signed-person allowlisted transport remains the sole authority for delivery. */
export function installSessionOutcomeHandoffAdapter(runtime?: HandoffSourceRuntime): void {
  if (runtime) {
    // Why: a rule does not name its conversation; the chain that carries its request key does.
    installSessionHandoffSource((rule) => {
      const keys = new Set(
        [...rule.recipients, ...(rule.agentRecipients ?? [])].map((person) => person.operationId)
      )
      const chain = runtime
        .listSessionChains()
        .find((candidate) =>
          candidate.steps.some(
            (step) =>
              step.kind === 'handoff' &&
              [...step.handoff.recipients, ...(step.handoff.agentRecipients ?? [])].some((person) =>
                keys.has(person.operationId)
              )
          )
        )
      return chain
        ? { chainId: chain.id, answerSource: runtime.getSessionOutcomeTranscriptSource(chain) }
        : undefined
    })
  }
  installSessionOutcomeAgentReader(consoleHandoffClient)
  installSessionOutcomeHandoffReader(consoleHandoffClient.get)
  // Conversational waits: omnios answers "has it happened yet?"; this engine decides what then.
  installSessionOutcomeWaitFactsReader(readConsoleWaitFacts)
  installSessionOutcomePullRequestReader(readSessionPullRequestFacts)
  // CONTRACT §3: omnios shows the same waits list in the session detail and Decisions digest.
  installSessionOutcomeWaitsListener(publishSessionWaits)
  installSessionOutcomeHandoffTransport({
    principal: getConsolePublicationPrincipal,
    recipients: async () => data(await consoleHandoffClient.recipients()).employees,
    hub: {
      get: async (input) => data(await consoleHandoffClient.get(input)),
      respond: async (input) => data(await consoleHandoffClient.respond(input)),
      returnFile: async (input) => data(await consoleHandoffClient.returnFile(input)),
      agentRecipients: async () => data(await consoleHandoffClient.agentRecipients()),
      sendAgent: async (input) => data(await consoleHandoffClient.sendAgent(input)),
      upload: async (taskId, file) =>
        z
          .object({ path: z.string(), sha256: z.string() })
          .parse(data(await uploadHandoffFile({ taskId, file }))),
      send: async (input) => data(await consoleHandoffClient.send(input)),
      sendCardless: async (input) => data(await consoleHandoffClient.sendCardless(input)),
      uploadThreadFile: async (input) => data(await consoleHandoffClient.uploadThreadFile(input)),
      isRejected: (error) =>
        error instanceof OutcomeHandoffTransportError &&
        Boolean(
          error.status &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408 &&
          error.status !== 429
        )
    }
  })
}
