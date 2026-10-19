import { getAgentCatalog } from '@/lib/agent-catalog'
import {
  getAgentAwakeDescription,
  getAgentAwakeSearchKeywords,
  getAgentAwakeTitle
} from './agent-awake-copy'
import {
  getAgentGeneratedTabTitlesDescription,
  getAgentGeneratedTabTitlesSearchKeywords,
  getAgentGeneratedTabTitlesTitle
} from './agent-generated-tab-title-copy'
import {
  getAgentStatusHooksDescription,
  getAgentStatusHooksSearchKeywords,
  getAgentStatusHooksTitle
} from './agent-status-hooks-copy'
import { getAgentCacheTimerSearchEntries } from './agent-cache-timer-search'
import {
  getDeliverableCheckDescription,
  getDeliverableCheckSearchKeywords,
  getDeliverableCheckTitle
} from './deliverable-check-copy'
import { translate } from '@/i18n/i18n'
import { searchKeywords, translateSearchKeyword, uniqueKeywords } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

function buildAgentSettingsKeywords(): string[] {
  const keywords = searchKeywords([
    { key: 'auto.components.settings.agents.search.96ba2373b6', fallback: 'agent' },
    { key: 'auto.components.settings.agents.search.d8f3a8b8a0', fallback: 'default' },
    { key: 'auto.components.settings.agents.search.167daeb5e9', fallback: 'command' },
    { key: 'auto.components.settings.agents.search.be59907510', fallback: 'override' },
    { key: 'auto.components.settings.agents.search.a6d594c17d', fallback: 'install' },
    { key: 'auto.components.settings.agents.search.f2932bf22b', fallback: 'detected' },
    { key: 'auto.components.settings.agents.search.2afd3b5858', fallback: 'enable' },
    { key: 'auto.components.settings.agents.search.60393e1b17', fallback: 'disable' },
    { key: 'auto.components.settings.agents.search.2e188c771c', fallback: 'hide' },
    { key: 'auto.components.settings.agents.search.87fffe6c20', fallback: 'show' },
    { key: 'auto.components.settings.agents.search.permission', fallback: 'permission' },
    { key: 'auto.components.settings.agents.search.permissions', fallback: 'permissions' },
    { key: 'auto.components.settings.agents.search.yolo', fallback: 'yolo', englishOnly: true },
    { key: 'auto.components.settings.agents.search.manual', fallback: 'manual' },
    { key: 'auto.components.settings.agents.search.plan', fallback: 'plan' },
    { key: 'auto.components.settings.agents.search.readOnly', fallback: 'read-only' },
    { key: 'auto.components.settings.agents.search.approve', fallback: 'approve' },
    {
      key: 'auto.components.settings.agents.search.e2b7c0dcd7',
      fallback: 'github',
      englishOnly: true
    }
  ])

  for (const agent of getAgentCatalog()) {
    keywords.push(...expandAgentSearchText(agent.id), ...expandAgentSearchText(agent.label))
    keywords.push(...expandAgentSearchText(agent.cmd))
  }

  return uniqueKeywords(keywords)
}

function expandAgentSearchText(value: string): string[] {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()

  return spaced === value ? [value] : [value, spaced]
}

type AgentsPaneSearchOptions = {
  includeAgentAwake?: boolean
  includeAgentRuntime?: boolean
  /** Instruction files and Local Ollama exist only in the desktop window. */
  includeDesktopOnly?: boolean
}

const DESKTOP_ONLY_SEARCH_ENTRY_IDS = new Set(['instruction-files', 'local-ollama'])

const AGENT_AWAKE_SEARCH_ENTRY_ID = 'agent-awake'
const AGENT_RUNTIME_SEARCH_ENTRY_ID = 'agent-runtime'

const getAllAgentsPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.agents.search.bb9ad95777', 'Agents'),
    description: translate(
      'auto.components.settings.agents.search.01926b9d8c',
      'Configure AI coding agents, default agent, and command overrides.'
    ),
    keywords: buildAgentSettingsKeywords()
  },
  {
    title: translate('auto.components.settings.agents.search.agentRuntime', 'Agent Runtime'),
    id: AGENT_RUNTIME_SEARCH_ENTRY_ID,
    description: translate(
      'auto.components.settings.agents.search.agentRuntimeDescription',
      'Choose whether agents are detected and launched on Windows or in WSL by default.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.agents.search.96ba2373b6', 'agent'),
      ...translateSearchKeyword('auto.components.settings.agents.search.runtime', 'runtime'),
      ...translateSearchKeyword('auto.components.settings.agents.search.d2952dfd74', 'location'),
      ...translateSearchKeyword(
        'auto.components.settings.agents.search.agentLocation',
        'agent location'
      ),
      ...translateSearchKeyword('auto.components.settings.agents.search.77c02fa3c3', 'windows'),
      ...translateSearchKeyword('auto.components.settings.agents.search.d608654c03', 'wsl'),
      ...translateSearchKeyword('auto.components.settings.agents.search.f622b8eb2a', 'linux'),
      ...translateSearchKeyword('auto.components.settings.agents.search.839e82c81f', 'detect'),
      ...translateSearchKeyword('auto.components.settings.agents.search.2814401339', 'installed'),
      ...translateSearchKeyword(
        'auto.components.settings.agents.search.installedAgentsWsl',
        'installed agents in wsl'
      ),
      ...translateSearchKeyword('auto.components.settings.agents.search.719f53350c', 'path')
    ]
  },
  {
    title: translate('components.settings.agentTemplates.title', 'Agent templates'),
    id: 'agent-templates',
    description: translate(
      'auto.components.settings.agents.search.agentTemplatesDescription',
      'Reusable instructions the launcher adds after the workspace’s own files.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.agents.search.template', 'template'),
      ...translateSearchKeyword('auto.components.settings.agents.search.templates', 'templates'),
      ...translateSearchKeyword(
        'auto.components.settings.agents.search.instructions',
        'instructions'
      ),
      ...translateSearchKeyword('auto.components.settings.agents.search.reviewer', 'reviewer'),
      ...translateSearchKeyword('auto.components.settings.agents.search.developer', 'developer'),
      ...translateSearchKeyword('auto.components.settings.agents.search.researcher', 'researcher')
    ]
  },
  {
    title: translate('components.settings.instructionFiles.title', 'Instruction files'),
    id: 'instruction-files',
    description: translate(
      'auto.components.settings.agents.search.instructionFilesDescription',
      'The AGENTS.md and CLAUDE.md files sessions in the workspace read, plus the global OpenCode rules.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.agents.search.agentsMd', 'agents.md', {
        englishOnly: true
      }),
      ...translateSearchKeyword('auto.components.settings.agents.search.claudeMd', 'claude.md', {
        englishOnly: true
      }),
      ...translateSearchKeyword('auto.components.settings.agents.search.rules', 'rules'),
      ...translateSearchKeyword(
        'auto.components.settings.agents.search.instructions',
        'instructions'
      )
    ]
  },
  {
    title: translate('components.settings.localOllama.title', 'Local Ollama'),
    id: 'local-ollama',
    description: translate(
      'auto.components.settings.agents.search.localOllamaDescription',
      'The local model server OpenCode runs against: models, pulls, remembered picks.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.agents.search.ollama', 'ollama', {
        englishOnly: true
      }),
      ...translateSearchKeyword('auto.components.settings.agents.search.opencode', 'opencode', {
        englishOnly: true
      }),
      ...translateSearchKeyword('auto.components.settings.agents.search.localModel', 'local model'),
      ...translateSearchKeyword('auto.components.settings.agents.search.pull', 'pull')
    ]
  },
  {
    title: getAgentStatusHooksTitle(),
    description: getAgentStatusHooksDescription(),
    keywords: getAgentStatusHooksSearchKeywords()
  },
  {
    title: getAgentGeneratedTabTitlesTitle(),
    description: getAgentGeneratedTabTitlesDescription(),
    keywords: getAgentGeneratedTabTitlesSearchKeywords()
  },
  {
    title: getDeliverableCheckTitle(),
    description: getDeliverableCheckDescription(),
    keywords: getDeliverableCheckSearchKeywords()
  },
  {
    title: getAgentAwakeTitle(),
    id: AGENT_AWAKE_SEARCH_ENTRY_ID,
    description: getAgentAwakeDescription(),
    keywords: getAgentAwakeSearchKeywords()
  },
  {
    title: translate(
      'auto.components.settings.agents.search.agentPermissions',
      'Agent Permissions'
    ),
    description: translate(
      'auto.components.settings.agents.search.agentPermissionsDescription',
      'Switch agent permission defaults between Yolo, Plan, Read-only, and Approve.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.agents.search.permission', 'permission'),
      ...translateSearchKeyword(
        'auto.components.settings.agents.search.permissions',
        'permissions'
      ),
      ...translateSearchKeyword('auto.components.settings.agents.search.yolo', 'yolo'),
      ...translateSearchKeyword('auto.components.settings.agents.search.manual', 'manual'),
      ...translateSearchKeyword('auto.components.settings.agents.search.plan', 'plan'),
      ...translateSearchKeyword('auto.components.settings.agents.search.readOnly', 'read-only'),
      ...translateSearchKeyword('auto.components.settings.agents.search.approve', 'approve'),
      ...translateSearchKeyword('auto.components.settings.agents.search.skip', 'skip'),
      ...translateSearchKeyword('auto.components.settings.agents.search.checks', 'checks')
    ]
  },
  ...getAgentCacheTimerSearchEntries()
])

export function getAgentsPaneSearchEntries({
  includeAgentAwake = true,
  includeAgentRuntime = true,
  includeDesktopOnly = true
}: AgentsPaneSearchOptions = {}) {
  const entries = getAllAgentsPaneSearchEntries()
  return entries.filter(
    (entry) =>
      (!('id' in entry) || entry.id !== AGENT_RUNTIME_SEARCH_ENTRY_ID || includeAgentRuntime) &&
      (!('id' in entry) || entry.id !== AGENT_AWAKE_SEARCH_ENTRY_ID || includeAgentAwake) &&
      (!('id' in entry) || !DESKTOP_ONLY_SEARCH_ENTRY_IDS.has(entry.id) || includeDesktopOnly)
  )
}
