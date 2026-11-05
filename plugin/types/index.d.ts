export type Paths = string[]

declare module 'claude-code' {
  interface PluginState {
    'duo-diff-edit': { paths: Paths }
  }
}
