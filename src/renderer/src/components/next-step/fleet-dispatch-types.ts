import type { ConsoleWorkflowPreview } from '../../../../shared/console-workflow-types'

export type FleetDispatchMachine = {
  id: string
  label: string
  available: boolean
  reason?: string
}

export type FleetDispatchReview = {
  preview: ConsoleWorkflowPreview
  machineLabel: string
  contextSummary: string
  inputs?: { name: string; sizeBytes: number; targetPath?: string }[]
  warnings?: string[]
  sourceCommit?: string
}
