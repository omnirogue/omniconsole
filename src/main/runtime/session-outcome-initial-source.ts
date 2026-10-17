import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { FLEET_SOURCE_MAX_FILES } from '../../shared/conversation-fleet-source-snapshot'
import type { SessionChain } from '../../shared/session-chain-types'
import { sessionChainStepOutputDir } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { observeSessionOutcomeSource } from './session-outcome-source'
import { sessionOutcomeWorkflowPort } from './session-outcome-workflow-port'
import { isImplicitFleetSecret } from './conversation-fleet-source-git'

async function existingSourceFiles(root: string, candidates: string[]): Promise<string[]> {
  const files = new Set<string>()
  for (const candidate of candidates) {
    const path = resolve(root, candidate)
    const inside = relative(root, path)
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      continue
    }
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    })
    if (!info?.isFile() || info.isSymbolicLink()) {
      continue
    }
    const canonical = relative(root, await realpath(path))
    if (canonical !== inside) {
      throw new Error('A source result file resolves through a symbolic link.')
    }
    const portable = inside.split(sep).join('/')
    if (isImplicitFleetSecret(portable)) {
      continue
    }
    files.add(portable)
  }
  if (files.size > FLEET_SOURCE_MAX_FILES) {
    throw new Error(`The completed source names more than ${FLEET_SOURCE_MAX_FILES} result files.`)
  }
  return [...files]
}

/** Capture only after real source completion; subsequent retries reuse the retained exact snapshot. */
export async function captureInitialSessionOutcomeSource(
  runtime: OrcaRuntimeService,
  chain: SessionChain
): Promise<SessionChain> {
  const set = chain.outcomeSet!
  const owner = set.continuation
  if (owner.initialSource || !owner.planningSource) {
    return chain
  }
  if (!owner.sourceReady || !owner.sourceVersion || !owner.taskId || !owner.principal) {
    throw new Error('Wait for the original source to finish before capturing its review inputs.')
  }
  const sourceWorktreeId = chain.sourceWorktreeId ?? chain.worktreeId
  const scope = await runtime.getSessionOutcomeExecutionScope(sourceWorktreeId)
  if (scope.connectionId || scope.wslDistro) {
    throw new Error('The source snapshot must be captured by its own execution host.')
  }
  const context = await runtime.readSessionOutcomeSourceContext(
    chain.sourcePaneKey,
    sourceWorktreeId
  )
  if (
    !context ||
    context.paneKey !== chain.sourcePaneKey ||
    context.handle !== owner.planningSource.coordinatorHandle ||
    context.processIncarnation !== owner.planningSource.processIncarnation
  ) {
    throw new Error(
      'The completed source agent identity or actual model could not be verified on its host.'
    )
  }
  const root = await realpath(scope.path)
  const paths = await existingSourceFiles(root, [
    ...context.files,
    ...set.outcomes.flatMap((outcome) =>
      outcome.conditions.flatMap((condition) => [
        ...(condition.kind === 'file' ? [condition.target] : []),
        ...(condition.fileVersions?.map((file) => file.path) ?? [])
      ])
    )
  ])
  const capture = sessionOutcomeWorkflowPort().captureSourceInputs
  if (!capture) {
    throw new Error(
      'This execution host cannot capture completed source inputs. Update its outcome adapter.'
    )
  }
  const key = createHash('sha256').update(owner.sourceVersion).digest('hex').slice(0, 24)
  const resultPath = `${relative(root, sessionChainStepOutputDir(root, chain.id, `source_${key}`))
    .split(sep)
    .join('/')}/source-result.md`
  const snapshot = await capture(runtime, {
    taskId: owner.taskId,
    principal: owner.principal,
    worktree: `id:${sourceWorktreeId}`,
    selectedSourcePaths: paths,
    sourceResult: {
      path: resultPath,
      content: context.summary || 'The completed source returned no final text.'
    }
  })
  const observed = await observeSessionOutcomeSource(runtime, chain, { successfulOnly: true })
  if (!observed.ready || observed.version !== owner.sourceVersion) {
    throw new Error(
      'The source changed while its result was being captured. Wait for its current work to finish.'
    )
  }
  return {
    ...chain,
    outcomeSet: {
      ...set,
      continuation: {
        ...owner,
        initialSource: {
          sourceVersion: owner.sourceVersion,
          paneKey: context.paneKey,
          worktreeId: sourceWorktreeId,
          handle: context.handle,
          processIncarnation: context.processIncarnation,
          producer: { provider: context.agent, model: context.model },
          ...(context.effort ? { effort: context.effort } : {}),
          ...snapshot
        }
      }
    }
  }
}
