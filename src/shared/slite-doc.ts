/** A Slite doc as the right panel shows it: its Markdown, never the API key that read it. */
export type SliteDocResult =
  | {
      status: 'ok'
      id: string
      title: string
      markdown: string
      url: string
      updatedAt: string | null
    }
  | { status: 'no-key'; message: string }
  | { status: 'error'; message: string }
