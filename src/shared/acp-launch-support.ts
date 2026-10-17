import { isAcpStructuredAgent } from './acp-agent-recipes'
import type { GlobalSettings } from './global-settings-types'

export function isAcpEnabled(
  settings:
    | Pick<GlobalSettings, 'experimentalStructuredNativeChat' | 'agentUseAcp'>
    | null
    | undefined,
  agent: string
): boolean {
  return (
    isAcpStructuredAgent(agent) &&
    settings?.experimentalStructuredNativeChat === true &&
    settings.agentUseAcp?.[agent] === true
  )
}

export type AcpLaunchFailureReason =
  | 'disabled'
  | 'remote'
  | 'wsl'
  | 'windows'
  | 'custom-launch'
  | 'binary-missing'
  | 'bun-missing'
  | 'initialize-failed'
  | 'exit-unproven'
export type AcpLaunchSupport =
  | { supported: true }
  | { supported: false; reason: AcpLaunchFailureReason; detail?: string }
