import { useEffect, useState } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { inspectMcpConfigContent, MCP_CONFIG_CANDIDATES } from '../../../../shared/mcp-config'
import type { SkillDiscoveryResult } from '../../../../shared/skills'
import type { RuntimeFileReadResult } from '../../../../shared/runtime-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { loadMcpConfigInspections } from '@/components/settings/mcp-config-inspection'

export function useAutomationToolCatalog(
  repo: Repo | undefined,
  worktreeId: string,
  agent: string
) {
  const [catalog, setCatalog] = useState({
    skills: [] as string[],
    mcpServers: [] as string[],
    error: ''
  })
  useEffect(() => {
    let current = true
    setCatalog({ skills: [], mcpServers: [], error: '' })
    if (!repo) {
      return
    }
    const host = parseExecutionHostId(getRepoExecutionHostId(repo))
    const target =
      host?.kind === 'runtime'
        ? { kind: 'environment' as const, environmentId: host.environmentId }
        : { kind: 'local' as const }
    const skills = callRuntimeRpc<SkillDiscoveryResult>(
      target,
      'skills.discover',
      { cwd: repo.path, worktreeId },
      { timeoutMs: 15_000 }
    )
    const configs =
      host?.kind === 'runtime'
        ? Promise.all(
            MCP_CONFIG_CANDIDATES.map(async (candidate) => {
              if (!worktreeId) {
                throw new Error('Select a workspace to inspect its connectors.')
              }
              try {
                const file = await callRuntimeRpc<RuntimeFileReadResult>(target, 'files.read', {
                  worktree: `id:${worktreeId}`,
                  relativePath: candidate.relativePath
                })
                if (file.truncated) {
                  throw new Error('Connector configuration is too large to inspect.')
                }
                return inspectMcpConfigContent(candidate, file.content)
              } catch (error) {
                if (/ENOENT|no such file/i.test(String(error))) {
                  return inspectMcpConfigContent(candidate, null)
                }
                throw error
              }
            })
          )
        : loadMcpConfigInspections(repo.path, repo.connectionId ?? undefined)
    void Promise.allSettled([skills, configs]).then(([skillResult, configResult]) => {
      if (!current) {
        return
      }
      setCatalog({
        skills:
          skillResult.status === 'fulfilled'
            ? skillResult.value.skills
                .filter(
                  (skill) =>
                    skill.installed &&
                    skill.providers.some(
                      (provider) => provider === 'agent-skills' || provider === agent
                    )
                )
                .map((skill) => skill.name)
            : [],
        mcpServers:
          configResult.status === 'fulfilled'
            ? [
                ...new Set(
                  configResult.value.flatMap((config) =>
                    config.servers
                      .filter((server) => server.status === 'enabled')
                      .map((server) => server.name)
                  )
                )
              ]
            : [],
        error: [skillResult, configResult]
          .filter((result) => result.status === 'rejected')
          .map((result) => String(result.reason))
          .join('; ')
      })
    })
    return () => {
      current = false
    }
  }, [repo, worktreeId, agent])
  return catalog
}
