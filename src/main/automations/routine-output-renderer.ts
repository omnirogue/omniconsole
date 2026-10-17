import { marked } from 'marked'
import type { AutomationOutputFormat } from '../../shared/automation-definition-context'

export async function renderRoutineOutput(
  content: string,
  format: AutomationOutputFormat = 'markdown'
): Promise<string> {
  const unfenced = content
    .trim()
    .replace(/^```(?:json|csv|html)?\s*\n/, '')
    .replace(/\n```$/, '')
  switch (format) {
    case 'markdown':
      return content
    case 'html':
      return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head><body>${await marked.parse(content)}</body></html>`
    case 'json':
      return JSON.stringify(JSON.parse(unfenced), null, 2)
    case 'csv':
      return unfenced
    case 'docx':
    case 'pdf':
      throw new Error(
        `Output rendering is unavailable for ${format}. Choose markdown, HTML, JSON, or CSV.`
      )
  }
}
