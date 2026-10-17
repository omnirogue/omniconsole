import { readGraphItems } from './graph/graph-items'

/** A list step's answer as a person reads it: one numbered section per item. */
function itemsMarkdown(items: NonNullable<ReturnType<typeof readGraphItems>>): string {
  if (!items.length) {
    return '_Nothing to report._'
  }
  return items
    .map((item, index) => {
      const place =
        item.location && !item.location.includes('`') ? `\`${item.location}\`` : item.location
      const meta = [item.severity !== 'none' ? `**${item.severity}**` : '', place]
        .filter(Boolean)
        .join(' · ')
      return [`#### ${index + 1}. ${item.title}`, meta, item.detail].filter(Boolean).join('\n\n')
    })
    .join('\n\n---\n\n')
}

export function localWorkflowResultMarkdown(value: unknown): string {
  if (
    value &&
    typeof value === 'object' &&
    'markdown' in value &&
    typeof value.markdown === 'string'
  ) {
    return value.markdown
  }
  const items = readGraphItems(value)
  if (items) {
    return itemsMarkdown(items)
  }
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
}
