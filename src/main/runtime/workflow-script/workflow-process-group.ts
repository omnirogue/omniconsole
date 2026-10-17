import {
  runProcess,
  type ChildProcessHandle,
  type ProcessResult,
  type ProcessSpec
} from '../../../shared/child-process/run-process'
import {
  forceTerminateProcessTree,
  waitForPosixProcessGroupQuiescence
} from '../../../shared/child-process/process-tree-termination'

/** Only for a POSIX group created by this launch; root exit does not account for its descendants. */
export async function finishWorkflowProcessGroup(child: ChildProcessHandle): Promise<boolean> {
  if (process.platform === 'win32' || !child.pid) {
    throw new Error('Workflow process group exit is unverifiable')
  }
  const quiescent = await waitForPosixProcessGroupQuiescence(child.pid)
  if (!quiescent && !(await forceTerminateProcessTree(child))) {
    throw new Error('Workflow process group exit is unverifiable')
  }
  return !quiescent
}

/** Bounded helper commands own their POSIX group, including children left after normal exit. */
export async function runWorkflowHelperProcess(spec: ProcessSpec): Promise<ProcessResult> {
  // Windows retains the existing runner's taskkill barrier; POSIX group probes cannot run there.
  if (process.platform === 'win32') {
    return runProcess({ ...spec, terminationBarrier: true })
  }
  let child: ChildProcessHandle | undefined
  try {
    return await runProcess({
      ...spec,
      terminationBarrier: true,
      onSpawn: (spawned) => {
        child = spawned
        spec.onSpawn?.(spawned)
      }
    })
  } finally {
    if (child) {
      await finishWorkflowProcessGroup(child)
    }
  }
}
