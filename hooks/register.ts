import type { Register, EngineInterface } from 'claude-code'
import type { Direction, Night } from '../types'

// Goodnight and Goodmorning. Goodnight hands the session to Claude as the
// person's co-pilot: a night rule joins the system prompt, questions are
// answered for them, every decision goes into a night log, and each finished
// turn is followed by "continue" until the work is done, blocked, at the spend
// cap or at the turn limit. Goodmorning ends the night and asks for a morning
// report. The strip above the prompt is a sunrise by day and deep ocean by
// night, with the night's direction choice and the Goodnight | Goodmorning
// switch attached inside its right end.

const NIGHT = { plugin: 'night-shift', key: 'night' } as const
const DIRECTION = { plugin: 'night-shift', key: 'direction' } as const
const SWITCHED = { plugin: 'night-shift', key: 'switchedAt' } as const
const TICK = { plugin: 'night-shift', key: 'tick' } as const
const SPENT = { plugin: 'night-shift', key: 'spent' } as const
const STORE_PREFIX = 'night:'
const DIRECTION_KEY = 'direction'
const KEEP_MS = 36 * 60 * 60 * 1000
const CONTINUE_DELAY_MS = 3000
const MOTION_MS = 2500
const SEND_DELAY_MS = 300
// 0.1.3: a press waits this long, so a mistaken one can be cancelled by pressing again.
const GRACE_MS = 4000
const PENDING = { plugin: 'night-shift', key: 'pending' } as const
const STATS = { plugin: 'night-shift', key: 'stats' } as const
const USAGE = { plugin: 'night-shift', key: 'usage' } as const
const COMPACTING = { plugin: 'night-shift', key: 'compacting' } as const
type Pending = { to: 'night' | 'morning'; at: number }
const DONE_RE = /NIGHT-SHIFT:\s*DONE/i
const BLOCKED_RE = /NIGHT-SHIFT:\s*BLOCKED[:\s]*([^\n]*)/i

type Cfg = { cap: number; maxTurns: number; logFolder: string; showStrip: boolean; usageRow: boolean; wakeAt: string }

// --- words -------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, '0')
export const fmtClock = (ms: number): string => {
  const d = new Date(ms)
  const h = d.getHours()
  return `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'am' : 'pm'}`
}
export const fmtSpan = (ms: number): string => {
  const m = Math.max(0, Math.floor(ms / 60000))
  return `${Math.floor(m / 60)}:${pad(m % 60)}`
}
const fmtUsd = (usd: number | null): string => (usd === null ? 'US$?' : `US$${usd.toFixed(2)}`)
const dateTag = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const nightRule = (n: Night, cfg: Cfg, spent: number | null): string => `# Night shift (night-shift mod)
The user pressed Goodnight at ${fmtClock(n.startedAt)} and is asleep. You are their co-pilot until they press Goodmorning.
- Do not ask the user anything: questions are answered for you. Decide yourself: take your recommended option, and add each decision to the night log (${n.log}) as one line: \`- DECISION <time>: <what> - why: <reason>; other options: <...>\`.
- Keep working until the job is finished. End a turn with \`NIGHT-SHIFT: DONE\` when everything is finished, or \`NIGHT-SHIFT: BLOCKED: <why>\` when nothing more can be done without the user. Otherwise the shift continues on its own.
${n.direction === 'decide'
  ? '- Direction: you may take direction decisions too (design routes, looks, structure, scope). Pick your recommendation and log it as `- DECISION <time> (direction): ...` with the alternatives, so the user can switch in the morning.'
  : '- Direction: do not take direction decisions (design routes, looks, structure, scope, anything a gate needs the user to pick). Prepare the options, log them as `- HELD <time>: <choice> - options: ...`, and move on to work that does not depend on it.'}
- Money: you may use paid credits the user already approved in this conversation, up to the approved amount. Any new paid spend: prepare it, log it as HELD, and do not run it.
- Never at night: send, post, publish, push or share anything; delete files or data; buy anything; change settings or security.
- Claude usage cap for the night: US$${cfg.cap} (so far ${fmtUsd(spent)}). The shift stops by itself at the cap.
- If the desktop app's keep-awake tool is available (mcp__ccd_host__request_keep_awake), use it once so the computer does not sleep.`

const goodnightText = (n: Night): string =>
  `Goodnight: I'm going to sleep. The night shift is on from ${fmtClock(n.startedAt)}. Carry on with the work in this session as my co-pilot until it's finished, following the night rules in your system prompt. ` +
  `Start the night log at ${n.log} with a short hand-over note: the open tasks, the next steps you'll take, and anything you'll hold for me. Then get going.`

const CONTINUE_TEXT =
  'Night shift: carry on with the next step of the work. If everything is finished, end with NIGHT-SHIFT: DONE; if you cannot go on without me, end with NIGHT-SHIFT: BLOCKED: <why>.'

const morningText = (n: Night, at: number, spent: number | null, folder: string): string =>
  `Goodmorning: I'm back, and the night shift is over (${fmtClock(n.startedAt)} to ${fmtClock(at)}, ${n.turns} turns, ${n.steps} steps, ${n.decisions} decisions and ${n.held} held items in the log, ${fmtUsd(spent)} of Claude usage${n.stopped ? `, stopped: ${n.stopped}` : ''}). ` +
  `Write my morning report and save it as ${folder}/MORNING REPORT - night shift ${dateTag(at)}.md, then send it to me as a file card. ` +
  `In order: 1) what you finished, 2) every decision you took and why (from the night log ${n.log}), 3) where you stopped and what's left, 4) what needs me, held direction choices and spend approvals first, 5) spend. Keep it short, and put the decisions I need to make as buttons at the end.`

// --- engine helpers (top level: $ is only handed to functions declared here) --

// A press or a command holds the session's turn: its prompt goes out a moment later, once that is over.
const sendLater = ($: EngineInterface, text: string): void => {
  $.clock.after(SEND_DELAY_MS, () => void $.prompt.submit({ text }).catch(() => undefined))
}

const sessionId = async ($: EngineInterface): Promise<string> => {
  try {
    return await $.session.id()
  } catch {
    return 'session'
  }
}

const costNow = async ($: EngineInterface): Promise<number | null> => {
  try {
    const usd = (await $.session.usage()).cost?.usd
    return typeof usd === 'number' ? usd : null
  } catch {
    return null
  }
}

const folderOf = async ($: EngineInterface, cfg: Cfg): Promise<string> => {
  if (cfg.logFolder.trim()) return cfg.logFolder.trim().replace(/[\\/]+$/, '')
  try {
    return `${await $.session.root()}/.night-shift`
  } catch {
    return '.night-shift'
  }
}

export const countLog = (text: string): { decisions: number; held: number } => ({
  decisions: (text.match(/^\s*-\s*DECISION\b/gim) ?? []).length,
  held: (text.match(/^\s*-\s*HELD\b/gim) ?? []).length,
})

const readNight = async ($: EngineInterface): Promise<Night | null> => ((await $.state.get(NIGHT))?.value ?? null) as Night | null

const saveNight = async ($: EngineInterface, night: Night | null): Promise<void> => {
  await $.state.set(NIGHT, night)
  const key = STORE_PREFIX + (await sessionId($))
  try {
    if (night) await $.store.set(key, night)
    else await $.store.delete(key)
  } catch {
    // The store is for restarts only; the night goes on in this session.
  }
}

// The night's spend and log counts, refreshed once a minute and after each turn.
const refresh = async ($: EngineInterface): Promise<Night | null> => {
  const night = await readNight($)
  if (!night) return null
  const cost = await costNow($)
  const spent = cost !== null && night.costAtStart !== null ? Math.max(0, cost - night.costAtStart) : null
  await $.state.set(SPENT, spent)
  let counts = { decisions: night.decisions, held: night.held }
  try {
    counts = countLog(await $.fs.read(night.log))
  } catch {
    // No log yet: Claude writes it with its first decision.
  }
  const next = { ...night, ...counts }
  await $.state.set(STATS, { steps: night.steps, decisions: counts.decisions, held: counts.held })
  if (counts.decisions !== night.decisions || counts.held !== night.held) await saveNight($, next)
  await $.state.set(TICK, await $.clock.now())
  return next
}

// Once the arrival has played, one redraw puts the still drawing in its place.
const settleLater = ($: EngineInterface): void => {
  $.clock.after(MOTION_MS + 200, () => void $.clock.now().then(at => $.state.set(TICK, at)).catch(() => undefined))
}

export const goodnight = async ($: EngineInterface, cfg: Cfg): Promise<string> => {
  if (await readNight($)) return 'The night shift is already on. Press Goodmorning (or /goodmorning) to end it.'
  const at = await $.clock.now()
  const folder = await folderOf($, cfg)
  const direction = ((await $.state.get(DIRECTION))?.value ?? 'hold') as Direction
  const night: Night = {
    startedAt: at,
    costAtStart: await costNow($),
    turns: 0,
    steps: 0,
    decisions: 0,
    held: 0,
    log: `${folder}/NIGHT LOG - ${dateTag(at)} ${pad(new Date(at).getHours())}${pad(new Date(at).getMinutes())}.md`,
    direction,
    stopped: null,
  }
  try {
    await $.fs.write(night.log, `# Night log - ${dateTag(at)}, from ${fmtClock(at)}\n\nDirection at night: ${direction === 'decide' ? 'Claude decides' : 'held for the user'}. Claude usage cap: US$${cfg.cap}.\n\n## Hand-over note\n\n## Decisions and held items\n`)
  } catch {
    // Claude creates the log itself with its hand-over note.
  }
  await saveNight($, night)
  await $.state.set(SWITCHED, at)
  settleLater($)
  await $.state.set(SPENT, 0)
  sendLater($, goodnightText(night))
  return `Goodnight. The night shift is on; the log is ${night.log}.`
}

export const goodmorning = async ($: EngineInterface, cfg: Cfg): Promise<string> => {
  const night = await refresh($)
  if (!night) return 'No night shift is running. Press Goodnight (or /goodnight) to start one.'
  const at = await $.clock.now()
  const spent = ((await $.state.get(SPENT))?.value ?? null) as number | null
  await saveNight($, null)
  await $.state.set(SWITCHED, at)
  settleLater($)
  sendLater($, morningText(night, at, spent, await folderOf($, cfg)))
  return 'Goodmorning. The night shift is over; your report is on its way.'
}

/**
 * A press of Goodnight or Goodmorning. The switch waits GRACE_MS before acting,
 * counting down on the strip; any press of either button in that time cancels
 * it. A press for the mode already on does nothing.
 */
export const press = async ($: EngineInterface, cfg: Cfg, to: Pending['to']): Promise<void> => {
  const pending = ((await $.state.get(PENDING))?.value ?? null) as Pending | null
  if (pending) {
    await $.state.set(PENDING, null)
    return
  }
  const isNight = (await readNight($)) !== null
  if ((to === 'night') === isNight) return
  const at = await $.clock.now()
  await $.state.set(PENDING, { to, at })
  // The countdown redraws once a second; the last step acts if nothing cancelled it.
  $.clock.after(GRACE_MS, () => void commit($, cfg, at).catch(() => undefined))
}

const commit = async ($: EngineInterface, cfg: Cfg, at: number): Promise<void> => {
  const pending = ((await $.state.get(PENDING))?.value ?? null) as Pending | null
  if (!pending || pending.at !== at) return
  try {
    if (pending.to === 'night') await goodnight($, cfg)
    else await goodmorning($, cfg)
  } finally {
    await $.state.set(PENDING, null)
  }
}

// The usage meters, as skins read them: context to the auto-compact point, each plan window's percent.
const refreshUsage = async ($: EngineInterface): Promise<void> => {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const c = usage.context
    const compactsAt = c.breakdown?.rawMaxTokens
    const context = c.tokens !== undefined && compactsAt !== undefined && compactsAt > 0 && compactsAt < c.window
      ? Math.min(100, Math.round((c.tokens / compactsAt) * 100))
      : c.percent ?? null
    const meters = [
      ...(context === null ? [] : [{ label: 'context', percent: context }]),
      ...usage.rateLimits.map(l => ({ label: limitLabel(l.kind), percent: Math.round(l.percentUsed) })),
    ]
    if (typeof c.tokens === 'number') await $.state.set(CONTEXT_TOKENS, c.tokens)
    const before = JSON.stringify((await $.state.get(USAGE))?.value ?? null)
    if (before !== JSON.stringify(meters)) await $.state.set(USAGE, meters)
  } catch {
    // No usage to show; the row stays as it was.
  }
}

// Runs Claude Code's own /compact in a dispatch of its own, as skins' button did; the button dims until it ends.
const compactNow = async ($: EngineInterface): Promise<void> => {
  await $.state.set(COMPACTING, true)
  $.clock.after(1, () =>
    void $.command
      .run({ command: 'compact' })
      .catch(() => undefined)
      .finally(() => void $.state.set(COMPACTING, false).catch(() => undefined)),
  )
}

// The person's light or dark theme, read once a load.
let lightTheme: boolean | null = null
const isLightTheme = async ($: EngineInterface): Promise<boolean> => {
  if (lightTheme === null) {
    try {
      const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
      lightTheme = typeof theme === 'string' && theme.startsWith('light')
    } catch {
      lightTheme = false
    }
  }
  return lightTheme
}

const setDirection = async ($: EngineInterface, direction: Direction): Promise<void> => {
  await $.state.set(DIRECTION, direction)
  try {
    await $.store.set(DIRECTION_KEY, direction)
  } catch {
    // Kept for this session only.
  }
  const night = await readNight($)
  if (night && night.direction !== direction) await saveNight($, { ...night, direction })
}

const restore = async ($: EngineInterface): Promise<void> => {
  try {
    const saved = (await $.store.get(DIRECTION_KEY)) as Direction | undefined
    if (saved === 'decide' || saved === 'hold') await $.state.set(DIRECTION, saved)
    const night = (await $.store.get(STORE_PREFIX + (await sessionId($)))) as Night | undefined
    if (night && (await $.clock.now()) - night.startedAt < KEEP_MS) await $.state.set(NIGHT, night)
  } catch {
    // Nothing to bring back.
  }
}

// After a finished turn: keep the night going, or say why it stopped.
const afterTurn = async ($: EngineInterface, cfg: Cfg, answer: string, isAborted: boolean): Promise<void> => {
  const night = await refresh($)
  if (!night || night.stopped) return
  const spent = ((await $.state.get(SPENT))?.value ?? null) as number | null
  const blocked = BLOCKED_RE.exec(answer)
  const stop =
    isAborted ? 'you stopped a turn'
    : DONE_RE.test(answer) ? 'done'
    : blocked ? `blocked${blocked[1] ? `: ${blocked[1].trim().slice(0, 120)}` : ''}`
    : spent !== null && spent >= cfg.cap ? `the US$${cfg.cap} cap`
    : night.turns >= cfg.maxTurns ? `the ${cfg.maxTurns}-turn limit`
    : null
  if (stop) {
    await saveNight($, { ...night, stopped: stop })
    return
  }
  // Agents still running wake the session themselves when they finish.
  try {
    if ((await $.agent.list()).some(a => a.status === 'running')) return
  } catch {
    // No agent list: continue anyway.
  }
  await saveNight($, { ...night, turns: night.turns + 1 })
  $.clock.after(CONTINUE_DELAY_MS, () => void keepGoing($).catch(() => undefined))
}

const keepGoing = async ($: EngineInterface): Promise<void> => {
  const night = await readNight($)
  if (!night || night.stopped) return
  await $.prompt.submit({ text: CONTINUE_TEXT })
}

// --- keep warm (0.6.0) ---------------------------------------------------------
// The prompt cache lasts an hour after the last request. The cache-tax mod keeps
// it warm with one small ping per 50 idle minutes (/keepwarm); this decides when
// that is worth it and drives /keepwarm for you, from the usage bar's button.
// A ping reads the cache at a tenth of the input price, and a cold restart
// writes it at twice: one restart pays for about 20 pings. So Auto warms only:
// - a big session (50k+ tokens: a small one restarts for cents), for six hours
//   after your last turn (seven pings at most);
// - after a night shift that stopped early, until your wake-up time when that is
//   within eight hours (ten pings), and not at all when it is further off;
// - never while a night shift runs: its own turns keep the cache warm.
// /keepwarm is run only when this changes, since each run shows in the chat.

export type WarmMode = 'auto' | 'off'
export type Warm = { until: number; why: string }
const WARM = { plugin: 'night-shift', key: 'warm' } as const
const WARM_MODE = { plugin: 'night-shift', key: 'warmMode' } as const
const LAST_REQUEST = { plugin: 'night-shift', key: 'lastRequest' } as const
const CONTEXT_TOKENS = { plugin: 'night-shift', key: 'contextTokens' } as const
const CAN_WARM = { plugin: 'night-shift', key: 'canWarm' } as const
const WARM_MODE_KEY = 'warmMode'
const CACHE_TTL_MS = 60 * 60 * 1000
const BIG_TOKENS = 50_000
const DAY_WINDOW_MS = 6 * 60 * 60 * 1000
const REARM_BELOW_MS = 3 * 60 * 60 * 1000
const NIGHT_MAX_MS = 8 * 60 * 60 * 1000

/** Milliseconds from `now` to the next `HH:MM` on the local clock. */
export const msUntil = (now: number, hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  const d = new Date(now)
  d.setHours(m ? Math.min(23, Number(m[1])) : 8, m ? Math.min(59, Number(m[2])) : 0, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime() - now
}

/** A window as /keepwarm reads it: 6h, 2h30m, 45m. */
export const fmtWindow = (ms: number): string => {
  const total = Math.max(1, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h ? `${h}h${m ? `${m}m` : ''}` : `${m}m`
}

/**
 * What Auto wants now: a window to arm, 'off', or 'leave' (nothing to change).
 * `current` is the window this mod armed last, if any.
 */
export const warmPlan = (o: { mode: WarmMode; ctx: number; night: Night | null; now: number; wakeAt: string; current: Warm | null }): { arm: number; why: string } | 'off' | 'leave' => {
  const live = o.current && o.current.until > o.now ? o.current : null
  if (o.mode === 'off') return live ? 'off' : 'leave'
  if (o.night && !o.night.stopped) return 'leave'
  if (o.night && o.night.stopped) {
    const ms = msUntil(o.now, o.wakeAt)
    if (ms > NIGHT_MAX_MS) return live ? 'off' : 'leave'
    return live && live.why === 'night' ? 'leave' : { arm: ms, why: 'night' }
  }
  if (o.ctx < BIG_TOKENS) return 'leave'
  return live && live.until - o.now > REARM_BELOW_MS ? 'leave' : { arm: DAY_WINDOW_MS, why: 'day' }
}

const warmModeOf = async ($: EngineInterface): Promise<WarmMode> =>
  ((await $.state.get(WARM_MODE))?.value ?? 'auto') === 'off' ? 'off' : 'auto'

/**
 * Whether cache-tax's /keepwarm is there (the Warm button drives it, so it shows
 * only then), and the Warm mode you chose last. Checked once, after the first
 * turn, not at start: the command list waits on every plugin's start.
 */
const checkWarm = async ($: EngineInterface): Promise<boolean> => {
  const known = (await $.state.get(CAN_WARM))?.value
  if (typeof known === 'boolean') return known
  let can = false
  try {
    await $.state.set(WARM_MODE, (await $.store.get(WARM_MODE_KEY)) === 'off' ? 'off' : 'auto')
    can = (await $.command.list()).some(c => c.name === 'keepwarm')
  } catch {
    // No list: no button.
  }
  await $.state.set(CAN_WARM, can)
  return can
}

/** When this mod last ran /keepwarm itself, so its own runs are not read as yours. */
let ownKeepwarmAt = 0

/** A /keepwarm window as cache-tax reads it (6h, 90m, 2h30m), or null. */
export const parseWindow = (text: string): number | null => {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000
}

/** A /keepwarm you typed: the bar shows its window too (off clears it; status changes nothing). */
const noteKeepwarm = async ($: EngineInterface, args: string): Promise<void> => {
  const now = await $.clock.now()
  if (now - ownKeepwarmAt < 10_000) return
  const word = args.trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (word === 'off') return void (await $.state.set(WARM, null))
  const ms = word === '' || word === 'always' ? DAY_WINDOW_MS : parseWindow(word)
  if (ms) await $.state.set(WARM, { until: now + ms, why: 'manual' })
}

/** Runs Auto's decision: arms or stops cache-tax's /keepwarm only when the plan changes. */
export const applyWarm = async ($: EngineInterface, cfg: Cfg): Promise<void> => {
  if (!(await checkWarm($))) return
  const now = await $.clock.now()
  const plan = warmPlan({
    mode: await warmModeOf($),
    ctx: Number((await $.state.get(CONTEXT_TOKENS))?.value ?? 0),
    night: await readNight($),
    now,
    wakeAt: cfg.wakeAt,
    current: ((await $.state.get(WARM))?.value ?? null) as Warm | null,
  })
  if (plan === 'leave') return
  await $.state.set(WARM, plan === 'off' ? null : { until: now + plan.arm, why: plan.why })
  const args = plan === 'off' ? 'off' : fmtWindow(plan.arm)
  ownKeepwarmAt = now
  // A command waits for the session to be idle; run it in a dispatch of its own.
  $.clock.after(1, () => void $.command.run({ command: 'keepwarm', args }).catch(() => undefined))
}

/** The Warm button: Auto, or Off (which stops a window this mod armed). */
const toggleWarm = async ($: EngineInterface, cfg: Cfg): Promise<void> => {
  const next: WarmMode = (await warmModeOf($)) === 'auto' ? 'off' : 'auto'
  await $.state.set(WARM_MODE, next)
  try {
    await $.store.set(WARM_MODE_KEY, next)
  } catch {
    // Remembered for this session only.
  }
  await applyWarm($, cfg)
}

/** The cache as the bar shows it: kept warm (and for how long), warm for N more minutes, cold, or no turn yet. */
export type CacheView = { state: 'kept' | 'warm' | 'cold' | 'none'; ms: number }
export const cacheView = (now: number, lastRequest: number, warm: Warm | null): CacheView => {
  if (warm && warm.until > now) return { state: 'kept', ms: warm.until - now }
  if (!lastRequest) return { state: 'none', ms: 0 }
  const left = lastRequest + CACHE_TTL_MS - now
  return left > 0 ? { state: 'warm', ms: left } : { state: 'cold', ms: 0 }
}

/** Drops cache-tax's own grey row from the band: the usage bar shows the cache now. */
export const dropCacheTaxRow = (n: unknown, depth = 0): unknown => {
  if (depth > 8 || !n || typeof n !== 'object') return n
  const d = n as { type?: unknown; children?: unknown[] }
  if (!Array.isArray(d.children)) return n
  // Exactly cache-tax's row: a Box holding a Text whose first words are " cache-tax · " (never the column that wraps the rest of the band).
  const isRow = (x: unknown): boolean => {
    const b = x as typeof d
    return !!b && typeof b === 'object' && b.type === 'Box' && Array.isArray(b.children) &&
      b.children.some(t => !!t && typeof t === 'object' && (t as typeof d).type === 'Text' && typeof (t as typeof d).children?.[0] === 'string' && String((t as typeof d).children![0]).includes('cache-tax · '))
  }
  // The band is handed back untouched (the same objects) unless the row is really there: only the path to it is rebuilt.
  let changed = false
  const kids: unknown[] = []
  for (const c of d.children) {
    if (isRow(c)) {
      changed = true
      continue
    }
    const next = dropCacheTaxRow(c, depth + 1)
    if (next !== c) changed = true
    kids.push(next)
  }
  return changed ? { ...d, children: kids } : n
}

// --- drawing (0.5.0, "attached") ---------------------------------------------------
// Back to the design approved on 1 Nov 2026: one full-width bar with the
// Goodnight | Goodmorning switch attached inside its right end, the current side
// filled. The app sizes every bar itself (tested live on 2 Nov 2026): a rounded
// Box in the bar's end colour holds a fixed drawing (icon and words), a drawing
// with no width that stretches over the rest (the rest of the gradient), the
// right-hand words, then the app's own buttons. Nothing is estimated, so each bar
// meets the band's right edge. A press slides the next sky across the bar towards
// the switch over the 4 s grace; the switch side flips as it lands.

/** The app's buttons in CSS px, measured on the live app (which draws at 120 %); only content widths use them. */
export const BTN: Record<string, number> = { Goodnight: 90, Goodmorning: 112, 'Hold for me': 98, 'Claude decides': 120, Cancel: 64, Compact: 78, 'Warm: Auto': 100 }
/** The drawings' height: the app's buttons (about 29 px) sit inside with a little of the bar around them. */
export const ROW_H = 34

const FONT = "'Segoe UI', system-ui, sans-serif"
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const tw = (t: string, size = 14, weight = 400): number => t.length * size * (weight >= 600 ? 0.56 : 0.47)
const fitText = (t: string, max: number, size: number, weight = 400): string => {
  if (tw(t, size, weight) <= max) return t
  let s = t
  while (s.length > 1 && tw(s + '…', size, weight) > max) s = s.slice(0, -1)
  return s.trimEnd() + '…'
}
const T = (x: number, y: number, s: string, o: { size?: number; w?: number; fill?: string; anchor?: string } = {}): string =>
  `<text x="${x.toFixed(1)}" y="${y}" font-family="${FONT}" font-size="${o.size ?? 14}" font-weight="${o.w ?? 400}" fill="${o.fill ?? '#fff'}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''} style="font-variant-numeric:tabular-nums">${esc(s)}</text>`
const svgDoc = (w: number, h: number, body: string, stretch = false): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${stretch ? ' preserveAspectRatio="none"' : ''}>${body}</svg>`

export const SUN = ['#FFD166', '#FFB238', '#F7853B', '#EC6B3C']
export const SEA = ['#03045E', '#023E8A', '#0369A1']
/** The day bar's end, the approved burnt orange: the app's button labels read on it (the critic's B1). */
export const DAY_END = '#BB3E03'
/** Each sky in three parts: the fixed words' stops, the stretched stops, and the bar's own colour behind the switch. */
const SKY = {
  day: { left: [SUN[0], SUN[1]], mid: [SUN[1], SUN[2], '#DB5A26', DAY_END], end: DAY_END },
  night: { left: [SEA[0], SEA[1]], mid: [SEA[1], SEA[2]], end: SEA[2] },
}
const INK = '#2B1400'
const INK2 = '#3D1C03' // the critic's fix: #5A2E06 failed 4.5:1 on the strip's right end
const grad = (gid: string, stops: string[]): string =>
  `<linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0">${stops.map((c, i) => `<stop offset="${(i / (stops.length - 1)).toFixed(2)}" stop-color="${c}"/>`).join('')}</linearGradient>`
const sunIcon = (x: number, y: number, c: string): string => {
  let r = ''
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4
    r += `<line x1="${(x + Math.cos(a) * 5.6).toFixed(1)}" y1="${(y + Math.sin(a) * 5.6).toFixed(1)}" x2="${(x + Math.cos(a) * 7.8).toFixed(1)}" y2="${(y + Math.sin(a) * 7.8).toFixed(1)}" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`
  }
  return `<circle cx="${x}" cy="${y}" r="3.6" fill="${c}"/>` + r
}
const moonIcon = (x: number, y: number, mid: string): string =>
  `<mask id="${mid}"><rect x="${x - 9}" y="${y - 9}" width="18" height="18" fill="#fff"/><circle cx="${x + 3.4}" cy="${y - 2.6}" r="5.4" fill="#000"/></mask><circle cx="${x}" cy="${y}" r="6.4" fill="#fff" mask="url(#${mid})"/>`

export type StripMode = 'day' | 'night' | 'toNight' | 'toDay'
export type StripData = {
  direction: string
  stats: string
  spend: string
  /** The spend meter's fill, or null to leave the meter out. */
  spendFrac: number | null
}
/** What fits beside the switch (stripTree works it out from the band's width, richest first). */
export type StripFit = {
  /** The small words after the head ("you're in charge", the night's counts), cut to `subMax` px. */
  sub: boolean
  subMax: number
  /** "Day shift" / "Night shift"; without it the icon alone. */
  head: boolean
  /** The words before the switch ("tonight ·", or the stars and the spend at night). */
  right: boolean
  stars: boolean
  /** The stretched sky's width as the band will draw it, so the slide crosses every part at one speed. */
  midW: number
}
const FULL: StripFit = { sub: true, subMax: Infinity, head: true, right: true, stars: true, midW: 300 }
/** The three drawings of one bar. The middle one has no width: the app stretches it over the room left. */
export type StripParts = { left: { svg: string; w: number; alt: string }; mid: { svg: string }; right: { svg: string; w: number } }

/** The grace slide, 4 s in all: its time in each part is in proportion to the part's width, so the edge moves at one speed. */
const slideTimes = (lw: number, mw: number, rw: number): { left: [number, number]; mid: [number, number]; right: [number, number] } => {
  const total = Math.max(1, lw + mw + rw)
  const tl = (4 * lw) / total
  const tm = (4 * mw) / total
  const r2 = (n: number) => Math.round(n * 100) / 100
  return { left: [0, r2(tl)], mid: [r2(tl), r2(tm)], right: [r2(tl + tm), r2(Math.max(0.05, 4 - tl - tm))] }
}
// One ease-in where the slide starts, a steady middle, one ease-out where it lands on the switch.
const EASE = { left: 'calcMode="spline" keyTimes="0;1" keySplines=".5 0 1 1"', mid: 'calcMode="linear"', right: 'calcMode="spline" keyTimes="0;1" keySplines="0 0 .3 1"' }
const slide = (attr: string, from: number, to: number, [begin, dur]: [number, number], ease: string): string =>
  `<animate attributeName="${attr}" from="${from}" to="${to}" begin="${begin}s" dur="${dur}s" fill="freeze" ${ease}/>`
/** The slide's gold edge, gone once it has crossed its part (no hairline is left at the seam). */
const edge = (w: number, h: number, t: [number, number], ease: string, extra = ''): string =>
  `<line x1="0" y1="2" x2="0" y2="${h - 2}" stroke="#FFD166" stroke-width="1.5" stroke-opacity=".85"${extra}>${slide('x1', 0, w, t, ease)}${slide('x2', 0, w, t, ease)}<set attributeName="stroke-opacity" to="0" begin="${(t[0] + t[1]).toFixed(2)}s"/></line>`

/**
 * The night-shift bar's drawings. `arriving` plays the arrival once (the sun or
 * moon rises, the words fade in) for a few seconds after the switch; the grace
 * modes slide the next sky across all three parts towards the switch. Every
 * word is drawn at full strength first, so a drawing whose motion never runs
 * still reads.
 */
export const stripParts = (mode: StripMode, d: StripData, arriving = false, fit: StripFit = FULL): StripParts => {
  const H = ROW_H
  const cy = 17
  const by = 22
  const isGrace = mode === 'toNight' || mode === 'toDay'
  const from = mode === 'day' || mode === 'toNight' ? 'day' : 'night'
  const to = mode === 'toNight' || mode === 'night' ? 'night' : 'day'
  const words = (sky: 'day' | 'night', id: string): { body: string; w: number } => {
    const main = sky === 'day' ? INK : '#fff'
    const soft = sky === 'day' ? INK2 : '#CFE3F5'
    const head = !fit.head ? '' : isGrace ? (mode === 'toNight' ? 'Goodnight coming' : 'Goodmorning coming') : sky === 'day' ? 'Day shift' : 'Night shift'
    const full = isGrace ? (mode === 'toNight' ? 'Cancel keeps the day' : 'Cancel keeps the night') : sky === 'day' ? "you're in charge" : d.stats
    const sub = fit.sub && head ? fitText(full, fit.subMax, 14) : ''
    const x2 = 32 + tw(head, 14, 700) + 10
    const icon = sky === 'day' ? sunIcon(17, cy, INK) : moonIcon(17, cy, `ns-moon-${id}`)
    const text = (head ? T(32, by, head, { w: 700, fill: main }) : '') + (sub ? T(x2, by, sub, { fill: soft }) : '')
    const body = arriving && !isGrace
      ? `<g><animateTransform attributeName="transform" type="translate" from="0 14" to="0 0" dur="1.4s" fill="freeze" ${EASE.right}/>${icon}</g>` +
        `<g><animate attributeName="opacity" from="0" to="1" dur="1s" fill="freeze"/>${text}</g>`
      : icon + text
    return { body, w: Math.ceil(head ? (sub ? x2 + tw(sub, 14) : 32 + tw(head, 14, 700)) + 18 : 36) }
  }
  // Right: the words before the direction button, the same in the grace seconds as in the mode being left.
  let R = ''
  let RW = 8
  if (fit.right && from === 'day') {
    RW = Math.ceil(tw('tonight ·', 13) + 10)
    R = T(RW - 10, by, 'tonight ·', { size: 13, fill: '#FFE8D6', anchor: 'end' })
  } else if (fit.right) {
    const mw = 56
    const sw = tw(d.spend, 13)
    const stars = fit.stars ? 52 : 4
    RW = Math.ceil(stars + sw + 10 + (d.spendFrac === null ? 0 : mw + 10) + 6)
    // A few still stars on the open water before the spend.
    const pts: Array<[number, number, number]> = [[6, 9, 1.2], [17, 24, 0.9], [27, 12, 0.9], [37, 26, 1.2], [45, 8, 0.9]]
    if (fit.stars) R = pts.map(([x, y, r], i) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" fill-opacity="${i % 2 ? 0.45 : 0.7}"/>`).join('')
    R += T(stars + sw, by, d.spend, { size: 13, anchor: 'end' })
    if (d.spendFrac !== null) {
      const mx = stars + sw + 10
      R += `<rect x="${mx}" y="15" width="${mw}" height="4" rx="2" fill="#fff" fill-opacity=".22"/><rect x="${mx}" y="15" width="${(mw * Math.min(1, d.spendFrac)).toFixed(1)}" height="4" rx="2" fill="#90E0EF"/>`
    }
  }
  // Left: the icon and words on the first stops of the sky.
  const a = words(from, 'a')
  const b = isGrace ? words(to, 'b') : a
  const LW = Math.max(a.w, b.w)
  const t = slideTimes(LW, fit.midW, RW)
  let L = `<defs>${grad('ns-l-from', SKY[from].left)}`
  if (isGrace) L += `${grad('ns-l-to', SKY[to].left)}<clipPath id="ns-l-clip"><rect width="0" height="${H}">${slide('width', 0, LW, t.left, EASE.left)}</rect></clipPath>`
  L += `</defs>${leftEdge(LW, H, 'url(#ns-l-from)')}`
  L += isGrace ? `${a.body}<g clip-path="url(#ns-l-clip)">${leftEdge(LW, H, 'url(#ns-l-to)')}${b.body}</g>${edge(LW, H, t.left, EASE.left)}` : a.body
  const alt = isGrace
    ? mode === 'toNight' ? 'Goodnight coming · Cancel keeps the day' : 'Goodmorning coming · Cancel keeps the night'
    : from === 'day' ? "Day shift, you're in charge" : `Night shift: ${d.stats}`
  // Middle: the rest of the sky, stretched by the app to fill the bar (4000 wide, so no band outgrows it).
  const MW = 4000
  let M = `<defs>${grad('ns-m-from', SKY[from].mid)}`
  if (isGrace) M += `${grad('ns-m-to', SKY[to].mid)}<clipPath id="ns-m-clip"><rect width="0" height="${H}">${slide('width', 0, MW, t.mid, EASE.mid)}</rect></clipPath>`
  M += `</defs><rect width="${MW}" height="${H}" fill="url(#ns-m-from)"/>`
  if (isGrace) M += `<rect width="${MW}" height="${H}" fill="url(#ns-m-to)" clip-path="url(#ns-m-clip)"/>${edge(MW, H, t.mid, EASE.mid, ' vector-effect="non-scaling-stroke"')}`
  // In the grace seconds the right-hand end takes the last of the slide under its words.
  if (isGrace) {
    R = `<defs><clipPath id="ns-r-clip"><rect width="0" height="${H}">${slide('width', 0, RW, t.right, EASE.right)}</rect></clipPath></defs>` +
      `<rect width="${RW}" height="${H}" fill="${SKY[from].end}"/><rect width="${RW}" height="${H}" fill="${SKY[to].end}" clip-path="url(#ns-r-clip)"/>` + R
  }
  return {
    left: { svg: svgDoc(LW, H, L), w: LW, alt },
    mid: { svg: svgDoc(MW, H, M, true) },
    right: { svg: svgDoc(RW, H, R), w: RW },
  }
}

type Els = {
  Box: (p: Record<string, unknown>) => unknown
  Text: (p: Record<string, unknown>) => unknown
  Button: (p: Record<string, unknown>) => unknown
  Svg?: (p: { source: string; alt: string; width?: number; height?: number; isInteractive?: boolean }) => unknown
}
export type StripView = {
  night: Night | null
  /** The night's counts as last refreshed (once a minute), so the strip is not redrawn on every step. */
  stats: { steps: number; decisions: number; held: number } | null
  direction: Direction
  now: number
  spent: number | null
  cap: number
  /** A press waiting out its grace period, or null. */
  pending: Pending | null
  /** True for a few seconds after the switch, while the arrival plays. */
  arriving: boolean
  isLight: boolean
  /** The band's width in columns (8 px each), so the words fit beside the switch. */
  cols: number
  onAction: () => void
  onDirection: (d: Direction) => void
}

const fmtHm = (ms: number): string => {
  const m = Math.max(0, Math.floor(ms / 60000))
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

/** Exact space inside a row: a small empty drawing. */
const air = (Svg: NonNullable<Els['Svg']>, w: number, h = 2): unknown =>
  Svg({ source: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"></svg>`, alt: 'space', width: w, height: h })
const R = 8
/** Room every fixed-width drawing leaves for the stretched fill: the band can be narrower than bodyColumns × 8 says. */
const SAFE = 32
/** A fill with rounded left corners (the bar's start), and the rounded right end cap. */
export const leftEdge = (w: number, h: number, fill: string): string =>
  `<path d="M${R},0 H${w} V${h} H${R} A${R},${R} 0 0 1 0,${h - R} V${R} A${R},${R} 0 0 1 ${R},0 Z" fill="${fill}"/>`
const capSvg = (h: number, fill: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${R}" height="${h}" viewBox="0 0 ${R} ${h}"><path d="M0,0 A${R},${R} 0 0 1 ${R},${R} V${h - R} A${R},${R} 0 0 1 0,${h} Z" fill="${fill}"/></svg>`

/**
 * One full-line bar, measured live on 2 Nov 2026: the app's coloured Box draws a
 * thick frame when given a border, and none without one, so the bar is built
 * from parts the app lays out edge to edge. Its drawn start (rounded left
 * corners), a drawing with no width that the app stretches over the room left
 * (its Box carries `under`, so the bar stays whole if a frame does not stretch),
 * a Box in the end colour holding the right-hand drawing and the app's buttons
 * (gap 0: the app's own gap between buttons would add up), then a drawn rounded end.
 */
export const fullBar = (
  el: { Box: Els['Box']; Svg: NonNullable<Els['Svg']> },
  o: { key: string; h: number; start: unknown; stretch: string; under: string; end: string; tail?: unknown[]; live?: boolean },
): unknown => {
  const { Box, Svg } = el
  return Box({
    key: o.key,
    flexDirection: 'row',
    alignItems: 'stretch',
    children: [
      o.start,
      Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, width: 0, backgroundColor: o.under, children: [Svg({ source: o.stretch, alt: 'bar', height: o.h, ...(o.live ? { isInteractive: true } : {}) })] }),
      ...(o.tail?.length ? [Box({ flexDirection: 'row', alignItems: 'center', gap: 0, backgroundColor: o.end, children: [...o.tail, air(Svg, 1, o.h)] })] : []),
      Svg({ source: capSvg(o.h, o.end), alt: 'bar end', width: R, height: o.h }),
    ],
  })
}
/** A stretchable fill: one colour, or a horizontal gradient. */
export const stretchSvg = (h: number, fill: string | string[], extra = '', id = 'ns-fill'): string =>
  svgDoc(4000, h, Array.isArray(fill) ? `<defs>${grad(id, fill)}</defs><rect width="4000" height="${h}" fill="url(#${id})"/>${extra}` : `<rect width="4000" height="${h}" fill="${fill}"/>${extra}`, true)

/**
 * The switch, attached inside the bar: Goodnight | Goodmorning with the current
 * side filled (the app's primary button). In the grace seconds the side that was
 * pressed reads Cancel and the current side stays filled until the slide lands;
 * either side cancels. The direction button sits before it, 16 px apart.
 */
const switchButtons = (Button: Els['Button'], v: StripView, mode: StripMode): unknown[] => {
  const isGrace = mode === 'toNight' || mode === 'toDay'
  const now = (label: string) => Button({ key: 'night-shift-now', label, variant: 'primary', onPress: isGrace ? v.onAction : () => undefined })
  const act = (label: string) => Button({ key: 'night-shift-action', label, variant: 'secondary', onPress: v.onAction })
  if (mode === 'day') return [act('Goodnight'), now('Goodmorning')]
  if (mode === 'toNight') return [act('Cancel'), now('Goodmorning')]
  if (mode === 'toDay') return [now('Goodnight'), act('Cancel')]
  return [now('Goodnight'), act('Goodmorning')]
}
/** The switch's width in CSS px: its two buttons as the mode shows them. */
const pairWidth = (mode: StripMode): number =>
  mode === 'toNight' ? BTN.Cancel + BTN.Goodmorning : mode === 'toDay' ? BTN.Goodnight + BTN.Cancel : BTN.Goodnight + BTN.Goodmorning

/**
 * What fits beside the switch at this band width, richest first. The night drops
 * its spend meter, then its stars, then shortens its counts; any mode then drops
 * its small words, the words before the switch, and its head words (icon alone).
 */
export const stripFit = (mode: StripMode, d: StripData, cols: number, dirLabel: string): { fit: StripFit; d: StripData } => {
  const cw = Math.max(320, cols * 8)
  const fixed = (BTN[dirLabel] ?? 100) + 16 + pairWidth(mode) + 3 + 1 + R
  const room = cw - fixed - 16 - SAFE
  const none = { ...d, spendFrac: null }
  const tries: Array<{ fit: StripFit; d: StripData }> = [
    { fit: FULL, d },
    { fit: FULL, d: none },
    { fit: { ...FULL, stars: false }, d: none },
    { fit: { ...FULL, sub: false, stars: false }, d: none },
    { fit: { ...FULL, sub: false, right: false, stars: false }, d: none },
    { fit: { ...FULL, sub: false, right: false, head: false, stars: false }, d: none },
  ]
  for (const t of tries) {
    const p = stripParts(mode, t.d, false, t.fit)
    const over = p.left.w + p.right.w - room
    if (over <= 0) return { fit: { ...t.fit, midW: Math.max(40, room + 16 + SAFE - p.left.w - p.right.w) }, d: t.d }
    // The night's counts may shorten, down to about 120 px, before the next step down.
    if (t.fit.sub && t.fit === tries[2].fit && mode === 'night') {
      const subMax = tw(d.stats, 14) - over
      if (subMax >= 120) {
        const q = stripParts(mode, t.d, false, { ...t.fit, subMax })
        return { fit: { ...t.fit, subMax, midW: Math.max(40, room + 16 + SAFE - q.left.w - q.right.w) }, d: t.d }
      }
    }
  }
  return { fit: { ...tries[tries.length - 1].fit, midW: 40 }, d: none }
}

/** The night-shift bar: one full-width bar, its words drawn, the switch attached at its right end. */
export const stripTree = (el: Els, v: StripView): unknown => {
  const { Box, Text, Button, Svg } = el
  const isNight = v.night !== null
  const s = v.stats ?? (v.night ? { steps: v.night.steps, decisions: v.night.decisions, held: v.night.held } : null)
  const dirLabel = v.direction === 'decide' ? 'Claude decides' : 'Hold for me'
  const mode: StripMode = v.pending ? (v.pending.to === 'night' ? 'toNight' : 'toDay') : isNight ? 'night' : 'day'
  const stats = isNight && s
    ? [fmtHm(v.now - v.night!.startedAt), `${s.steps} steps`, `${s.decisions} decisions`, ...(s.held ? [`${s.held} held`] : [])].join(' · ') + (v.night!.stopped ? ` · ${v.night!.stopped}` : '')
    : ''
  const spend = `${fmtUsd(v.spent)} of ${v.cap}`
  const direction = Button({ key: 'night-shift-direction', label: dirLabel, variant: 'secondary', onPress: () => v.onDirection(v.direction === 'decide' ? 'hold' : 'decide') })
  const buttons = switchButtons(Button, v, mode)
  if (!Svg) {
    // The terminal: the same row as text on the bar's colour, the direction and the switch beside it.
    const alt = mode === 'day' ? "you're in charge · tonight:" : mode === 'night' ? `${stats} · ${spend}` : mode === 'toNight' ? 'Goodnight coming · Cancel keeps the day' : 'Goodmorning coming · Cancel keeps the night'
    return Box({
      key: 'night-shift-strip',
      flexDirection: 'row',
      gap: 1,
      children: [
        Box({
          flexDirection: 'row', gap: 1, paddingX: 1, flexGrow: 1,
          backgroundColor: isNight ? '#023E8A' : '#F7853B',
          children: [Text({ bold: true, color: isNight ? '#FFFFFF' : '#2B1400', children: [isNight ? '☾ Night shift' : '☀ Day shift'] }), Text({ color: isNight ? '#CFE3F5' : '#3D1C03', wrap: 'truncate-end', children: [alt] })],
        }),
        direction,
        ...buttons,
      ],
    })
  }
  const { fit, d } = stripFit(mode, { direction: dirLabel, stats, spend, spendFrac: v.spent === null ? null : v.spent / v.cap }, v.cols, dirLabel)
  const p = stripParts(mode, d, v.arriving, fit)
  const moving = mode === 'toNight' || mode === 'toDay'
  // The bar's own colour behind the switch is the sky being left until the switch lands.
  const sky = mode === 'day' || mode === 'toNight' ? SKY.day : SKY.night
  const live = moving ? { isInteractive: true } : {}
  return fullBar({ Box, Svg }, {
    key: 'night-shift-strip',
    h: ROW_H,
    start: Svg({ source: p.left.svg, alt: p.left.alt, width: p.left.w, height: ROW_H, ...(moving || v.arriving ? { isInteractive: true } : {}) }),
    stretch: p.mid.svg,
    live: moving,
    under: sky.end,
    end: sky.end,
    tail: [
      Svg({ source: p.right.svg, alt: mode === 'night' ? spend : 'tonight', width: p.right.w, height: ROW_H, ...live }),
      direction,
      air(Svg, 16),
      ...buttons,
      air(Svg, 3),
    ],
  })
}

// --- usage row (0.4.0; 0.5.0 a full-line panel) -------------------------------------
// The context and plan-window meters in the same look as the bars below. It can
// take the place of the skins mod's own usage row (switch that off with /skin band off). Numbers as skins reads them: context to the
// auto-compact point, each rate-limit window's percent used. The Compact button runs
// Claude Code's own /compact, as skins' did, attached inside the panel's right end.

export type Meter = { label: string; percent: number }
const PANEL = {
  dark: { surf: '#2C2C2B', stroke: '#3A3A38', text: '#F2F1EE', sub: '#A3A3A0', track: '#3F3F3D', ok: '#38BDF8', warn: '#FB923C', bad: '#FB7185' },
  light: { surf: '#FFFFFF', stroke: '#E2DED5', text: '#1F1F1E', sub: '#6B6A66', track: '#E9E6DF', ok: '#0369A1', warn: '#C2410C', bad: '#BE123C' },
}

export const limitLabel = (kind: string): string => {
  const name = kind.toLowerCase()
  if (name.includes('five') || name.includes('5h') || name.includes('5_h')) return '5h'
  if (name.includes('seven') || name.includes('7d') || name.includes('week')) return '7d'
  return name.replace(/_/g, ' ')
}

/** The meters, w × 34 on the panel's colour (the panel itself is the app's): "65% context" and a gradient bar each. */
export const usageSvg = (w: number, meters: Meter[], isLight: boolean, cache: CacheView | null = null): string => {
  const P = PANEL[isLight ? 'light' : 'dark']
  // A gradient bar per meter: the gradient spans the whole track (blue, amber from 80 %, coral from 95 %), so a high reading ends warm.
  let b = leftEdge(w, ROW_H, P.surf) + `<defs><linearGradient id="ns-use" x1="0" x2="1"><stop offset="0" stop-color="${P.ok}"/><stop offset=".7" stop-color="${P.ok}"/><stop offset=".8" stop-color="${P.warn}"/><stop offset=".95" stop-color="${P.bad}"/><stop offset="1" stop-color="${P.bad}"/></linearGradient></defs>`
  const SEG = cache ? 200 : 0
  const slot = (w - 8 - SEG) / Math.max(1, meters.length)
  meters.forEach((m, i) => {
    const pct = Math.max(0, Math.min(100, Math.round(m.percent)))
    const x = slot * i + 16
    // Digits run wider than the average glyph the estimate uses: 8.2 px each at 13 px bold, then a space.
    const num = `${pct}%`
    b += T(x, 22, num, { size: 13, w: 700, fill: pct >= 95 ? P.bad : pct >= 80 ? P.warn : P.text })
    const lx = x + num.length * 8.2 + 7
    b += T(lx, 22, m.label, { size: 13, fill: P.sub })
    const bx = lx + tw(m.label, 13) + 14
    const bw = Math.max(40, x + slot - 30 - bx)
    b += `<rect x="${bx.toFixed(1)}" y="15" width="${bw.toFixed(1)}" height="5" rx="2.5" fill="${P.track}"/>`
    // The fill is the gradient seen through a window the width of the reading.
    if (pct > 0) b += `<svg x="${bx.toFixed(1)}" y="15" width="${Math.max(5, (bw * pct) / 100).toFixed(1)}" height="5" overflow="hidden"><rect width="${bw.toFixed(1)}" height="5" rx="2.5" fill="url(#ns-use)"/></svg>`
  })
  if (cache) {
    // The cache: kept warm by cache-tax (and how long), warm for N more minutes, or cold.
    const x = w - SEG + 6
    const col = cache.state === 'kept' ? P.ok : cache.state === 'warm' ? (isLight ? '#0F766E' : '#2DD4BF') : cache.state === 'cold' ? P.warn : P.sub
    const word = cache.state === 'kept' ? 'kept warm' : cache.state === 'warm' ? 'warm' : cache.state === 'cold' ? 'cold' : 'no turn yet'
    const left = cache.state === 'kept' ? fmtHm(cache.ms) : cache.state === 'warm' ? `${Math.max(1, Math.round(cache.ms / 60000))}m left` : ''
    b += `<circle cx="${x + 4}" cy="17" r="4" fill="${col}"/>`
    b += T(x + 14, 22, 'cache', { size: 13, fill: P.sub })
    const wx = x + 14 + tw('cache', 13) + 6
    b += T(wx, 22, word, { size: 13, w: 600, fill: col })
    if (left) b += T(wx + tw(word, 13, 600) + 6, 22, `· ${left}`, { size: 13, fill: P.sub })
  }
  return svgDoc(w, ROW_H, b)
}

/** The usage row: one full-line panel the app sizes, the meters drawn on it, [Compact] attached at its right end while Claude is idle. */
export const usageTree = (el: Els, meters: Meter[], isLight: boolean, cols: number, canCompact: boolean, onCompact: () => void, warm: { mode: WarmMode; cache: CacheView; onPress: () => void } | null = null): unknown => {
  const { Box, Text, Button, Svg } = el
  const alt = meters.map(m => `${Math.round(m.percent)}% ${m.label}`).join(', ')
  // Compact keeps its place, dim while Claude works (a press then only says so), so the meters never move.
  const compact = [Button({ key: 'night-shift-compact', label: 'Compact', variant: 'secondary', ...(canCompact ? {} : { dimColor: true }), onPress: onCompact })]
  if (!Svg) return Box({ key: 'night-shift-usage', flexDirection: 'row', gap: 1, children: [Box({ flexGrow: 1, children: [Text({ dimColor: true, children: [alt] })] }), ...compact] })
  // The meters take the room the band gives, less Compact; what the estimate leaves over is the panel's own colour.
  // bodyColumns × 8 ran up to about 25 px wider than the real band (seen live, 2 Nov), so drawings leave SAFE px to the stretched fill.
  const W = Math.max(240, Math.floor(Math.max(320, cols * 8) - BTN.Compact - 4 - (warm ? BTN['Warm: Auto'] + 6 : 0) - R - SAFE))
  const warmBtn = warm ? [Button({ key: 'night-shift-warm', label: warm.mode === 'auto' ? 'Warm: Auto' : 'Warm: Off', variant: 'secondary', onPress: warm.onPress })] : []
  const P = PANEL[isLight ? 'light' : 'dark']
  return fullBar({ Box, Svg }, {
    key: 'night-shift-usage',
    h: ROW_H,
    start: Svg({ source: usageSvg(W, meters, isLight, warm?.cache ?? null), alt: warm ? `${alt}, cache ${warm.cache.state}` : alt, width: W, height: ROW_H }),
    stretch: stretchSvg(ROW_H, P.surf),
    under: P.surf,
    end: P.surf,
    tail: [...warmBtn, ...(warm ? [air(Svg, 6)] : []), ...compact, air(Svg, 3)],
  })
}

// --- hooks -------------------------------------------------------------------

export const register: Register = (on, options) => {
  const opt = options as { nightCap?: number; maxTurns?: number; logFolder?: string; showStrip?: boolean; usageRow?: boolean; wakeAt?: string }
  const cfg: Cfg = {
    cap: typeof opt.nightCap === 'number' && opt.nightCap > 0 ? opt.nightCap : 25,
    maxTurns: typeof opt.maxTurns === 'number' && opt.maxTurns > 0 ? Math.floor(opt.maxTurns) : 80,
    logFolder: typeof opt.logFolder === 'string' ? opt.logFolder : '',
    showStrip: opt.showStrip !== false,
    usageRow: opt.usageRow !== false,
    wakeAt: typeof opt.wakeAt === 'string' && /^\d{1,2}:\d{2}$/.test(opt.wakeAt.trim()) ? opt.wakeAt.trim() : '08:00',
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'goodnight', description: 'Hand the session to Claude for the night: it decides, logs and keeps going until you say goodmorning (night-shift)' })
    await $.command.register({ name: 'goodmorning', description: 'End the night shift and get the morning report (night-shift)' })
    await $.command.register({ name: 'night-shift', description: 'Night shift status, or set direction at night: decide | hold', argumentHint: '[status | decide | hold]' })
    await restore($)
    await refreshUsage($)
    // The strip's clock and counters move once a minute during a night; nothing runs by day.
    $.clock.every(60_000, () => {
      void refresh($).catch(() => undefined)
      void refreshUsage($).catch(() => undefined)
    })
    return started
  })

  // A turn's end and a plan limit's move are when the usage numbers change.
  on('session.measure', async ($, e, next) => {
    await refreshUsage($)
    return next(e)
  })

  // /resume and /branch reset $.state and skip session.start.
  on('classic.SessionStart', { source: ['resume', 'fork'] }, async ($, e, next) => {
    const r = await next(e)
    await restore($)
    return r
  })

  // cache-tax answers /keepwarm; the bar notes the window it set.
  on('command.run', { command: 'keepwarm' }, async ($, e, next) => {
    const r = await next(e)
    await noteKeepwarm($, String(e.args ?? '')).catch(() => undefined)
    return r
  })

  on('command.run', { command: 'goodnight' }, async $ => ({ text: await goodnight($, cfg) }))
  on('command.run', { command: 'goodmorning' }, async $ => ({ text: await goodmorning($, cfg) }))
  on('command.run', { command: 'night-shift' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'decide' || arg === 'hold') {
      await setDirection($, arg)
      return { text: arg === 'decide' ? 'At night Claude may take direction decisions, and logs each one with its alternatives.' : 'At night Claude holds direction decisions for you and prepares the options.' }
    }
    const night = await refresh($)
    const direction = ((await $.state.get(DIRECTION))?.value ?? 'hold') as Direction
    if (!night) return { text: `Day shift: you're in charge. Direction at night: ${direction === 'decide' ? 'Claude decides' : 'hold for me'}. Cap US$${cfg.cap}.` }
    const spent = ((await $.state.get(SPENT))?.value ?? null) as number | null
    return { text: `Night shift since ${fmtClock(night.startedAt)}: ${night.turns} turns, ${night.steps} steps, ${night.decisions} decisions, ${night.held} held, ${fmtUsd(spent)} of US$${cfg.cap}${night.stopped ? `; stopped: ${night.stopped}` : ''}. Log: ${night.log}` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const night = await readNight($)
    if (!night || e.traits.includes('bare')) return composed
    const spent = ((await $.state.get(SPENT))?.value ?? null) as number | null
    return { ...composed, sections: [...composed.sections, { id: 'night-shift:rule', text: nightRule(night, cfg, spent), scope: 'session' as const }] }
  })

  // The person is asleep: a question gets the night's standing answer instead.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (!(await readNight($))) return next(e)
    return { deny: 'night-shift: the user is asleep. Do not wait for an answer: take your recommended option, log it in the night log as a DECISION (or HELD, for a direction choice you may not take), and carry on.' }
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) await $.state.set(LAST_REQUEST, await $.clock.now())
    const night = await readNight($)
    if (night) await $.state.set(NIGHT, { ...night, steps: night.steps + 1 })
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      await afterTurn($, cfg, e.answer ?? '', e.isAborted === true).catch(() => undefined)
      await applyWarm($, cfg).catch(() => undefined)
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = dropCacheTaxRow(await next(e))
    if (!cfg.showStrip || e.props.hasSurvey) return below
    const night = await readNight($)
    const direction = ((await $.state.get(DIRECTION))?.value ?? 'hold') as Direction
    const tick = Number((await $.state.get(TICK))?.value ?? 0)
    const spent = ((await $.state.get(SPENT))?.value ?? null) as number | null
    const pending = ((await $.state.get(PENDING))?.value ?? null) as Pending | null
    const now = Math.max(await $.clock.now(), tick)
    const ui = $.ui.resolve(e) as unknown as Els
    const stats = ((await $.state.get(STATS))?.value ?? null) as StripView['stats']
    const switchedAt = Number((await $.state.get(SWITCHED))?.value ?? 0)
    const isLight = await isLightTheme($)
    const tree = stripTree(
      { Box: ui.Box, Text: ui.Text, Button: ui.Button, ...(e.surface !== 'terminal' && ui.Svg ? { Svg: ui.Svg } : {}) },
      {
        night,
        stats,
        direction,
        now,
        spent,
        cap: cfg.cap,
        pending,
        cols: e.props.bodyColumns || 100,
        // The arrival plays once, for a few seconds after the switch lands.
        arriving: !pending && switchedAt > 0 && now - switchedAt < MOTION_MS,
        isLight,
        onAction: () => void press($, cfg, pending ? (pending.to) : night ? 'morning' : 'night').catch(() => undefined),
        onDirection: d => void setDirection($, d).catch(() => undefined),
      },
    )
    const meters = ((await $.state.get(USAGE))?.value ?? []) as Meter[]
    const isCompacting = Boolean((await $.state.get(COMPACTING))?.value)
    const idle = !e.props.isWorking && !isCompacting
    const usageRow = cfg.usageRow && meters.length
      ? usageTree({ Box: ui.Box, Text: ui.Text, Button: ui.Button, ...(e.surface !== 'terminal' && ui.Svg ? { Svg: ui.Svg } : {}) },
          meters, isLight, e.props.bodyColumns || 100, idle,
          () => void (idle ? compactNow($) : Promise.resolve($.ui.toast('Compact runs once Claude is idle'))).catch(() => undefined),
          (await $.state.get(CAN_WARM))?.value
            ? {
                mode: await warmModeOf($),
                cache: cacheView(now, Number((await $.state.get(LAST_REQUEST))?.value ?? 0), ((await $.state.get(WARM))?.value ?? null) as Warm | null),
                onPress: () => void toggleWarm($, cfg).catch(() => undefined),
              }
            : null)
      : null
    // Space between our rows lives in small empty drawings, so it is exact.
    const gap = (h: number) => (ui.Svg && e.surface !== 'terminal' ? [ui.Svg({ source: `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="${h}"></svg>`, alt: 'space', width: 8, height: h })] : [])
    const ours = usageRow ? ui.Box({ flexDirection: 'column', children: [usageRow, ...gap(8), tree] }) : tree
    return below ? ui.Box({ flexDirection: 'column', children: [ours, below] }) : ours
  })
}
