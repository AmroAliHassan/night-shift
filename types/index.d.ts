/** Whether Claude may take direction decisions (routes, looks, structure) at night. */
export type Direction = 'hold' | 'decide'

/** One night shift, from Goodnight to Goodmorning. */
export type Night = {
  /** When Goodnight was pressed (wall clock, ms). */
  startedAt: number
  /** The session's Claude cost when the night began, so the night's own spend can be told apart. */
  costAtStart: number | null
  /** Turns the mod started by itself to keep the work going. */
  turns: number
  /** Model requests during the night, main session and agents. */
  steps: number
  /** DECISION and HELD lines in the night log, counted from the file. */
  decisions: number
  held: number
  /** The night log file. */
  log: string
  direction: Direction
  /** Why auto-continue stopped (done, blocked, the cap, the turn limit, you stopped it); null while it runs. */
  stopped: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'night-shift': {
      night: Night | null
      direction: Direction
      /** When the switch last flipped, so the strip plays its motion once. */
      switchedAt: number
      /** Once a minute during the night, so the strip's clock and counters move. */
      tick: number
      /** The night's Claude cost so far, refreshed with the tick. */
      spent: number | null
      /** A Goodnight or Goodmorning press waiting out its few seconds, so a mistaken one can be cancelled. */
      pending: { to: 'night' | 'morning'; at: number } | null
      /** The night's counts as of the last minute tick, so the strip redraws at most once a minute. */
      stats: { steps: number; decisions: number; held: number } | null
      /** The usage meters (context, plan windows) the usage row draws. */
      usage: Array<{ label: string; percent: number }>
      /** True while a /compact the usage row started is running. */
      compacting: boolean
      /** The keep-warm window this mod armed through cache-tax's /keepwarm (until when, and why: day or night), or null. */
      warm: { until: number; why: string } | null
      /** Auto or Off, from the usage bar's Warm button. */
      warmMode: 'auto' | 'off'
      /** When the main conversation last called the model: the cache lasts an hour from it. */
      lastRequest: number
      /** The context's size in tokens, for Auto's big-session rule. */
      contextTokens: number
      /** Whether cache-tax's /keepwarm is installed, so the Warm button can drive it. */
      canWarm: boolean
    }
  }
}
