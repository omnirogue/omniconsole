import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import {
  getConsoleLocalExecution,
  installConsoleAutoAdvanceRunner
} from '../console-workflows/console-local-execution-registration'
import {
  readConsoleAutoAdvance,
  writeConsoleAutoAdvance
} from '../console-workflows/console-auto-advance-service'
import { consoleAutoAdvanceRequest } from '../console-workflows/console-auto-advance-request'
import { continueConsoleTask } from '../backoffice/console-task-continuation'
import { readConsoleTaskContinuationCapability } from '../backoffice/console-task-continuation-capability'

export function registerConsoleLocalExecutionHandlers(runtime: OrcaRuntimeService): void {
  // Why here: this is the earliest main-process wiring for console local execution, so the
  // runtime RPC methods can resolve the runner from their first call onward.
  installConsoleAutoAdvanceRunner()
  ipcMain.handle('consoleLocalExecution:taskContinuationCapabilities', (_event, args) =>
    readConsoleTaskContinuationCapability(args)
  )
  ipcMain.handle('consoleLocalExecution:continueTask', (_event, args) =>
    continueConsoleTask(runtime, args)
  )
  ipcMain.handle('consoleLocalExecution:start', (_event, args) =>
    getConsoleLocalExecution(runtime).start(args)
  )
  ipcMain.handle('consoleLocalExecution:list', () => getConsoleLocalExecution(runtime).list())
  ipcMain.handle('consoleLocalExecution:cancel', (_event, args) =>
    getConsoleLocalExecution(runtime).cancel(args)
  )
  ipcMain.handle('consoleLocalExecution:readWorker', (_event, args) =>
    getConsoleLocalExecution(runtime).readWorker(args)
  )
  ipcMain.handle('consoleLocalExecution:focus', (_event, args) =>
    getConsoleLocalExecution(runtime).focus(args)
  )
  ipcMain.handle('consoleLocalExecution:autoAdvanceGet', (_event, args) =>
    consoleAutoAdvanceRequest(() => readConsoleAutoAdvance(runtime, args?.workflowId))
  )
  ipcMain.handle('consoleLocalExecution:autoAdvanceSet', (_event, args) =>
    consoleAutoAdvanceRequest(() => writeConsoleAutoAdvance(runtime, args))
  )
}
