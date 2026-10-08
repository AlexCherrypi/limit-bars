import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit } from '../types'

const limits = atom({ plugin: 'limit-bars', key: 'limits' } as const, [])
const now = atom({ plugin: 'limit-bars', key: 'now' } as const, 0)

const WINDOWS = [
  { kind: 'five_hour', label: '5h' },
  { kind: 'seven_day', label: '7d' },
] as const

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

let timeZone = 'UTC'

function isValidTimeZone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

async function detectTimeZone($: EngineInterface): Promise<string> {
  const candidates: (string | undefined)[] = []
  candidates.push((await safe(() => $.env.get('TZ')))?.replace(/^:/, ''))
  const localtime = await safe(() => $.fs.stat('/etc/localtime', { resolve: true }))
  candidates.push(localtime?.realPath?.match(/zoneinfo\/(.+)$/)?.[1])
  try {
    candidates.push(Intl.DateTimeFormat().resolvedOptions().timeZone)
  } catch {
    // no system zone from Intl
  }
  return candidates.map(c => c?.trim() ?? '').find(isValidTimeZone) ?? 'UTC'
}

type Parts = { day: string; time: string; weekday: string; dayMonth: string }

function parts(ms: number): Parts {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const get = (type: string) => p.find(x => x.type === type)?.value ?? '??'
  const y = get('year')
  const m = get('month')
  const d = get('day')
  return {
    day: `${y}-${m}-${d}`,
    time: `${get('hour')}:${get('minute')}`,
    weekday: WEEKDAYS[new Date(Date.UTC(+y, +m - 1, +d)).getUTCDay()] ?? '??',
    dayMonth: `${d}.${m}.`,
  }
}

// "13:00" today, "Mi 14.10. 02:00" on another day.
function fmtReset(ms: number, ref: number): string {
  const t = parts(ms)
  return t.day === parts(ref).day ? t.time : `${t.weekday} ${t.dayMonth} ${t.time}`
}

// "1h 17m", "5d 14h", "12m".
function fmtLeft(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000))
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function barColor(pct: number): 'success' | 'warning' | 'error' {
  if (pct >= 90) return 'error'
  if (pct >= 70) return 'warning'
  return 'success'
}

type Row = { label: string; pct: number; reset: string; left: string }

function rows(list: Limit[], at: number): Row[] {
  const out: Row[] = []
  for (const w of WINDOWS) {
    const l = list.find(x => x.kind === w.kind)
    if (!l) continue
    const resetMs = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    const isPast = !Number.isNaN(resetMs) && resetMs <= at
    out.push({
      label: w.label,
      // Past its reset the window starts over; the next response brings the new figure.
      pct: isPast ? 0 : l.percentUsed,
      reset: Number.isNaN(resetMs) || isPast ? '' : fmtReset(resetMs, at),
      left: Number.isNaN(resetMs) || isPast ? '' : fmtLeft(resetMs - at),
    })
  }
  return out
}
// "5h ▰▰▰▱▱▱▱▱ 42% ↻13:00 (1h 10m) · 7d ▰▰▰▰▰▱▱▱ 63% ↻Mi 14.10. 02:00 (5d 14h)"
function statusText(list: Row[]): string {
  return list
    .map(r => {
      const filled = Math.round((Math.min(r.pct, 100) / 100) * 8)
      const bar = '▰'.repeat(filled) + '▱'.repeat(8 - filled)
      const reset = r.reset ? ` ↻${r.reset}${r.left ? ` (${r.left})` : ''}` : ''
      return `${r.label} ${bar} ${Math.round(r.pct)}%${reset}`
    })
    .join(' · ')
}

// auto: the big bars where they can be drawn (terminal, desktop), the little status
// line everywhere else; big / little: only that one; both: both.
type Display = 'auto' | 'big' | 'little' | 'both'
const DISPLAYS: readonly Display[] = ['auto', 'big', 'little', 'both']

let display: Display = 'auto'
// Set once the band has drawn on a surface that has it (terminal, desktop): from
// then on, in auto mode, the status line would only repeat it.
let isBandShown = false
let lastStatus: string | undefined

async function refreshStatus($: EngineInterface): Promise<void> {
  let text: string | undefined
  if (display === 'little' || display === 'both' || (display === 'auto' && !isBandShown)) {
    const at = (await read($, now)) || (await $.clock.now())
    const list = rows(await read($, limits), at)
    text = list.length ? statusText(list) : undefined
  }
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

async function refresh($: EngineInterface, list?: Limit[]): Promise<void> {
  const at = await $.clock.now()
  if (list) await update($, limits, () => list)
  await update($, now, () => at)
  await refreshStatus($)
}

export const register: Register = (on, options) => {
  display = DISPLAYS.find(d => d === options.display) ?? 'auto'
  isBandShown = false
  lastStatus = undefined

  on('session.start', async ($, e, next) => {
    timeZone = await detectTimeZone($)
    const u = await safe(() => $.session.usage())
    await refresh($, u?.rateLimits.map(r => ({ ...r })))
    // A minute tick moves the countdown and drops a window past its reset.
    $.clock.every(60_000, () => refresh($))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await refresh($, e.rateLimits.map(r => ({ ...r })))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || display === 'little') return next(e)
    const at = (await read($, now)) || (await $.clock.now())
    const list = rows(await read($, limits), at)
    if (list.length === 0) return next(e)

    if (!isBandShown && (e.surface === 'terminal' || e.surface === 'desktop')) {
      isBandShown = true
      await refreshStatus($)
    }

    const { Box, Text } = $.ui.resolve(e)
    const resetWidth = Math.max(...list.map(r => r.reset.length))
    const leftWidth = Math.max(...list.map(r => r.left.length))
    // "5h " + bar + " 100% " + reset + " (" + left + ")"
    const fixed = 3 + 6 + resetWidth + (leftWidth ? leftWidth + 3 : 0)
    const barWidth = Math.max(5, e.props.bodyColumns - fixed)

    return (
      <Box flexDirection="column">
        <Text> </Text>
        {list.map(r => {
          const filled = Math.min(barWidth, Math.round((Math.min(r.pct, 100) / 100) * barWidth))
          return (
            <Box key={r.label} flexDirection="row">
              <Text bold>{`${r.label} `}</Text>
              <Text color={barColor(r.pct)}>{'█'.repeat(filled)}</Text>
              <Text dimColor>{'░'.repeat(barWidth - filled)}</Text>
              <Text>{` ${`${Math.round(r.pct)}%`.padStart(4)} `}</Text>
              <Text>{r.reset.padStart(resetWidth)}</Text>
              {leftWidth ? <Text dimColor>{` (${r.left})`.padEnd(leftWidth + 3)}</Text> : null}
            </Box>
          )
        })}
      </Box>
    )
  })
}
