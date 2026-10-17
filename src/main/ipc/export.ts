import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { ExportTimeoutError, htmlToPdf } from '../lib/html-to-pdf'

export type ExportHtmlToPdfArgs = {
  html: string
  title: string
}

export type ExportHtmlToPdfResult =
  | { success: true; filePath: string }
  | { success: false; cancelled?: boolean; error?: string }

export type TextFileArgs = { extensions: string[]; filterName: string }
export type SaveTextFileResult =
  | { success: true; filePath: string }
  | { success: false; cancelled?: boolean; error?: string }
export type OpenTextFileResult =
  | { success: true; filePath: string; content: string }
  | { success: false; cancelled?: boolean; error?: string }

const MAX_OPEN_TEXT_BYTES = 2 * 1024 * 1024

// Why: the person picks every path in a system dialog, so these write and read only what they chose.
function registerTextFileHandlers(): void {
  ipcMain.removeHandler('export:save-text')
  ipcMain.handle(
    'export:save-text',
    async (
      event,
      args: TextFileArgs & { content: string; suggestedName: string }
    ): Promise<SaveTextFileResult> => {
      const name = args.suggestedName.replace(/[/\\:*?"<>|]/g, '_').slice(0, 100) || 'export'
      const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const options = {
        defaultPath: name,
        filters: [{ name: args.filterName, extensions: args.extensions }]
      }
      const { canceled, filePath } = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)
      if (canceled || !filePath) {
        return { success: false, cancelled: true }
      }
      try {
        await writeFile(filePath, args.content, 'utf8')
        return { success: true, filePath }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
  ipcMain.removeHandler('export:open-text')
  ipcMain.handle(
    'export:open-text',
    async (event, args: TextFileArgs): Promise<OpenTextFileResult> => {
      const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const options = {
        properties: ['openFile' as const],
        filters: [{ name: args.filterName, extensions: args.extensions }]
      }
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      const filePath = result.filePaths[0]
      if (result.canceled || !filePath) {
        return { success: false, cancelled: true }
      }
      try {
        if ((await stat(filePath)).size > MAX_OPEN_TEXT_BYTES) {
          return { success: false, error: 'The file is too large (over 2 MB).' }
        }
        return { success: true, filePath, content: await readFile(filePath, 'utf8') }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}

export function registerExportHandlers(): void {
  registerTextFileHandlers()
  ipcMain.removeHandler('export:html-to-pdf')
  ipcMain.handle(
    'export:html-to-pdf',
    async (event, args: ExportHtmlToPdfArgs): Promise<ExportHtmlToPdfResult> => {
      const { html, title } = args
      if (!html.trim()) {
        return { success: false, error: 'No content to export' }
      }

      try {
        const pdfBuffer = await htmlToPdf(html)

        // Why: sanitize to keep the suggested filename legal on every platform.
        // Windows forbids /\:*?"<>| in filenames; truncate to keep the OS save
        // dialog stable when titles are pathologically long.
        const sanitizedTitle = title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 100) || 'export'
        const defaultFilename = `${sanitizedTitle}.pdf`

        const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
        const dialogOptions = {
          defaultPath: defaultFilename,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        }
        const { canceled, filePath } = parent
          ? await dialog.showSaveDialog(parent, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions)

        if (canceled || !filePath) {
          return { success: false, cancelled: true }
        }

        await writeFile(filePath, pdfBuffer)
        return { success: true, filePath }
      } catch (error) {
        if (error instanceof ExportTimeoutError) {
          return { success: false, error: 'Export timed out' }
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to export PDF'
        }
      }
    }
  )
}
