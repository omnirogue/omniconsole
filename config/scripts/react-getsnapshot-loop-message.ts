export const GET_SNAPSHOT_LOOP_MESSAGE =
  'The result of getSnapshot should be cached to avoid an infinite loop'

/** True when a console.error call carries React's uncached-getSnapshot warning. */
export function isReactGetSnapshotLoopMessage(args: readonly unknown[]): boolean {
  return args.some((arg) => {
    if (typeof arg === 'string') {
      return arg.includes(GET_SNAPSHOT_LOOP_MESSAGE)
    }
    if (arg instanceof Error) {
      return arg.message.includes(GET_SNAPSHOT_LOOP_MESSAGE)
    }
    return false
  })
}
