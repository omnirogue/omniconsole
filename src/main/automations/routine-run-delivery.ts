import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type {
  AutomationAlertChannel,
  AutomationDelivery,
  AutomationDeliveryResult
} from '../../shared/automation-definition-context'
import { automationRunResult } from '../../shared/automation-run-result'
import { routineDeliveryPlan } from '../../shared/routine-delivery-plan'
import type { RoutineDeliveryPhase } from '../../shared/routine-delivery-state'
import { renderRoutineOutput } from './routine-output-renderer'

type Receipt = { permalink?: string } | void
export type RoutineDeliveryAdapters = {
  prepare?: () => Promise<RoutineDeliveryAdapters>
  desktop: (
    summary: string,
    link: string,
    automation: Automation,
    run: AutomationRun
  ) => Promise<Receipt>
  alert: (
    channel: Exclude<AutomationAlertChannel, { kind: 'desktop' }>,
    summary: string,
    link: string,
    automation: Automation,
    run: AutomationRun
  ) => Promise<Receipt>
  deliver: (
    target: Exclude<AutomationDelivery, { kind: 'chat' } | { kind: 'file' }>,
    output: string,
    link: string,
    automation: Automation,
    run: AutomationRun
  ) => Promise<Receipt>
}
const unavailable = async (): Promise<never> => {
  throw new Error('This delivery requires the desktop app.')
}
const executionAdapters: RoutineDeliveryAdapters = {
  desktop: unavailable,
  alert: unavailable,
  deliver: unavailable
}

/** File effects stay on the execution host; external effects run only in the local desktop. */
export async function deliverRoutineRun(
  automation: Automation,
  run: AutomationRun,
  artifactDirectory: string,
  options: { phase: RoutineDeliveryPhase; link: string; adapters?: RoutineDeliveryAdapters }
): Promise<AutomationDeliveryResult[]> {
  const adapters = options.adapters ?? executionAdapters
  const { summary, output } = automationRunResult(run.outputSnapshot?.content ?? '')
  const results: AutomationDeliveryResult[] = []
  for (const entry of routineDeliveryPlan(automation, run, options.phase)) {
    try {
      let receipt: Receipt = undefined
      if ('alert' in entry) {
        receipt =
          entry.alert.kind === 'desktop'
            ? await adapters.desktop(summary, options.link, automation, run)
            : await adapters.alert(entry.alert, summary, options.link, automation, run)
      } else if (entry.output.kind === 'chat') {
        receipt = undefined
      } else {
        const content = await renderRoutineOutput(output, automation.outputFormat ?? 'markdown')
        if (entry.output.kind === 'file') {
          if (run.deliveryHostId !== 'local') {
            throw new Error(
              'File delivery requires the execution host; the desktop cannot write a remote path.'
            )
          }
          const file = isAbsolute(entry.output.path)
            ? entry.output.path
            : join(artifactDirectory, entry.output.path)
          await mkdir(artifactDirectory, { recursive: true })
          await writeFile(
            join(artifactDirectory, 'outputSnapshot.json'),
            JSON.stringify(run.outputSnapshot),
            'utf8'
          )
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, content, 'utf8')
        } else {
          receipt = await adapters.deliver(entry.output, content, options.link, automation, run)
        }
      }
      results.push({ kind: entry.kind, target: entry.target, ok: true, ...receipt })
    } catch (error) {
      results.push({
        kind: entry.kind,
        target: entry.target,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return results
}
