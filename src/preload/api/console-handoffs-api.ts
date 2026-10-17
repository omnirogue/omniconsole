import type { IpcRenderer } from 'electron'
import type { ConsoleHandoffApi } from '../../shared/console-handoff-contract'

export function createConsoleHandoffsApi(ipc: Pick<IpcRenderer, 'invoke'>): ConsoleHandoffApi {
  return {
    archiveMessage: (args) => ipc.invoke('consoleHandoffs:archiveMessage', args),
    getAgentMessage: (args) => ipc.invoke('consoleHandoffs:getAgentMessage', args),
    readAgentMessage: (args) => ipc.invoke('consoleHandoffs:readAgentMessage', args),
    resolveAgentMessage: (args) => ipc.invoke('consoleHandoffs:resolveAgentMessage', args),
    agentMessageFiles: (args) => ipc.invoke('consoleHandoffs:agentMessageFiles', args),
    downloadAgentFile: (args) => ipc.invoke('consoleHandoffs:downloadAgentFile', args),
    agentRecipients: () => ipc.invoke('consoleHandoffs:agentRecipients'),
    sendAgent: (args) => ipc.invoke('consoleHandoffs:sendAgent', args),
    list: (args) => ipc.invoke('consoleHandoffs:list', args),
    markRead: (args) => ipc.invoke('consoleHandoffs:markRead', args),
    get: (args) => ipc.invoke('consoleHandoffs:get', args),
    recipients: () => ipc.invoke('consoleHandoffs:recipients'),
    taskFiles: (args) => ipc.invoke('consoleHandoffs:taskFiles', args),
    send: (args) => ipc.invoke('consoleHandoffs:send', args),
    sendCardless: (args) => ipc.invoke('consoleHandoffs:sendCardless', args),
    uploadThreadFile: (args) => ipc.invoke('consoleHandoffs:uploadThreadFile', args),
    bindThread: (args) => ipc.invoke('consoleHandoffs:bindThread', args),
    forward: (args) => ipc.invoke('consoleHandoffs:forward', args),
    review: (args) => ipc.invoke('consoleHandoffs:review', args),
    respond: (args) => ipc.invoke('consoleHandoffs:respond', args),
    archive: (args) => ipc.invoke('consoleHandoffs:archive', args),
    returnFile: (args) => ipc.invoke('consoleHandoffs:returnFile', args),
    readFile: (args) => ipc.invoke('consoleHandoffs:readFile', args),
    readAttachment: (args) => ipc.invoke('consoleHandoffs:readAttachment', args),
    uploadFile: (args) => ipc.invoke('consoleHandoffs:uploadFile', args),
    downloadFile: (args) => ipc.invoke('consoleHandoffs:downloadFile', args),
    prepareRoutes: (args) => ipc.invoke('consoleHandoffs:prepareRoutes', args),
    materialize: (args) => ipc.invoke('consoleHandoffs:materialize', args)
  }
}
