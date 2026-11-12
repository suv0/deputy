export type DeputyLine = {
  line: string
  color: 'success' | 'warning' | 'error'
  links: { text: string; href: string }[]
  readAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'deputy-status': { line: DeputyLine | null }
  }
}
