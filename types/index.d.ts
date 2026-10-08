export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'limit-bars': { limits: Limit[]; now: number }
  }
}
