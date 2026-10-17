import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

export async function loadProductionPrimitives() {
  const source = new URL('../../src/', import.meta.url).href
  // Node's type transformer does not resolve extensionless TS imports. Scope to source only.
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        context.parentURL?.startsWith(source) &&
        specifier.startsWith('.') &&
        !/\.[cm]?[jt]s$/.test(specifier)
      ) {
        const candidate = new URL(`${specifier}.ts`, context.parentURL)
        if (candidate.href.startsWith(source) && existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true }
        }
      }
      return nextResolve(specifier, context)
    }
  })
  try {
    const [provider, contract, reader, baseline, laya, layaContract] = await Promise.all([
      import('../../src/main/structured-decisions/typesafe-provider.ts'),
      import('../../src/shared/structured-decisions.ts'),
      import('../../src/shared/fetch-response-body.ts'),
      import('../../src/shared/agent-turn-failure.ts'),
      import('../../src/main/structured-decisions/laya-provider.ts'),
      import('../../src/shared/laya-shadow.ts')
    ])
    return {
      ...provider,
      ...laya,
      layaModel: layaContract.LAYA_MODEL,
      snapshotDecisionRequest: contract.snapshotDecisionRequest,
      validateDecisionResult: contract.validateDecisionResult,
      readFetchResponseJsonWithinLimit: reader.readFetchResponseJsonWithinLimit,
      classifyAgentTurnFailure: baseline.classifyAgentTurnFailure
    }
  } finally {
    hook.deregister()
  }
}
