import { orchestrationWorkerLaunchCause } from '../terminal-launch-cause'
import { noteAgentTerminal } from '../../../session-organization/agent-session-mark'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { PtyLaunchGateReceipt } from '../../../../shared/pty-launch-gate'
import { prepareConsoleWorkerLaunchGate } from '../../../console-workflows/console-worker-start-gate'
import { startWorkerConsoleProcess } from './orchestration-worker-console-process'
import { deliverWorkerDispatchPrompt } from './orchestration-worker-prompt-delivery'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { startFederatedWorkerInProject } from './orchestration-federated-worker-project'
import {
  assertReusableWorkerTerminal,
  ensureWorkerStartCwd,
  resolveLocalWorkerPlacement
} from './orchestration-worker-placement'
import { planWorkerProject } from './orchestration-worker-project'
import { buildWorkerStartOptions } from './orchestration-worker-start-options'
import { WorkerStartParams } from './orchestration-worker-start-schema'
import {
  createExistingWorktreeWorkerTerminal,
  createWorkerWorktree,
  monitorWorkerSetup,
  type WorkerEffect
} from './orchestration-worker-topology'
import {
  initialWorkerSetupReceipt,
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome
} from './orchestration-worker-setup-gate'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'
import { assertWorkerStartupReady } from './orchestration-worker-startup-blocker'
import {
  assertUnboundLocalWorkerStart,
  prepareLocalWorkerStart,
  validatedWorkerReadinessTimeoutMs
} from './orchestration-worker-start-validation'
import {
  prepareWorkerCompletionPolicy,
  resolveWorkerCompletionHostId,
  settleSpawnedWorkerCompletionPolicy,
  assertWorkerCompletionPolicyPlacement
} from './orchestration-worker-completion-policy'
import { resolveDispatchCreator } from './orchestration-dispatch-creator'
import { requireWorkerRunTask, resolveOrchestrationCaller } from './orchestration-run-scope'
import {
  assertConsoleWorkerCorrelation,
  bindConsoleWorkerDispatch
} from '../../../console-workflows/console-worker-correlation'

export const ORCHESTRATION_WORKER_START_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStart',
    params: WorkerStartParams,
    handler: async (
      params,
      { runtime, orchestrationMutation, orchestrationCompatibilityEvidence }
    ) => {
      const readinessTimeoutMs = validatedWorkerReadinessTimeoutMs(params.timeoutMs)
      const db = runtime.getOrchestrationDb()
      // Why: worker-start was the only Run-scoped verb that skipped this, so a
      // declared --from could name someone else's pane and inherit their depth.
      const coordinatorPane = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      const run = coordinatorPane ? db.getCurrentRunForPane(coordinatorPane) : undefined
      if (!coordinatorPane || !run || (params.run && params.run !== run.id)) {
        throw new OrchestrationError(
          'consumer_fenced',
          'worker-start requires the coordinator terminal currently bound to the Task Run.'
        )
      }
      const task = requireWorkerRunTask(db, params.task, run.id)
      assertConsoleWorkerCorrelation(db, run.id, params)
      const consoleAdmission = { runId: run.id, attempt: params.consoleExecution }
      assertUnboundLocalWorkerStart(db, task.id, consoleAdmission)

      assertWorkerCompletionPolicyPlacement(params)
      const project = await planWorkerProject(runtime, params)
      if (params.on || project.on) {
        const remote = { params, project, runtime, db, runId: run.id, task, orchestrationMutation }
        return startFederatedWorkerInProject(remote)
      }

      const requestedWorktree = params.worktree ?? 'current'
      const createsWorktree =
        requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
      const { agent, launch } = prepareLocalWorkerStart({ params, createsWorktree, runtime })

      const coordinatorTerminal = await runtime.showTerminal(params.from)
      const placement = await resolveLocalWorkerPlacement({
        runtime,
        params,
        coordinatorWorktreeId: coordinatorTerminal.worktreeId,
        createsWorktree,
        agent
      })
      let { creationWorktree, workerCwd, launchEnv, resolvedWorktree } = placement
      if (params.terminal) {
        await assertReusableWorkerTerminal(runtime, params.terminal, resolvedWorktree?.id)
      }
      const completionPolicy = await prepareWorkerCompletionPolicy(
        runtime,
        params,
        { worktreeId: coordinatorTerminal.worktreeId, paneKey: coordinatorPane },
        resolvedWorktree?.id ?? creationWorktree!.id,
        agent,
        await resolveWorkerCompletionHostId(runtime, (resolvedWorktree ?? creationWorktree)!)
      )

      assertUnboundLocalWorkerStart(db, task.id, consoleAdmission)

      const startOptions = buildWorkerStartOptions({
        params,
        requestedWorktree,
        resolvedWorktreeId: resolvedWorktree?.id ?? null,
        creationRepoId: creationWorktree?.repoId ?? null,
        createsWorktree,
        workerCwd,
        agent,
        launchReceipt: launch.receipt,
        readinessTimeoutMs
      })
      const startupStartedAt = performance.now()
      const started = db.createStartingWorkerDispatch({
        creator: resolveDispatchCreator(runtime, params.from),
        maxDepth: runtime.getNestedWorkerMaxDepth(),
        taskId: task.id,
        retryOf: params.retryOf,
        continueFrom: params.continueFrom,
        startOptions,
        runtimeEpoch: runtime.getRuntimeId(),
        mutationReceipt: orchestrationMutation
      })
      bindConsoleWorkerDispatch(db, run.id, started.dispatch.id)
      const threadMemory = project.threadMemory(started.dispatch.id)
      const effects: WorkerEffect[] = []
      if (resolvedWorktree) {
        effects.push(
          { kind: 'worktree', action: 'reused', id: resolvedWorktree.id },
          { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
        )
      }
      let terminalHandle = params.terminal
      let consoleGate: PtyLaunchGateReceipt | undefined
      let terminalRevealWarning: string | undefined
      let failedStage = 'terminal_create'
      let setupReceipt = initialWorkerSetupReceipt()
      try {
        if (creationWorktree) {
          failedStage = 'worktree_create'
          const created = await createWorkerWorktree({
            launchCause: orchestrationWorkerLaunchCause(task.id, started.dispatch.id),
            runtime,
            db,
            dispatchId: started.dispatch.id,
            requestedWorktree,
            coordinatorWorktree: creationWorktree,
            params,
            agent: agent as TuiAgent,
            launchPreferences: launch.preferences,
            ...(launchEnv ? { launchEnv } : {}),
            threadMemory,
            hubTaskId: started.dispatch.hub_task_id,
            effects
          })
          resolvedWorktree = created.worktree
          terminalHandle = created.terminalHandle
          setupReceipt = created.setupReceipt
        } else if (!terminalHandle) {
          db.recordWorkerStage({
            dispatchId: started.dispatch.id,
            stage: 'terminal_creating',
            worktreeId: resolvedWorktree!.id,
            effects
          })
          ensureWorkerStartCwd(workerCwd)
          const terminal = await createExistingWorktreeWorkerTerminal({
            launchCause: orchestrationWorkerLaunchCause(task.id, started.dispatch.id),
            ...(params.consoleExecution
              ? { launchGate: await prepareConsoleWorkerLaunchGate(runtime, started.dispatch.id) }
              : {}),
            runtime,
            worktreeId: resolvedWorktree!.id,
            agent: agent as TuiAgent,
            launchPreferences: launch.preferences,
            hubTaskId: started.dispatch.hub_task_id,
            taskId: task.id,
            ...(workerCwd ? { cwd: workerCwd } : {}),
            ...(launchEnv ? { launchEnv } : {}),
            threadMemory,
            effects
          })
          terminalHandle = terminal.handle
          consoleGate = terminal.launchGate
          terminalRevealWarning = terminal.warning
        } else {
          effects.push({ kind: 'terminal', role: 'agent', action: 'reused', id: terminalHandle })
        }
        if (!resolvedWorktree || !terminalHandle) {
          throw new Error('Worker topology did not resolve an agent terminal and worktree.')
        }
        if (!params.terminal) {
          // A worker this start launched is an agent session; a reused terminal keeps its place.
          noteAgentTerminal(runtime, terminalHandle)
        }
        const setupStage = {
          db,
          dispatchId: started.dispatch.id,
          worktreeId: resolvedWorktree.id,
          terminalHandle,
          setup: setupReceipt,
          effects
        }
        if (persistGatedSetupSpawnFailure(setupStage)) {
          failedStage = 'setup_start'
          throw new Error('Setup terminal failed to start before the gated agent launch.')
        }
        persistWorkerReadinessStage(setupStage)

        if (params.consoleExecution) {
          failedStage = 'console_process_start'
          await startWorkerConsoleProcess({
            ...setupStage,
            runtime,
            gate: consoleGate,
            attempt: params.consoleExecution
          })
        }

        failedStage = 'agent_readiness'
        const wait = await runtime.waitForTerminal(terminalHandle, {
          condition: 'tui-idle',
          timeoutMs: readinessTimeoutMs
        })
        persistWorkerSetupWaitOutcome({ ...setupStage, wait })
        if (!wait.satisfied && setupReceipt.state === 'failed') {
          failedStage = 'setup_wait'
        }
        await assertWorkerStartupReady(runtime, terminalHandle, agent as TuiAgent, wait)
        failedStage = 'dispatch_input'
        const inherited = await project.inherit({ terminalHandle, created: !params.terminal })
        await settleSpawnedWorkerCompletionPolicy({
          ...setupStage,
          runtime,
          params,
          policy: completionPolicy,
          startOptions
        })
        const worker = await deliverWorkerDispatchPrompt({
          runtime,
          db,
          dispatch: started.dispatch,
          task,
          params,
          terminalHandle,
          worktreeId: resolvedWorktree.id,
          effects,
          setup: setupReceipt,
          consoleGate,
          startupStartedAt,
          projectBrief: inherited.brief
        })
        monitorWorkerSetup({
          runtime,
          db,
          runId: run.id,
          dispatchId: started.dispatch.id,
          setupReceipt,
          effects
        })
        return {
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          state: worker.state,
          stage: worker.stage,
          setup: setupReceipt,
          launch: launch.receipt,
          timeoutMs: readinessTimeoutMs,
          effects,
          residualResources: [],
          ...inherited.receipt,
          ...(terminalRevealWarning ? { warning: terminalRevealWarning } : {})
        }
      } catch (error) {
        return failWorkerStartWithReceipt({
          db,
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          failedStage,
          error,
          setup: setupReceipt,
          launch: launch.receipt
        })
      }
    }
  })
]
