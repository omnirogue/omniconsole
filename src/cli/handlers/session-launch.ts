import { getRequiredStringFlag } from '../flags'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { getDefaultUserDataPath, RuntimeClientError } from '../runtime-client'
import { withLaunchClaim } from '../session-launch-claim'
import { launchIntentInputs, launchIntentKey } from '../session-launch-intent'
import { agentLaunchRecordStore } from '../session-launch-record'
import { completeLaunch } from './session-launch-complete'
import { readLaunchInput, type LaunchInput } from './session-launch-input'
import { runPlacedLaunch } from './session-launch-placement'
import { planSessionLaunch } from './session-launch-plan'
import { formatLaunchPlan, type LaunchPlanView } from './session-launch-receipt'
import { prepareLaunchOperation, type LaunchContext } from './session-launch-send'

// Why: a dry run exits 0 for these, reporting what the real launch would refuse.
const WOULD_REFUSE_CODES = new Set(['incompatible_runtime', 'agent_session_host_mismatch'])

async function printLaunchDryRun(
  ctx: Pick<HandlerContext, 'flags' | 'client' | 'cwd' | 'json'>,
  input: LaunchInput
): Promise<void> {
  let plan: Awaited<ReturnType<typeof planSessionLaunch>>
  try {
    plan = await planSessionLaunch(ctx, input, { preview: true })
  } catch (error) {
    if (!(error instanceof RuntimeClientError) || !WOULD_REFUSE_CODES.has(error.code)) {
      throw error
    }
    const wouldRefuse = { code: error.code, message: error.message, data: error.data }
    printResult(
      {
        id: 'dry-run',
        ok: true,
        result: { launched: false, operationId: null, wouldRefuse },
        _meta: { runtimeId: 'unknown' }
      },
      ctx.json,
      () => `Would refuse: ${error.message}\n  Nothing launched.`
    )
    return
  }
  const account = plan.readiness?.account ?? null
  const view: LaunchPlanView = {
    launched: false,
    operationId: null,
    host: plan.host,
    workspace: plan.workspace,
    account,
    launch: {
      model: input.model ?? null,
      effort: input.effort ?? null,
      source: input.model || input.effort ? 'request' : 'host-default'
    },
    wouldRefuse:
      account && !account.verified
        ? {
            code: 'agent_session_account_unverified',
            message: account.refusal,
            data: { accounts: account.accounts }
          }
        : null,
    manifest: plan.manifest,
    project: plan.project?.report ?? null,
    warnings: plan.project?.warnings ?? []
  }
  printResult(
    { id: 'dry-run', ok: true, result: view, _meta: { runtimeId: plan.status.runtimeId } },
    ctx.json,
    (value) => formatLaunchPlan(value, input.provider)
  )
}

export const SESSION_LAUNCH_HANDLERS: Record<string, CommandHandler> = {
  'session launch-inspect': async ({ client, flags, json }) => {
    const operationId = getRequiredStringFlag(flags, 'operation-id')
    const response = await client.call<Record<string, unknown>>(
      'terminal.inspectAgentSessionLaunch',
      { operationId }
    )
    printResult(response, json, (result) => JSON.stringify(result, null, 2))
  },
  'session launch': async (context) => {
    // Why not destructure `client`: its getter builds the routed client from ambient selectors,
    // which --project never uses, so a stale ORCA_ENVIRONMENT must not refuse placement.
    const { flags, cwd, json } = context
    const input = await readLaunchInput(flags, cwd)
    if (input.project) {
      await runPlacedLaunch({ flags, cwd, json }, input)
      return
    }
    const { client } = context
    if (client.isRemote && flags.has('agent-template')) {
      // Why: a remote launch stays in the background on the host, so no tab would carry the record.
      throw new RuntimeClientError(
        'invalid_argument',
        '--agent-template is recorded only by a local controller; run this on the controller or omit it.'
      )
    }
    if (input.dryRun) {
      // Why: a preview takes no claim, writes no record and mints no operation.
      await printLaunchDryRun({ flags, client, cwd, json }, input)
      return
    }
    const store = agentLaunchRecordStore(getDefaultUserDataPath())
    const ctx: LaunchContext = {
      flags,
      client,
      cwd,
      input,
      store,
      intentKey: launchIntentKey(launchIntentInputs(flags, cwd, input.prompt))
    }
    const prepared = await withLaunchClaim(store, ctx.intentKey, () => prepareLaunchOperation(ctx))
    await completeLaunch(ctx, prepared, { json })
  }
}
