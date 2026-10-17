import { afterEach, beforeEach } from 'vitest'
import {
  GET_SNAPSHOT_LOOP_MESSAGE,
  isReactGetSnapshotLoopMessage
} from './react-getsnapshot-loop-message'

/**
 * Why: a Zustand `useShallow` selector that builds a fresh `[]`/`{}` per read makes React
 * re-render forever (React #185). React only reports this through console.error, which a
 * passing test never looks at, so the Attention page shipped that loop until a real user
 * opened it. Any test that triggers the message now fails outright.
 */

let loopMessages: string[] = []
let previousConsoleError: typeof console.error | null = null

function formatConsoleArgs(args: unknown[]): string {
  return args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ')
}

beforeEach(() => {
  loopMessages = []
  const original = console.error
  previousConsoleError = original
  console.error = (...args: unknown[]) => {
    if (isReactGetSnapshotLoopMessage(args)) {
      loopMessages.push(formatConsoleArgs(args))
    }
    original.apply(console, args)
  }
})

afterEach(() => {
  if (previousConsoleError) {
    console.error = previousConsoleError
    previousConsoleError = null
  }
  if (loopMessages.length === 0) {
    return
  }
  const count = loopMessages.length
  loopMessages = []
  throw new Error(
    `React reported "${GET_SNAPSHOT_LOOP_MESSAGE}" ${count} time(s) during this test. ` +
      'A store selector (usually inside useShallow) returns a new reference on every read; ' +
      'reuse a module-level EMPTY_* constant instead. See useTabGroupWorkspaceModel.ts.'
  )
})
