export type KeptLimit = { kind: string; percentUsed: number; resetsAt?: string }

// Kept in $.state for the session, so a reload of the mod (a changed option) or a hooks
// worker the engine replaces does not forget an account switch: both start the module
// over, while the host's own figures may still be the old account's. `session` is the id
// of the session it belongs to; `waiting`: the new account has not answered yet.
export type KeptAccount = {
  session: string
  account: string | null
  waiting: boolean
  switchPending: boolean
  reading: { at: number; account: string; limits: KeptLimit[] } | null
}

declare module 'claude-code' {
  interface PluginState {
    'limit-bars': {
      account: KeptAccount
    }
  }
}
