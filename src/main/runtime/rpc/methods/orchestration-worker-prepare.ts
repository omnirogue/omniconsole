import { accessSync, constants, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { getAppEnvironment } from '../../../../shared/app-environment'
import {
  canonicalWorkerBindingHash,
  CANONICAL_WORKER_GATE_PYTHON
} from '../../orchestration/canonical-worker-gate'
import {
  consumeCanonicalWorkerFile,
  exposeCanonicalWorker,
  readCanonicalWorkerRecord,
  updateCanonicalWorkerRecord,
  writeCanonicalWorkerFile,
  type CanonicalWorkerRecord
} from '../../orchestration/canonical-worker-record'
import {
  canonicalProcessBirth,
  observeCanonicalProcessIdentity,
  readCanonicalGateObservation
} from '../../orchestration/canonical-worker-observation'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { resolveOrchestrationCaller } from './orchestration-run-scope'
import { resolveDispatchCreator } from './orchestration-dispatch-creator'
import { requireWorkerAuthority, type WorkerEffect } from './orchestration-worker-topology'

const LaunchInput = z.object({
  binding: z.record(z.string(), z.unknown()),
  runnerInstance: z.string().min(1).max(256),
  argv: z.array(z.string().refine((item) => !item.includes('\0'))).min(1),
  env: z.record(z.string(), z.string()),
  cwd: z.string().refine(isAbsolute),
  gatePython: z.string().refine(isAbsolute)
})

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export const ORCHESTRATION_WORKER_PREPARE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerPrepare',
    params: z.object({
      task: requiredString('Missing --task'),
      run: requiredString('Missing --run'),
      from: requiredString('Missing --from'),
      worktree: requiredString('Missing --worktree'),
      executionFile: requiredString('Missing --execution-file')
    }),
    handler: async (
      params,
      { runtime, orchestrationMutation, orchestrationCompatibilityEvidence }
    ) => {
      if (process.platform === 'win32') {
        throw new Error('Canonical worker preparation requires a POSIX execution host.')
      }
      const db = runtime.getOrchestrationDb()
      const pane = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        requireStablePane: true
      })
      const run = db.getCurrentRunForPane(pane)
      const task = db.getTask(params.task)
      if (
        !run ||
        run.id !== params.run ||
        !run.hub_task_id ||
        task?.run_id !== run.id ||
        task.hub_task_id !== run.hub_task_id
      ) {
        throw new OrchestrationError(
          'consumer_fenced',
          'A bound Run and its canonical task projection are required.'
        )
      }
      const launch = LaunchInput.parse(consumeCanonicalWorkerFile(params.executionFile))
      const binding = launch.binding
      if (
        binding.task_id !== task.hub_task_id ||
        binding.runner_instance !== launch.runnerInstance ||
        typeof binding.job_id !== 'string' ||
        typeof binding.claimed_at !== 'string' ||
        !Number.isSafeInteger(binding.attempt) ||
        Number(binding.attempt) < 1 ||
        !binding.contract_id ||
        !binding.contract_digest ||
        !binding.contract_generation ||
        !binding.dispatch_key ||
        !binding.attempt_intent_id ||
        !binding.host ||
        !binding.claim_request_id
      ) {
        throw new OrchestrationError(
          'consumer_fenced',
          'The complete canonical execution claim must match this Run.'
        )
      }
      const bindingHash = canonicalWorkerBindingHash(binding)
      const launchDigest = createHash('sha256').update(JSON.stringify(launch)).digest('hex')
      const prior = db.getDispatchContext(task.id)
      if (prior) {
        const record = readCanonicalWorkerRecord(db, prior.id)
        if (!record || record.bindingHash !== bindingHash || record.launchDigest !== launchDigest) {
          throw new OrchestrationError(
            'request_mismatch',
            'This task projection already names another execution.'
          )
        }
        const worker = db.getWorkerDispatch(prior.id)!
        return {
          runId: run.id,
          taskId: task.id,
          dispatchId: prior.id,
          state: worker.state,
          stage: worker.stage,
          canonical: exposeCanonicalWorker(record)
        }
      }
      const workspace = await runtime.showManagedTerminalWorkspace(params.worktree)
      const repo = await runtime.showRepo(`id:${workspace.repoId}`)
      if (repo.connectionId || realpathSync(workspace.path) !== realpathSync(launch.cwd)) {
        throw new OrchestrationError(
          'consumer_fenced',
          'Canonical preparation must run on the selected local execution host and workspace.'
        )
      }
      accessSync(launch.gatePython, constants.X_OK)
      const created = db.createStartingWorkerDispatch({
        taskId: task.id,
        creator: resolveDispatchCreator(runtime, params.from),
        maxDepth: runtime.getNestedWorkerMaxDepth(),
        runtimeEpoch: runtime.getRuntimeId(),
        mutationReceipt: orchestrationMutation,
        startOptions: { canonical: null }
      })
      const dispatchId = created.dispatch.id
      const gateDirectory = join(
        getAppEnvironment().getPath('userData'),
        'canonical-workers',
        dispatchId
      )
      const gateNonce = canonicalWorkerBindingHash({ dispatchId, bindingHash })
      const record: CanonicalWorkerRecord = {
        binding,
        bindingHash,
        launchDigest,
        gateDirectory,
        gateNonce,
        runGeneration: run.consumer_generation,
        processIdentity: null,
        phase: 'prepared',
        terminalProof: null
      }
      db.db
        .prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?')
        .run(JSON.stringify({ canonical: record }), dispatchId)
      const effects: WorkerEffect[] = []
      try {
        mkdirSync(gateDirectory, { recursive: true, mode: 0o700 })
        const script = join(gateDirectory, 'gate.py')
        writeFileSync(script, CANONICAL_WORKER_GATE_PYTHON, { mode: 0o600, flag: 'wx' })
        writeCanonicalWorkerFile(join(gateDirectory, 'launch.json'), launch)
        const terminal = await runtime.createTerminal(`id:${workspace.id}`, {
          launchCause: {
            trigger: 'orchestration-worker',
            reference: { orchestrationTaskId: task.id }
          },
          command: `exec ${[launch.gatePython, '-I', '-S', script, gateDirectory, gateNonce].map(quote).join(' ')}`,
          cwd: launch.cwd,
          env: { PYTHONPATH: '', PYTHONHOME: '', ORCA_DISABLE_MACOS_LOGIN_SHELL: '1' },
          envToDelete: ['OMNI_TASK_ID', 'OMNIOS_URL'],
          title: `worker-${task.id}`,
          surfaceOwner: false
        })
        effects.push({ kind: 'terminal', role: 'agent', action: 'created', id: terminal.handle })
        db.prepareStartingWorkerAuthority({
          dispatchId,
          handle: terminal.handle,
          ...requireWorkerAuthority(runtime, terminal.handle),
          worktreeId: workspace.id,
          effects,
          setupState: 'not_applicable',
          terminalOwnership: 'created'
        })
        const processIdentity = await observeCanonicalProcessIdentity(
          terminal.processId ?? 0,
          launch.runnerInstance
        )
        updateCanonicalWorkerRecord(db, dispatchId, { processIdentity })
        const deadline = Date.now() + 20_000
        let observed = readCanonicalGateObservation(gateDirectory)
        while (!observed && Date.now() < deadline) {
          await delay(25)
          observed = readCanonicalGateObservation(gateDirectory)
        }
        if (
          !observed ||
          observed.phase !== 'prepared' ||
          observed.launch_gate_closed !== true ||
          observed.binding_hash !== bindingHash ||
          observed.runner_instance !== launch.runnerInstance ||
          observed.pid !== observed.pgid ||
          terminal.processId !== observed.pid ||
          observed.started_at !== processIdentity.started_at
        ) {
          throw new Error('The execution host did not attest the closed provider gate.')
        }
        if ((await canonicalProcessBirth(processIdentity)) !== 'current') {
          throw new Error('The prepared process identity cannot be verified.')
        }
        const current = db.getWorkerDispatch(dispatchId)
        if (current?.state !== 'starting') {
          throw new Error('The prepared execution was interrupted.')
        }
        const prepared = updateCanonicalWorkerRecord(db, dispatchId, { processIdentity })
        db.recordWorkerStage({ dispatchId, stage: 'awaiting_hub_start', effects })
        return {
          runId: run.id,
          taskId: task.id,
          dispatchId,
          state: 'starting',
          stage: 'awaiting_hub_start',
          canonical: exposeCanonicalWorker(prepared)
        }
      } catch {
        const worker = db.getWorkerDispatch(dispatchId)
        if (worker?.state === 'starting') {
          db.markWorkerStartUnknown(
            dispatchId,
            'canonical_prepare_unknown',
            'The provider remains fenced; inspect the exact worker before continuing.'
          )
        }
        return {
          runId: run.id,
          taskId: task.id,
          dispatchId,
          state: db.getWorkerDispatch(dispatchId)?.state,
          stage: 'canonical_prepare_unknown',
          canonical: exposeCanonicalWorker(readCanonicalWorkerRecord(db, dispatchId)!)
        }
      }
    }
  })
]
