import type { RpcMethod } from '../core'
import { ORCHESTRATION_WORKER_CONTROL_METHODS } from './orchestration-worker-control'
import { ORCHESTRATION_WORKER_RELEASE_METHODS } from './orchestration-worker-release'
import { ORCHESTRATION_WORKER_LINEAGE_METHODS } from './orchestration-worker-lineage'
import { ORCHESTRATION_WORKER_STOP_METHODS } from './orchestration-worker-stop'
import { ORCHESTRATION_WORKER_START_METHODS } from './orchestration-workers'
import { ORCHESTRATION_WORKER_PREPARE_METHODS } from './orchestration-worker-prepare'
import { ORCHESTRATION_WORKER_EXECUTE_METHODS } from './orchestration-worker-execute'
import { ORCHESTRATION_WORKFLOW_RESULT_METHODS } from './orchestration-workflow-result-submit'

export const ORCHESTRATION_WORKER_METHODS: RpcMethod[] = [
  ...ORCHESTRATION_WORKER_START_METHODS,
  ...ORCHESTRATION_WORKER_PREPARE_METHODS,
  ...ORCHESTRATION_WORKER_EXECUTE_METHODS,
  ...ORCHESTRATION_WORKER_CONTROL_METHODS,
  ...ORCHESTRATION_WORKER_STOP_METHODS,
  ...ORCHESTRATION_WORKER_RELEASE_METHODS,
  ...ORCHESTRATION_WORKER_LINEAGE_METHODS,
  ...ORCHESTRATION_WORKFLOW_RESULT_METHODS
]
