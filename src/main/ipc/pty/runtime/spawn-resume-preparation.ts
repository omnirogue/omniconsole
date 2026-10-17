import type { CodexResumeLaunch } from '../host-env/codex-resume'
import type { RuntimePtySpawnState } from './spawn-state'

export function applyRuntimeResumePreparation(
  ctx: RuntimePtySpawnState,
  launch: CodexResumeLaunch
): void {
  ctx.launchCommand = launch.command
  ctx.codexResumeLaunch = launch
  ctx.args.onResumePrepared?.(
    launch.droppedResumeArgv ? null : (ctx.args.resumeProviderSession ?? null)
  )
}
