import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'

const ownerQueues = new WeakMap<object, Map<string, Promise<void>>>()
const objectQueues = new WeakMap<object, Map<string, Promise<void>>>()

export function withAdvertisingObjectLock<T>(
  owner: object,
  accountId: string,
  nativeId: string,
  work: () => Promise<T>
): Promise<T> {
  let queues = objectQueues.get(owner)
  if (!queues) {
    queues = new Map()
    objectQueues.set(owner, queues)
  }
  return runKeyedSerializedOperation(queues, JSON.stringify([accountId, nativeId]), work)
}

/** Replacing a service for the same owner must not fork its action/publication queue. */
export function withRoutineDecisionRunLock<T>(
  owner: object,
  routineId: string,
  runId: string,
  work: () => Promise<T>
): Promise<T> {
  let queues = ownerQueues.get(owner)
  if (!queues) {
    queues = new Map()
    ownerQueues.set(owner, queues)
  }
  return runKeyedSerializedOperation(queues, JSON.stringify([routineId, runId]), work)
}
