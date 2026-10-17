import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

type WorkBindReply =
  | {
      ok: true
      workItem: string
      binding: { routineRef?: string; title?: string; conversationId?: string }
    }
  | { ok: false; reason: string }

export const WORK_HANDLERS: Record<string, CommandHandler> = {
  'work bind': async ({ client, flags, json }) => {
    const jira = getRequiredStringFlag(flags, 'jira')
    const routine = getOptionalStringFlag(flags, 'routine')
    const ref = getOptionalStringFlag(flags, 'session')
    const paneKey =
      getOptionalStringFlag(flags, 'pane') ??
      (routine || ref ? undefined : process.env.ORCA_PANE_KEY?.trim())
    const prs = getOptionalStringFlag(flags, 'pr')
    const prNumbers = prs?.split(',').map((value) => Number(value.trim().replace(/^#/, '')))
    if (prNumbers?.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--pr takes pull request numbers, like 635,640.'
      )
    }
    if (!routine && !ref && !paneKey) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Name --pane, --session or --routine, or run it inside the session to bind.'
      )
    }
    const result = await client.call<WorkBindReply>('work.bind', {
      jira,
      ...(routine ? { routine } : {}),
      ...(ref ? { ref } : {}),
      ...(paneKey ? { paneKey } : {}),
      ...(prNumbers?.length ? { prNumbers } : {})
    })
    printResult(result, json, (reply) =>
      reply.ok
        ? `${reply.workItem} is bound to ${reply.binding.routineRef ? `the routine ${reply.binding.routineRef}` : `“${reply.binding.title ?? ''}” (conversation ${reply.binding.conversationId ?? '?'})`}. A human comment on it now wakes that owner.`
        : `Not bound: ${reply.reason}`
    )
  }
}
