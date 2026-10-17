import { describe, expect, it } from 'vitest'
import { OMNISI_MCP_URL } from './omni-console-mcp-ledger-headers'
import {
  getDefaultOmniSiOssMcpServers,
  getOmniSiCloudUpgradeCapabilities,
  getOmniSiOssProject,
  OMNISI_CLOUD,
  OMNISI_OSS_PROJECT_IDS,
  OMNISI_OSS_SUITE
} from './omnisi-oss-ecosystem'

describe('OmniSI open-source suite', () => {
  it('lists every project under github.com/omnirogue', () => {
    expect(OMNISI_OSS_SUITE.map((project) => project.id)).toEqual([...OMNISI_OSS_PROJECT_IDS])
    for (const project of OMNISI_OSS_SUITE) {
      expect(project.repositoryUrl).toBe(`https://github.com/${project.repository}`)
      expect(project.repository.startsWith('omnirogue/')).toBe(true)
    }
    expect(getOmniSiOssProject('omniconsole').repositoryUrl).toBe(
      'https://github.com/omnirogue/omniconsole'
    )
  })

  it('configures only the local stdio MCP servers', () => {
    expect(getDefaultOmniSiOssMcpServers()).toEqual({
      omniseek: { command: 'omniseek-mcp', args: [] },
      omnievolve: { command: 'omnievolve-mcp', args: [] },
      jevlab: { command: 'jevlab-mcp', args: [] }
    })
    const servers = getDefaultOmniSiOssMcpServers()
    servers.omniseek.args.push('--changed')
    expect(getDefaultOmniSiOssMcpServers().omniseek.args).toEqual([])
  })

  it('ties every cloud capability to the open-source project it extends', () => {
    const capabilities = getOmniSiCloudUpgradeCapabilities()
    expect(capabilities.map((capability) => capability.id)).toEqual([
      'engine-throughput',
      'pareto-novelty-evolve',
      'calibrated-jev-oracle',
      'team-rbac-fleet'
    ])
    for (const capability of capabilities) {
      expect(OMNISI_OSS_PROJECT_IDS).toContain(capability.extends)
      expect(capability.openSource).not.toBe(capability.cloud)
    }
    expect(OMNISI_CLOUD.mcpUrl).toBe(OMNISI_MCP_URL)
  })
})
