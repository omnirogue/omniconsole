import type { ConsoleWorkflowStep } from './console-workflow-types'
import type { ConsoleConversationHandoffOutput } from './console-conversation-handoff-report'
import {
  DEFAULT_SESSION_ACTION_TEMPLATES,
  type SessionActionPresetId
} from './session-action-presets'

/** Default read-only recipes retain their actual response as a report outside provider execution. */
export function conversationFleetHandoffReport(
  outputDir: string,
  presetId: SessionActionPresetId | undefined,
  template: string | undefined,
  folder: boolean
): Pick<ConsoleWorkflowStep, 'handoff_report' | 'output_artifacts'> {
  const directory = outputDir.replace(/^\.\//, '')
  const manifestPath = `${directory}/manifest.md`
  const response =
    (presetId === 'review' || presetId === 'verify') &&
    template === DEFAULT_SESSION_ACTION_TEMPLATES[presetId]
      ? `${directory}/${presetId}.md`
      : null
  const outputs: ConsoleConversationHandoffOutput[] = [
    ...(response ? [{ path: response, source: 'response' as const }] : []),
    { path: manifestPath, source: 'manifest' }
  ]
  return folder
    ? { output_artifacts: outputs }
    : {
        handoff_report: {
          path: 'handoff-result.json',
          format: 'json',
          max_bytes: 50_331_648,
          files: [],
          manifests: [manifestPath],
          outputs
        }
      }
}
