import type React from 'react'
import CommentMarkdown from '../sidebar/CommentMarkdown'

type WorkflowMarkdownProps = Omit<React.ComponentProps<typeof CommentMarkdown>, 'remoteImages'>

// Why: every workflow answer was written by a model that may have read hostile text.
export function WorkflowMarkdown(props: WorkflowMarkdownProps): React.JSX.Element {
  return <CommentMarkdown variant="document" {...props} remoteImages="link" />
}
