import { ipcRenderer } from 'electron'
import type { McpConnectorsApi } from '../../shared/mcp-connectors'

export function createMcpConnectorsApi(): McpConnectorsApi {
  return {
    accounts: () => ipcRenderer.invoke('mcpConnectors:accounts'),
    list: (id) => ipcRenderer.invoke('mcpConnectors:list', id),
    add: (id, definition) => ipcRenderer.invoke('mcpConnectors:add', id, definition),
    action: (id, name, action) => ipcRenderer.invoke('mcpConnectors:action', id, name, action)
  }
}
