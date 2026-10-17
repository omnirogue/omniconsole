import { acpSpawnRecipe } from '../../shared/acp-agent-recipes'
import type { AcpLaunchSupport } from '../../shared/acp-launch-support'
import {
  AcpChildExitUnprovenError,
  openAcpJsonRpcConnection,
  type AcpJsonRpcLaunch
} from './acp-jsonrpc-connection'

export async function probeAcpLaunch(input: {
  agent: string
  cwd: string
  env: Record<string, string>
  openConnection?: typeof openAcpJsonRpcConnection
  findCommand: (command: string) => string | null
}): Promise<AcpLaunchSupport> {
  const recipe = acpSpawnRecipe(input.agent)
  if (!recipe) {
    return { supported: false, reason: 'disabled' }
  }
  const command = input.findCommand(recipe.program)
  if (!command) {
    return { supported: false, reason: 'binary-missing', detail: recipe.program }
  }
  if (input.agent === 'omp' && !input.findCommand('bun')) {
    return { supported: false, reason: 'bun-missing', detail: 'bun' }
  }
  const launch: AcpJsonRpcLaunch = { command, args: recipe.args, cwd: input.cwd, env: input.env }
  try {
    const connection = await (input.openConnection ?? openAcpJsonRpcConnection)(launch)
    const stopped = await connection.close()
    if (!stopped) {
      return { supported: false, reason: 'exit-unproven' }
    }
    return { supported: true }
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof AcpChildExitUnprovenError ? 'exit-unproven' : 'initialize-failed',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}
