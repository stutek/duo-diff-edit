// A file of the last answer and, for one outside the session's root, its project's folder name ('' inside the root).
export type Paths = { path: string; project: string }[]

declare module 'claude-code' {
  interface PluginState {
    'duo-diff-edit': { paths: Paths }
  }
}
