import { consoleWorkflowAcceptanceCommands } from '../../../shared/console-workflow-acceptance'
import type { ConsoleWorkflowAcceptanceCommand } from '../../../shared/console-workflow-acceptance'

export type WorkflowAcceptanceDraft = {
  id: string
  program: string
  arguments: string
  timeout: string
}

export function newWorkflowAcceptanceDraft(): WorkflowAcceptanceDraft {
  return { id: crypto.randomUUID(), program: '', arguments: '[]', timeout: '60000' }
}

export function workflowAcceptanceCommands(
  commands: WorkflowAcceptanceDraft[]
): ConsoleWorkflowAcceptanceCommand[] {
  const values = commands.map((command, index) => {
    let args: unknown
    try {
      args = JSON.parse(command.arguments)
    } catch {
      throw new Error(`Acceptance command ${index + 1}: arguments must be a JSON array of strings.`)
    }
    return {
      program: command.program,
      args,
      timeout_ms: /^\d+$/.test(command.timeout) ? Number(command.timeout) : Number.NaN
    }
  })
  const parsed = consoleWorkflowAcceptanceCommands.safeParse(values)
  if (!parsed.success) {
    throw new Error(
      'Acceptance commands need a program, string arguments and a timeout from 1 to 3600000 ms.'
    )
  }
  return parsed.data
}
