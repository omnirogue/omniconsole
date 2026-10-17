import { join } from 'node:path'
import { z } from 'zod'
import { LAYA_MODEL } from '../../shared/laya-shadow'
import {
  decisionIdentifierSchema,
  type DecisionRequest,
  type DecisionResult
} from '../../shared/structured-decisions'
import { readBoundedConfiguration, disabledDecisionConfiguration } from './decision-configuration'
import { DecisionService, type DecisionServiceOptions } from './decision-service'
import { LayaDecisionProvider } from './laya-provider'

const settingsSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    capabilities: z.array(decisionIdentifierSchema).max(32),
    token: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()

export class LayaShadow {
  readonly service: DecisionService
  private readonly path: string
  constructor(
    userDataPath: string,
    sources: Pick<DecisionServiceOptions, 'configuration' | 'routineMode'>
  ) {
    this.path = join(userDataPath, 'laya-shadow.json')
    this.service = new DecisionService({
      provider: new LayaDecisionProvider({
        resolveToken: async () => (await this.settings())?.token
      }),
      shadowConcurrency: 1,
      shadowQueueLimit: 4,
      routineMode: sources.routineMode,
      configuration: async () => {
        const [baseline, local] = await Promise.all([sources.configuration(), this.settings()])
        if (!local?.enabled) {
          return disabledDecisionConfiguration()
        }
        return {
          ...baseline,
          model: LAYA_MODEL,
          capabilities: Object.fromEntries(
            local.capabilities.map((id) => [
              id,
              {
                mode:
                  baseline.capabilities[id]?.mode && baseline.capabilities[id]?.mode !== 'off'
                    ? 'shadow'
                    : 'off'
              }
            ])
          )
        }
      }
    })
  }

  private async settings() {
    try {
      return settingsSchema.parse(JSON.parse(await readBoundedConfiguration(this.path)))
    } catch {
      return undefined
    }
  }

  observe(request: DecisionRequest, baseline: DecisionResult): void {
    this.service.observeShadow(
      { ...request, model: LAYA_MODEL },
      {
        comparison: Object.fromEntries(
          Object.entries(baseline.answers).map(([id, answer]) => [
            id,
            answer.type === 'choice'
              ? answer.choice
              : answer.type === 'score'
                ? answer.score
                : answer.noul
          ])
        )
      }
    )
  }

  async status() {
    const settings = await this.settings()
    return {
      configured: Boolean(settings),
      enabled: settings?.enabled ?? false,
      mode: 'shadow' as const,
      model: LAYA_MODEL,
      checkpointReadiness: 'unverified' as const,
      telemetry: this.service.telemetry.snapshot(),
      measurement: this.service.telemetry.measurementSnapshot()
    }
  }
}
