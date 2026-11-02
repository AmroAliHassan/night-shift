import { test, expect, mock } from 'claude-code/testing'
import { countLog, nightRule, stripParts, stripTree, stripFit, fmtSpan, SUN, SEA, DAY_END, warmPlan, msUntil, fmtWindow, cacheView, dropCacheTaxRow, parseWindow, usageSvg, usageTree, limitLabel } from '../hooks/register'
import type { Night } from '../types'

const AT = 1_800_000_000_000
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }
const TURN = { durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer' as const }

// The engine's bottom for the calls the mod makes: prompts are captured, turns answered.
const host = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  const prompts: string[] = []
  on('prompt.submit', (_$, e) => { prompts.push(e.text); return { text: e.text } })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base', scope: 'shared' as const }] }))
  return prompts
}
const ruleOf = async ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  (await $.prompt.compose(COMPOSE)).sections.find(s => s.id === 'night-shift:rule')?.text

test('Goodnight starts the shift: a prompt, the night rule, and questions answered for the sleeper', async ($, on) => {
  const clock = mock.clock(on, { now: AT })
  mock.store(on)
  const prompts = host(on)
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: 'asked the person' }))
  expect(await ruleOf($)).toBeUndefined()

  const { text } = await $.command.run({ command: 'goodnight' })
  expect(text).toContain('night shift is on')
  await clock.advance(500)
  expect(prompts[0]).toContain('Goodnight')
  const rule = await ruleOf($)
  expect(rule).toContain('is asleep')
  expect(rule).toContain('do not take direction decisions')
  expect(rule).toContain('US$25')
  const asked = await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  expect(String((asked as { deny?: string }).deny)).toContain('the user is asleep')

  // A second press changes nothing.
  expect((await $.command.run({ command: 'goodnight' })).text).toContain('already on')
  expect(prompts).toHaveLength(1)
})

test('the night keeps going after each turn and stops on NIGHT-SHIFT: DONE', async ($, on) => {
  const clock = mock.clock(on, { now: AT })
  mock.store(on)
  const prompts = host(on)
  await $.command.run({ command: 'goodnight' })

  await $.turn.complete({ ...TURN, answer: 'Built slides 1-10.' } as never)
  await clock.advance(4000)
  expect(prompts.at(-1)).toContain('carry on with the next step')

  await $.turn.complete({ ...TURN, answer: 'All finished. NIGHT-SHIFT: DONE' } as never)
  await clock.advance(4000)
  expect(prompts.filter(p => p.includes('carry on'))).toHaveLength(1)
  expect((await $.command.run({ command: 'night-shift', args: 'status' })).text).toContain('stopped: done')
})

test('a blocked night says why; the turn limit stops it too', { options: { maxTurns: 1 } }, async ($, on) => {
  const clock = mock.clock(on, { now: AT })
  mock.store(on)
  const prompts = host(on)
  await $.command.run({ command: 'goodnight' })
  await $.turn.complete({ ...TURN, answer: 'step one' } as never)
  await clock.advance(4000)
  await $.turn.complete({ ...TURN, answer: 'step two' } as never)
  await clock.advance(4000)
  expect(prompts.filter(p => p.includes('carry on'))).toHaveLength(1)
  expect((await $.command.run({ command: 'night-shift' })).text).toContain('1-turn limit')
})

test('a subagent finishing does not move the night on', async ($, on) => {
  const clock = mock.clock(on, { now: AT })
  mock.store(on)
  const prompts = host(on)
  await $.command.run({ command: 'goodnight' })
  await $.turn.complete({ ...TURN, answer: 'worker done', agentId: 'a1' } as never)
  await clock.advance(4000)
  expect(prompts.filter(p => p.includes('carry on'))).toHaveLength(0)
})

test('Goodmorning ends the night and asks for the morning report', async ($, on) => {
  const clock = mock.clock(on, { now: AT })
  mock.store(on)
  const prompts = host(on)
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: 'asked the person' }))
  expect((await $.command.run({ command: 'goodmorning' })).text).toContain('No night shift')
  await $.command.run({ command: 'goodnight' })
  const { text } = await $.command.run({ command: 'goodmorning' })
  expect(text).toContain('report is on its way')
  await clock.advance(500)
  expect(prompts.at(-1)).toContain('MORNING REPORT - night shift')
  expect(prompts.at(-1)).toContain('what needs me')
  expect(await ruleOf($)).toBeUndefined()
  const asked = await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  expect((asked as { deny?: string }).deny).toBeUndefined()
})

test('direction at night: Claude decides, or held for the person', async ($, on) => {
  mock.clock(on, { now: AT })
  mock.store(on)
  host(on)
  expect((await $.command.run({ command: 'night-shift', args: 'decide' })).text).toContain('may take direction decisions')
  await $.command.run({ command: 'goodnight' })
  expect(await ruleOf($)).toContain('you may take direction decisions too')
  await $.command.run({ command: 'night-shift', args: 'hold' })
  expect(await ruleOf($)).toContain('do not take direction decisions')
})


// The desktop draws the strip's words inside its drawing (the alt says them); the terminal as Text.
const shows = async (ui: { find: (q: unknown) => Promise<unknown> }, surface: 'desktop' | 'terminal', re: RegExp): Promise<boolean> => {
  if (surface === 'terminal') return Boolean(await ui.find({ type: 'Text', text: re }))
  return Boolean(await ui.find({ type: 'Svg', text: re })) || Boolean(await ui.find({ type: 'Svg', alt: re }))
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`the strip draws by day and by night on the ${surface}`, async ($, on) => {
    mock.clock(on, { now: AT })
    mock.store(on)
    host(on)
    on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return Text({ children: ['LANES'] }) })
    const ui = await $.ui.mount({ plugin: 'night-shift', component: 'AbovePrompt', requestId: 'band', surface, props: BAND } as never)
    expect(await shows(ui, surface, /Day shift/)).toBe(true)
    expect((await ui.find({ type: 'Text', text: /LANES/ }))?.text).toBe('LANES')
    await ui.unmount()
    await $.command.run({ command: 'goodnight' })
    const lit = await $.ui.mount({ plugin: 'night-shift', component: 'AbovePrompt', requestId: 'band2', surface, props: BAND } as never)
    expect(await shows(lit, surface, /Night shift/)).toBe(true)
    expect(await shows(lit, surface, /0 decisions/)).toBe(true)
    await lit.unmount()
  })
}

test('the log counts, the rule and the drawings', async () => {
  expect(countLog('# Night log\n- DECISION 1:10 am: kept layout A\n- HELD 2:00 am: route B or C\n  - DECISION 3:00 am (direction): cover 2\n- note')).toEqual({ decisions: 2, held: 1 })
  const n: Night = { startedAt: AT, costAtStart: 1, turns: 0, steps: 0, decisions: 0, held: 0, log: 'L.md', direction: 'hold', stopped: null }
  const rule = nightRule(n, { cap: 30, maxTurns: 80, logFolder: '', showStrip: true }, 4.5)
  expect(rule).toContain('US$30 (so far US$4.50)')
  expect(rule).toContain('Never at night: send, post, publish, push or share anything')
  const d = { direction: 'Hold for me', stats: '2h 41m · 38 steps · 9 decisions', spend: 'US$6.10 of 25', spendFrac: 0.244 }
  const day = stripParts('day', d)
  const night = stripParts('night', d)
  // 0.5.0 "attached": 34 px drawings, sunrise by day, deep ocean at night, the direction as words by day.
  expect(day.left.svg).toContain('height="34"')
  expect(day.left.svg).toContain(SUN[0])
  expect(day.mid.svg).toContain('preserveAspectRatio="none"')
  expect(day.mid.svg).toContain(DAY_END)
  expect(day.right.svg).toContain('tonight ·')
  expect(night.left.svg).toContain(SEA[0])
  expect(night.left.svg).toContain('2h 41m · 38 steps')
  expect(night.right.svg).toContain('US$6.10 of 25')
  // The critic's contrast fixes: dark words on the gold, light words on the burnt-orange end.
  expect(day.left.svg).toContain('#3D1C03')
  expect(day.right.svg).toContain('#FFE8D6')
  expect(day.left.svg + day.right.svg).not.toContain('#5A2E06')
  // A few still stars at night only, in the right-hand end.
  expect(day.right.svg.match(/fill-opacity="\.(45|7)"/g)).toBeNull()
  expect((night.right.svg.match(/<circle /g) ?? []).length).toBe(5)
  // The grace slide: across all three parts, landing on the switch at 4 s; the words carry no countdown number.
  const wash = stripParts('toNight', d)
  expect(wash.left.svg).toContain('Goodnight coming')
  expect(wash.left.svg).toContain('Cancel keeps the day')
  // Each part's share of the 4 s follows its width, so the edge moves at one speed, and its edge line leaves no hairline.
  const begins = [wash.left.svg, wash.mid.svg, wash.right.svg].map(x => Number(/begin="([\d.]+)s" dur/.exec(x)?.[1]))
  expect(begins[0]).toBe(0)
  expect(begins[1]).toBeGreaterThan(0)
  expect(begins[2]).toBeGreaterThan(begins[1])
  expect(wash.mid.svg).toContain('attributeName="stroke-opacity" to="0"')
  expect(/in \d/.test(wash.left.svg)).toBe(false)
  expect(stripParts('toDay', d).left.svg).toContain('Goodmorning coming')
  // The arrival: the moon rises and the words fade in, once.
  expect(stripParts('night', d, true).left.svg).toContain('animateTransform')
  expect(stripParts('night', d, false).left.svg).not.toContain('animate')
  // Its words are drawn at full strength first, so they read even if the motion never runs.
  expect(stripParts('night', d, true).left.svg).not.toContain('opacity="0"')
  expect(fmtSpan(2 * 3600_000 + 41 * 60_000)).toBe('2:41')
})

// 0.1.3: a press waits 4 s; pressing again in that time cancels it.
test('a Goodnight press waits 4 s, counting down, then starts the night', async ($, on) => {
  const clock = mock.clock(on, { now: AT })
  mock.store(on)
  const prompts = host(on)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return Text({ children: ['LANES'] }) })
  const ui = await $.ui.mount({ plugin: 'night-shift', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: BAND } as never)
  await ui.press({ key: 'night-shift-action' })
  expect(Boolean(await ui.find({ type: 'Text', text: /Goodnight coming · Cancel keeps the day/ }))).toBe(true)
  await clock.advance(2000)
  expect(await ruleOf($)).toBeUndefined()
  await clock.advance(2500)
  expect(await ruleOf($)).toContain('is asleep')
  expect(prompts.some(p => p.startsWith('Goodnight'))).toBe(true)
  await ui.unmount()
})

test('pressing again within the 4 s cancels: nothing starts', async ($, on) => {
  const clock = mock.clock(on, { now: AT })
  mock.store(on)
  const prompts = host(on)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return Text({ children: ['LANES'] }) })
  const ui = await $.ui.mount({ plugin: 'night-shift', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: BAND } as never)
  await ui.press({ key: 'night-shift-action' })
  await clock.advance(1500)
  await ui.press({ key: 'night-shift-action' })
  await clock.advance(5000)
  expect(await ruleOf($)).toBeUndefined()
  expect(prompts).toHaveLength(0)
  expect(Boolean(await ui.find({ type: 'Text', text: /you're in charge/ }))).toBe(true)
  await ui.unmount()
})

// 0.4.0: the usage row in the Route A look, in place of skins' own band row.
test('the usage row: a quiet panel, one ring per meter, amber from 80 % and coral from 95 %', async () => {
  const dark = usageSvg(800, [{ label: 'context', percent: 65 }, { label: '7d', percent: 60 }], false)
  expect(dark).toContain('#2C2C2B')
  expect(dark).toContain('65%')
  expect(dark).toContain('context')
  expect(dark).toContain('7d')
  expect(dark).toContain('#38BDF8')
  expect(usageSvg(800, [{ label: 'context', percent: 85 }], false)).toContain('#FB923C')
  expect(usageSvg(800, [{ label: 'context', percent: 97 }], false)).toContain('#FB7185')
  expect(usageSvg(800, [{ label: 'context', percent: 50 }], true)).toContain('#FFFFFF')
  expect(limitLabel('seven_day')).toBe('7d')
  expect(limitLabel('five_hour')).toBe('5h')
  const Box = (p: Record<string, unknown>) => ({ type: 'Box', props: p, children: (p.children as unknown[]) ?? [] })
  const Text = (p: Record<string, unknown>) => ({ type: 'Text', props: p, children: (p.children as unknown[]) ?? [] })
  const Button = (p: Record<string, unknown>) => ({ type: 'Button', props: p, children: [] })
  const Svg = (p: Record<string, unknown>) => ({ type: 'Svg', props: p, children: [] })
  type N = { type: string; props: Record<string, unknown>; children: unknown[] }
  const walk = (n: unknown): N[] => (n && typeof n === 'object' && 'type' in (n as N) ? [n as N, ...((n as N).children ?? []).flatMap(walk)] : [])
  const idle = walk(usageTree({ Box, Text, Button, Svg } as never, [{ label: 'context', percent: 65 }], false, 117, true, () => undefined))
  expect(idle.some(k => k.type === 'Button' && k.props?.label === 'Compact' && k.props?.variant === 'secondary')).toBe(true)
  // Compact sits inside the panel's colour, attached at its right end.
  expect(idle.some(k => k.type === 'Box' && k.props.backgroundColor === '#2C2C2B' && k.children.some(c => (c as N).type === 'Button'))).toBe(true)
  // While Claude works it keeps its place, dim, so the meters never move.
  const busy = walk(usageTree({ Box, Text, Button, Svg } as never, [{ label: 'context', percent: 65 }], false, 117, false, () => undefined))
  expect(busy.find(k => k.type === 'Button')?.props.dimColor).toBe(true)
  const svgOf = (t: N[]) => String(t.find(k => k.type === 'Svg')?.props.source)
  expect(svgOf(busy)).toBe(svgOf(idle))
})

// 0.5.0: the switch is attached inside the bar's right end, the current side filled; the bar is built from parts the app lays out.
test('the attached switch: Goodnight | Goodmorning inside the bar, the current side filled, no app border', async () => {
  const Box = (p: Record<string, unknown>) => ({ type: 'Box', props: p, children: (p.children as unknown[]) ?? [] })
  const Text = (p: Record<string, unknown>) => ({ type: 'Text', props: p, children: (p.children as unknown[]) ?? [] })
  const Button = (p: Record<string, unknown>) => ({ type: 'Button', props: p, children: [] })
  const Svg = (p: Record<string, unknown>) => ({ type: 'Svg', props: p, children: [] })
  type N = { type: string; props: Record<string, unknown>; children: unknown[] }
  const walk = (n: unknown): N[] => (n && typeof n === 'object' && 'type' in (n as N) ? [n as N, ...((n as N).children ?? []).flatMap(walk)] : [])
  const view = (o: Record<string, unknown> = {}) => ({ night: null, stats: null, direction: 'hold' as const, now: AT, spent: 1, cap: 25, pending: null, arriving: false, isLight: false, cols: 117, onAction: () => undefined, onDirection: () => undefined, ...o })
  const buttons = (t: unknown) => walk(t).filter(n => n.type === 'Button').map(n => `${n.props.label}:${n.props.variant}`)
  const day = stripTree({ Box, Text, Button, Svg } as never, view())
  expect(buttons(day)).toEqual(['Hold for me:secondary', 'Goodnight:secondary', 'Goodmorning:primary'])
  // No Box draws a border (the app frames a bordered Box thickly); one Box stretches a drawing with no width.
  expect(walk(day).some(n => n.type === 'Box' && n.props.borderStyle)).toBe(false)
  expect(walk(day).some(n => n.type === 'Svg' && n.props.width === undefined && String(n.props.source).includes('preserveAspectRatio="none"'))).toBe(true)
  // The switch sits in the bar's own colour, and a rounded end follows it.
  expect(walk(day).some(n => n.type === 'Box' && n.props.backgroundColor === DAY_END && n.props.gap === 0 && n.children.some(c => (c as N).type === 'Button'))).toBe(true)
  expect(String(walk(day).filter(n => n.type === 'Svg').pop()?.props.alt)).toBe('bar end')
  const night = { startedAt: AT, costAtStart: 0, turns: 0, steps: 3, decisions: 1, held: 0, log: 'L.md', direction: 'hold' as const, stopped: null }
  expect(buttons(stripTree({ Box, Text, Button, Svg } as never, view({ night })))).toEqual(['Hold for me:secondary', 'Goodnight:primary', 'Goodmorning:secondary'])
  // In the grace seconds the pressed side reads Cancel and the current side stays filled until the slide lands.
  expect(buttons(stripTree({ Box, Text, Button, Svg } as never, view({ pending: { to: 'night', at: AT } })))).toEqual(['Hold for me:secondary', 'Cancel:secondary', 'Goodmorning:primary'])
  expect(buttons(stripTree({ Box, Text, Button, Svg } as never, view({ night, pending: { to: 'morning', at: AT } })))).toEqual(['Hold for me:secondary', 'Goodnight:primary', 'Cancel:secondary'])
  // The slide plays in the drawings while a press waits.
  expect(walk(stripTree({ Box, Text, Button, Svg } as never, view({ pending: { to: 'night', at: AT } }))).filter(n => n.type === 'Svg' && n.props.isInteractive).length).toBeGreaterThanOrEqual(3)
})

// The tech QA's overflow sweep: at every band width from 60 to 140 columns, every state's fixed parts fit beside the switch.
test('the strip fits the band from 60 to 140 columns in every state', async () => {
  const d = { direction: 'Claude decides', stats: '12h 41m · 1388 steps · 99 decisions · 12 held · stopped: the US$25 cap', spend: 'US$24.10 of 25', spendFrac: 0.96 }
  const BTNW: Record<string, number> = { Goodnight: 90, Goodmorning: 112, 'Claude decides': 120, Cancel: 64 }
  for (const mode of ['day', 'night', 'toNight', 'toDay'] as const) {
    for (let cols = 60; cols <= 140; cols += 4) {
      const { fit, d: dd } = stripFit(mode, d, cols, 'Claude decides')
      const p = stripParts(mode, dd, false, fit)
      const pair = mode === 'toNight' ? BTNW.Cancel + BTNW.Goodmorning : mode === 'toDay' ? BTNW.Goodnight + BTNW.Cancel : BTNW.Goodnight + BTNW.Goodmorning
      const total = p.left.w + 16 + p.right.w + BTNW['Claude decides'] + 16 + pair + 3 + 1 + 8
      expect(total).toBeLessThanOrEqual(cols * 8)
    }
  }
})

// 0.6.0: smart keep-warm. Auto drives cache-tax's /keepwarm only when it is worth it, and only when the plan changes.
test('keep warm: Auto warms big sessions and early-ended nights, never during a night, and folds cache-tax’s row', async () => {
  const now = new Date(2026, 10, 2, 23, 0).getTime()
  const night = { startedAt: now, costAtStart: 0, turns: 0, steps: 0, decisions: 0, held: 0, log: 'L.md', direction: 'hold' as const, stopped: null }
  const base = { mode: 'auto' as const, ctx: 120_000, night: null, now, wakeAt: '08:00', current: null }
  // Big session by day: six hours, then left alone until under three hours remain.
  expect(warmPlan(base)).toEqual({ arm: 6 * 3600_000, why: 'day' })
  expect(warmPlan({ ...base, current: { until: now + 5 * 3600_000, why: 'day' } })).toBe('leave')
  expect(warmPlan({ ...base, current: { until: now + 2 * 3600_000, why: 'day' } })).toEqual({ arm: 6 * 3600_000, why: 'day' })
  // A small session restarts for cents: nothing to arm.
  expect(warmPlan({ ...base, ctx: 20_000 })).toBe('leave')
  // A running night keeps itself warm; one that stopped early is warmed until the wake-up time when that is within eight hours.
  expect(warmPlan({ ...base, night })).toBe('leave')
  // 23:00 to 08:00 is nine hours: more pings than a cold restart is worth, so nothing is armed.
  expect(warmPlan({ ...base, night: { ...night, stopped: 'done' } })).toBe('leave')
  const late = new Date(2026, 10, 3, 1, 30).getTime()
  expect(warmPlan({ ...base, now: late, night: { ...night, stopped: 'done' } })).toEqual({ arm: msUntil(late, '08:00'), why: 'night' })
  // Off stops only a window this mod armed.
  expect(warmPlan({ ...base, mode: 'off' })).toBe('leave')
  expect(warmPlan({ ...base, mode: 'off', current: { until: now + 3600_000, why: 'day' } })).toBe('off')
  expect(fmtWindow(6 * 3600_000)).toBe('6h')
  expect(fmtWindow(6.5 * 3600_000)).toBe('6h30m')
  expect(fmtWindow(45 * 60_000)).toBe('45m')
  expect(cacheView(now, now - 18 * 60_000, null)).toEqual({ state: 'warm', ms: 42 * 60_000 })
  expect(cacheView(now, now - 2 * 3600_000, null).state).toBe('cold')
  expect(cacheView(now, now - 2 * 3600_000, { until: now + 3600_000, why: 'day' }).state).toBe('kept')
  expect(cacheView(now, 0, null).state).toBe('none')
  // A /keepwarm you typed shows at once, even before this process has seen a turn.
  expect(cacheView(now, 0, { until: now + 6 * 3600_000, why: 'manual' }).state).toBe('kept')
  expect(parseWindow('90m')).toBe(90 * 60_000)
  expect(parseWindow('2h30m')).toBe(150 * 60_000)
  expect(parseWindow('status')).toBeNull()
  // cache-tax's own row goes; everything around it stays.
  const row = { type: 'Box', props: {}, children: [{ type: 'Box', props: {}, children: [] }, { type: 'Text', props: {}, children: [' cache-tax · ', { type: 'Text', props: {}, children: ['warm'] }, ' · keepwarm 5h left'] }] }
  const rest = { type: 'Box', props: { key: 'savvy' }, children: [{ type: 'Text', props: {}, children: ['LANES'] }] }
  const out = dropCacheTaxRow({ type: 'Box', props: {}, children: [rest, row] }) as { children: unknown[] }
  expect(out.children).toEqual([rest])
})

test('the desktop accepts the usage bar with the cache and the Warm button', async ($, on) => {
  mock.clock(on, { now: AT })
  on('ui.render', ($, e) => {
    const ui = $.ui.resolve(e) as never as Record<string, (p: unknown) => unknown>
    return usageTree({ Box: ui.Box, Text: ui.Text, Button: ui.Button, Svg: ui.Svg } as never, [{ label: 'context', percent: 64 }, { label: '7d', percent: 63 }], false, 117, true, () => undefined,
      { mode: 'auto', cache: { state: 'warm', ms: 42 * 60_000 }, onPress: () => undefined }) as never
  })
  const ui = await $.ui.mount({ plugin: 'night-shift', component: 'AbovePrompt', requestId: 'band', surface: 'desktop', props: BAND } as never)
  expect(Boolean(await ui.find({ type: 'Button', text: /Warm: Auto/ }))).toBe(true)
  expect(Boolean(await ui.find({ type: 'Button', text: /Compact/ }))).toBe(true)
  expect(Boolean(await ui.find({ type: 'Svg', alt: /cache warm/ }))).toBe(true)
  await ui.unmount()
})

