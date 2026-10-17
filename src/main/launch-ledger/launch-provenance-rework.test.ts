import { describe, expect, it } from 'vitest'
import { normalizeLaunchCause, LAUNCH_REFERENCE_KEYS } from '../../shared/launch-cause'
import { recordLaunch, findLaunchRecord } from './launch-ledger'
import { registerLaunchLedgerTestDirectory } from './launch-ledger-test-directory'
import { rpcTerminalLaunchCause } from '../runtime/rpc/terminal-launch-cause'

const uuid = '11111111-1111-4111-8111-111111111111'
const paneKey = `${uuid}:${uuid}`
const readRows = registerLaunchLedgerTestDirectory()
describe('reviewed launch provenance boundaries', async () => {
  it.each([
    'OPENAI_API_KEY=sk-example',
    'claude --resume secret',
    'sk-secret-value',
    'private_prompt_text'
  ])('drops private values even under allowed identifier keys: %s', (value) => {
    const reference = Object.fromEntries(LAUNCH_REFERENCE_KEYS.map((key) => [key, value]))
    expect(
      normalizeLaunchCause({
        trigger: 'cli',
        reference,
        requestId: value,
        parentPaneKey: value,
        actor: { kind: 'local-cli', deviceId: value, paneKey: value, terminalHandle: value }
      })
    ).toEqual({ trigger: 'cli', actor: { kind: 'local-cli' } })
  })
  it('retains the real creator identifier formats', async () => {
    const reference = {
      automationId: uuid,
      automationRunId: uuid,
      orchestrationTaskId: 'task_123456789abc',
      orchestrationDispatchId: 'ctx_123456789abc',
      orchestrationRunId: 'run_123456789abc',
      outcomeChainId: 'chn_123456789abc',
      workflowRunId: 'lrn_123456789abc',
      recoveryId: `capacity-recovery:${'a'.repeat(64)}`,
      transferId: uuid,
      sessionPrepBatchId: 'sp_mftz1234abcdef',
      agentSessionId: uuid,
      buildReviewRunId: 'brp_123456789abc',
      consoleJobId: 'job_local12345'
    }
    expect(normalizeLaunchCause({ trigger: 'automation', reference })).toEqual({
      trigger: 'automation',
      reference
    })
  })
  it('labels caller pane and handle claims as unverified', async () => {
    const cause = rpcTerminalLaunchCause({
      pairedDeviceId: uuid,
      clientKind: 'runtime',
      requestId: uuid,
      orchestrationCompatibilityEvidence: { paneKey, terminalHandle: `term_${uuid}` }
    } as never)
    expect(cause.actor).toEqual({
      kind: 'paired-device',
      deviceId: uuid,
      clientKind: 'runtime',
      unverifiedPaneKey: paneKey,
      unverifiedTerminalHandle: `term_${uuid}`
    })
    recordLaunch({
      pipeline: 'runtime-controller',
      ptyId: uuid,
      cause,
      hasStartupCommand: false,
      process: 'created'
    })
    expect((await readRows())[0].actor).toEqual(cause.actor)
  })
  it('reads an unfinished prepared start from the retained file', async () => {
    recordLaunch({
      pipeline: 'runtime-controller',
      ptyId: uuid,
      paneKey,
      cause: { trigger: 'cli' },
      launchId: uuid,
      hasStartupCommand: false,
      process: 'prepared'
    } as never)
    const launch = await findLaunchRecord({ paneKey })
    expect(launch).toMatchObject({ launchId: uuid, process: 'prepared', ptyId: uuid })
  })
  it('never persists private text in host identity fields', async () => {
    recordLaunch({
      pipeline: 'runtime-controller',
      ptyId: 'OPENAI_API_KEY=sk-example',
      paneKey: 'private prompt',
      tabId: 'claude --resume secret',
      worktreeId: 'private_prompt_text',
      agent: 'sk-secret-value',
      cause: { trigger: 'cli' },
      hasStartupCommand: false,
      process: 'created'
    })
    const text = JSON.stringify(await readRows())
    for (const privateValue of [
      'OPENAI_API_KEY',
      'private prompt',
      'claude --resume',
      'private_prompt_text',
      'sk-secret-value'
    ]) {
      expect(text).not.toContain(privateValue)
    }
  })
})
