import { ipcMain } from 'electron'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ConnectorAction, ConnectorDefinition } from '../../shared/mcp-connectors'
import { connectorAccounts } from '../mcp/connector-accounts'
import { ConnectorService } from '../mcp/connector-service'

export function registerMcpConnectorHandlers(settings: () => GlobalSettings): void {
  const service = new ConnectorService(settings)
  ipcMain.handle('mcpConnectors:accounts', () => connectorAccounts(settings()))
  ipcMain.handle('mcpConnectors:list', (_event, id: string) => service.list(id))
  ipcMain.handle('mcpConnectors:add', (_event, id: string, definition: ConnectorDefinition) =>
    service.add(id, definition)
  )
  ipcMain.handle(
    'mcpConnectors:action',
    (_event, id: string, name: string, action: ConnectorAction) => service.action(id, name, action)
  )
}
