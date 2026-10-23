import type { EngineInterface, Register } from 'claude-code'

type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// What the bars show and the time they were drawn for; a change redraws the band.
let limits: Limit[] = []
let now = 0

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
    const list = rows(limits, now || (await $.clock.now()))
    text = list.length ? statusText(list) : undefined
  }
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

async function refresh($: EngineInterface): Promise<void> {
  now = await $.clock.now()
  limits = shown()
  $.ui.invalidate('ui.render')
  await refreshStatus($)
}

// ---------------------------------------------------------------- Readings
//
// The host fills the rate limits only from the headers of model responses: while
// the session is idle they stand still, usage elsewhere on the account stays
// unseen, and after a switch to another account (a /login, an account switcher)
// they are the old account's until the next response. So the bars also read the
// account's usage meter through a second, short-lived `claude` (the SDK's
// get_usage request, the fetch /usage does: no model request, no tokens, about
// 3 s), and they watch ~/.claude.json for the account, so right after a switch
// they show the new one's figures.
//
// No hook ever waits for a reading. A hook's budget clock stops only for its own
// $ calls, so waiting for a child process the timer started spends it, and two
// overruns in a row get the hooks worker replaced. The watch timer takes every
// reading.

const WATCH_MS = 2_000 // how often ~/.claude.json is looked at (a stat; read only when it changed)
const USAGE_TIMEOUT_MS = 10_000
const USAGE_MIN_GAP_MS = 10_000 // between two readings, also when the account flips back and forth
const USAGE_MAX_AGE_MS = 10 * 60_000 // an answer older than this is the engine's cache
const USAGE_SNAPSHOT_MS = 60_000 // the engine answers get_usage from a snapshot up to this old, as fresh
const USAGE_BACKOFF_MS = 5 * 60_000 // after a failed reading, doubling each time
const USAGE_SWITCH_RETRY_MS = 30_000 // after a failed reading for a new account, doubling each time
const USAGE_BACKOFF_MAX_MS = 60 * 60_000
// Set in the second claude's environment: a limit-bars loaded there stays still.
const CHILD_MARKER = 'LIMIT_BARS_CHILD'

// The `reading` option: how often the server is asked while no response brings
// new figures; off = only right after an account switch.
const READINGS: Record<string, number> = { '5': 5 * 60_000, '15': 15 * 60_000, '30': 30 * 60_000, off: 0 }
let readEvery = READINGS['5']!

// The host's own figures, from the last response that moved them.
let own: Limit[] = []
let lastResponseAt = Number.NEGATIVE_INFINITY
// The signed-in account as ~/.claude.json names it: undefined until it could be
// read, null when it names none (no claude.ai login).
let account: string | null | undefined
let accountSwitchedAt = Number.NEGATIVE_INFINITY
// A switch whose new account has no reading yet.
let switchPending = false
let accountPath: string | null | undefined
let fileStamp: string | null = null
// The last 20 characters of each API key the person let a session use, as the file keeps
// them (customApiKeyResponses.approved); undefined until it could be read.
let approvedKeys: readonly string[] | undefined
let interactive = false // a person is at the prompt (session.start says)
let stepsOut = new Map<object, number>() // the model requests out now, each with when it went out
let oldStepBackAt = Number.NEGATIVE_INFINITY // when the last one sent before the switch came back
let reading: { at: number; account: string | null | undefined; limits: Limit[] } | null = null
let lastTryAt = Number.NEGATIVE_INFINITY
let failures = 0
let backoffUntil = 0
let ticking = false
let timers: { cancel: () => void }[] = []

// Per window the newest figures: the server's for this account when they are newer than
// the last response (a snapshot can be up to USAGE_SNAPSHOT_MS old), else the host's,
// which come with every response; either fills in what the other leaves out. After a
// switch the host's belong to the old account until the next response, so they wait.
function shown(): Limit[] {
  const out = accountSwitchedAt > lastResponseAt ? [] : own.map(l => ({ ...l }))
  const r = reading
  if (!r || r.account !== account) return out
  const isNewer = r.at - USAGE_SNAPSHOT_MS > lastResponseAt
  for (const l of r.limits) {
    const i = out.findIndex(x => x.kind === l.kind)
    if (i < 0) out.push({ ...l })
    else if (isNewer) out[i] = { ...l }
  }
  return out
}

// $CLAUDE_CONFIG_DIR/.claude.json, else the home folder's, as the engine finds it
// (os.homedir(): USERPROFILE on Windows, also where a shell sets HOME).
async function accountFile($: EngineInterface): Promise<string | null> {
  if (accountPath !== undefined) return accountPath
  const home = await safe(() => $.env.get('HOME'))
  const profile = await safe(() => $.env.get('USERPROFILE'))
  const isWindows = (await safe(() => $.env.get('OS'))) === 'Windows_NT'
  const dir = (await safe(() => $.env.get('CLAUDE_CONFIG_DIR'))) || (isWindows ? profile || home : home || profile)
  accountPath = dir ? `${dir.replace(/[\\/]+$/, '')}/.claude.json` : null
  return accountPath
}

// The account in the file, read again only when its stat changed (the engine rewrites
// it often); undefined when it cannot be read just now (missing, half written, over
// $.fs.read's 4 MiB): that is no switch.
async function readAccount($: EngineInterface): Promise<string | null | undefined> {
  const path = await accountFile($)
  if (!path) return undefined
  const st = await safe(() => $.fs.stat(path))
  if (!st) return undefined
  const stamp = `${st.mtimeMs}:${st.size}`
  if (stamp === fileStamp && account !== undefined) return account
  const text = await safe(() => $.fs.read(path))
  if (typeof text !== 'string') return undefined
  try {
    const config = JSON.parse(text)
    const id = config?.oauthAccount?.accountUuid
    const approved = config?.customApiKeyResponses?.approved
    approvedKeys = Array.isArray(approved) ? approved.filter((k): k is string => typeof k === 'string') : []
    fileStamp = stamp
    return typeof id === 'string' && id ? id : null
  } catch {
    return undefined
  }
}

// True when the account changed since the last look.
async function checkAccount($: EngineInterface): Promise<boolean> {
  const seen = await readAccount($)
  if (seen === undefined) return false
  const before = account
  account = seen
  if (before === undefined || before === seen) return false
  accountSwitchedAt = await $.clock.now()
  switchPending = seen !== null
  failures = 0
  backoffUntil = 0
  return true
}

// An ISO time or epoch seconds / milliseconds -> ms; null when it is none.
function parseTime(v: unknown): number | null {
  const ms = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : typeof v === 'string' ? Date.parse(v) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

type UsageAnswer = { limits: Limit[] } | { error: string; final?: boolean }

// control_response.response.response.rate_limits.five_hour|seven_day = { utilization
// (a percentage), resets_at }. An answer from the engine's cache (its fetch failed, e.g.
// 429) has no rate_limits.limits[], and seven_day_breakdown.as_of is the server time of
// the body: both are checked, or old figures would pass as fresh. rate_limits_available
// false is a login without rate limits; rate_limits null beside it true is a fetch that
// failed with nothing cached (429, network).
function parseUsage(stdout: string, at: number): UsageAnswer {
  for (const line of stdout.split('\n')) {
    if (!line.includes('"control_response"')) continue
    let res: Record<string, any> | undefined
    try {
      res = JSON.parse(line)?.response
    } catch {
      continue
    }
    if (res?.subtype === 'error') return { error: String(res.error ?? 'the request failed') }
    const body = res?.response
    if (!body || typeof body !== 'object') continue
    if (body.rate_limits_available === false) return { error: 'this login has no rate limits', final: true }
    const rl = body.rate_limits
    if (!rl || typeof rl !== 'object') return { error: 'the server was not reached, and nothing was cached' }
    const asOf = parseTime(rl.seven_day_breakdown?.as_of)
    if (!Array.isArray(rl.limits) || (asOf !== null && at - asOf > USAGE_MAX_AGE_MS)) {
      return { error: 'only a cached answer, the server was not reached' }
    }
    const out: Limit[] = []
    for (const w of WINDOWS) {
      const x = rl[w.kind]
      if (!x || typeof x.utilization !== 'number' || !Number.isFinite(x.utilization)) continue
      const reset = parseTime(x.resets_at)
      out.push({ kind: w.kind, percentUsed: x.utilization, ...(reset !== null ? { resetsAt: new Date(reset).toISOString() } : {}) })
    }
    return out.length > 0 ? { limits: out } : { error: 'no 5-hour or 7-day limit in the answer' }
  }
  return { error: 'no answer' }
}

// Whether the session itself runs on the API key in the environment, which the host
// picks this way: -p and the SDK take it as it is (not under VS Code), a session with a
// person at the prompt only once they let it. Not read yet, as if they did.
async function sessionUsesKey($: EngineInterface, key: string): Promise<boolean> {
  if (!interactive && (await safe(() => $.env.get('CLAUDE_CODE_ENTRYPOINT'))) !== 'claude-vscode') return true
  return approvedKeys === undefined || approvedKeys.includes(key.slice(-20))
}

async function fetchUsage($: EngineInterface): Promise<UsageAnswer> {
  const exe = (await safe(() => $.env.get('CLAUDE_CODE_EXECPATH'))) || 'claude'
  // An apiKeyHelper in the settings: the session runs on its key, not on the claude.ai
  // login, which the child – reading no settings – would read the limits of.
  if (await safe(() => $.settings.read({ key: 'apiKeyHelper' }))) {
    return { error: 'the session runs on an apiKeyHelper, which has no rate limits to read', final: true }
  }
  // -p would take a key from the environment over the claude.ai login the session runs
  // on, and answer that there are no rate limits.
  const key = (await safe(() => $.env.get('ANTHROPIC_API_KEY')))?.trim()
  const dropKey = !!key && !(await sessionUsesKey($, key))
  try {
    const r = await $.process.run(
      [
        exe, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--no-session-persistence', '--strict-mcp-config',
        '--setting-sources', '', // no settings: no plugins or hooks of the person's or the project's
      ],
      {
        stdin: `${JSON.stringify({ type: 'control_request', request_id: 'limit-bars', request: { subtype: 'get_usage', skip_behaviors: true } })}\n`,
        env: {
          // Set, the fetch fails silently and the answer falls back to the cache.
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '',
          ...(dropKey ? { ANTHROPIC_API_KEY: '' } : {}),
          CLAUDE_CODE_PLUGIN_DIRS: '',
          [CHILD_MARKER]: '1',
        },
        timeoutMs: USAGE_TIMEOUT_MS,
      },
    )
    const answer = parseUsage(r.stdout, await $.clock.now())
    return 'error' in answer && answer.error === 'no answer' && r.exitCode !== 0
      ? { error: `the second claude exited with ${r.exitCode}` }
      : answer
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// Whether the host's figures are the account's since the last switch once the response to
// a request sent at `sentAt` came: the request went out after the switch, and none sent
// before it came back since or is still out – its headers, under the old account, would
// put that one's figures back.
function isNewAccount(sentAt: number): boolean {
  if (sentAt < accountSwitchedAt || sentAt < oldStepBackAt) return false
  for (const s of stepsOut.values()) if (s < accountSwitchedAt) return false
  return true
}

// When the newest figures at hand came: the server's for this account, or the last
// response's, unless that one was before a switch.
function newestAt(): number {
  const r = reading && reading.account === account ? reading.at : Number.NEGATIVE_INFINITY
  return Math.max(r, accountSwitchedAt > lastResponseAt ? Number.NEGATIVE_INFINITY : lastResponseAt)
}

function isReadingDue(at: number): boolean {
  if (account === null || at < backoffUntil || at - lastTryAt < USAGE_MIN_GAP_MS) return false
  if (switchPending) return true
  return readEvery > 0 && at - newestAt() >= readEvery
}

async function takeReading($: EngineInterface): Promise<void> {
  const asked = await $.clock.now()
  lastTryAt = asked
  const forAccount = account
  const r = await fetchUsage($)
  // An answer that may be the account's before a switch is dropped; the switch reads again.
  if ((await checkAccount($)) || account !== forAccount) return
  if ('limits' in r) {
    // Dated when it was asked for: it may come from a snapshot taken a little before.
    reading = { at: asked, account: forAccount, limits: r.limits }
    switchPending = false
    failures = 0
    backoffUntil = 0
    return
  }
  // A new account's reading is tried again soon (the bars wait empty for it), any
  // other later; a login without rate limits only after an hour.
  failures += 1
  if (r.final) switchPending = false
  const first = switchPending ? USAGE_SWITCH_RETRY_MS : USAGE_BACKOFF_MS
  const wait = r.final ? USAGE_BACKOFF_MAX_MS : Math.min(USAGE_BACKOFF_MAX_MS, first * 2 ** (failures - 1))
  backoffUntil = (await $.clock.now()) + wait
}

// The watch: a look at the account file, a reading when one is due, then the bars. A
// switch hides the old account's figures at once, before the new one's are read, also
// when only the look after a reading saw it. A session that draws nowhere (-p, the SDK)
// is not read for.
async function watchTick($: EngineInterface): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    if (await checkAccount($)) await refresh($)
    const switchedAt = accountSwitchedAt
    const had = reading
    if (isReadingDue(await $.clock.now()) && (await draws($))) await takeReading($)
    if (reading !== had || accountSwitchedAt !== switchedAt) await refresh($)
  } catch {
    // the next look tries again
  } finally {
    ticking = false
  }
}

async function draws($: EngineInterface): Promise<boolean> {
  const surfaces = await safe(() => $.session.surfaces())
  return surfaces === undefined || surfaces.length > 0
}

export const register: Register = (on, options) => {
  display = DISPLAYS.find(d => d === options.display) ?? 'auto'
  readEvery = READINGS[String(options.reading)] ?? READINGS['5']!
  isBandShown = false
  lastStatus = undefined
  limits = []
  now = 0
  own = []
  lastResponseAt = Number.NEGATIVE_INFINITY
  account = undefined
  accountSwitchedAt = Number.NEGATIVE_INFINITY
  switchPending = false
  accountPath = undefined
  fileStamp = null
  approvedKeys = undefined
  interactive = false
  stepsOut = new Map()
  oldStepBackAt = Number.NEGATIVE_INFINITY
  reading = null
  lastTryAt = Number.NEGATIVE_INFINITY
  failures = 0
  backoffUntil = 0
  ticking = false
  timers = []

  on('session.start', async ($, e, next) => {
    for (const t of timers) t.cancel()
    timers = []
    if ((await safe(() => $.env.get('LIMIT_BARS_CHILD'))) !== undefined) return next(e)
    interactive = e.isInteractive === true
    timeZone = await detectTimeZone($)
    const u = await safe(() => $.session.usage())
    own = u?.rateLimits.map(r => ({ ...r })) ?? []
    await refresh($)
    // A minute tick moves the countdown and drops a window past its reset.
    timers.push($.clock.every(60_000, () => void refresh($)))
    timers.push($.clock.every(WATCH_MS, () => void watchTick($)))
    timers.push($.clock.after(0, () => void watchTick($)))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      own = e.rateLimits.map(r => ({ ...r }))
      await refresh($)
    }
    return next(e)
  })

  // A response came: the host's figures are from now, and after a switch they are the new
  // account's – unless they may still be the old one's (isNewAccount).
  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    const step = {}
    stepsOut.set(step, sentAt)
    try {
      const r = yield* next(e)
      if (r.stopReason !== null && isNewAccount(sentAt)) {
        const isFirstAfterSwitch = accountSwitchedAt > lastResponseAt
        lastResponseAt = await $.clock.now()
        if (isFirstAfterSwitch) {
          switchPending = false // the new account's figures are in
          const u = await safe(() => $.session.usage())
          if (u) own = u.rateLimits.map(l => ({ ...l }))
        }
        // An older server reading may have counted over them until now.
        await refresh($)
      }
      return r
    } finally {
      stepsOut.delete(step)
      if (sentAt < accountSwitchedAt) oldStepBackAt = await $.clock.now()
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || display === 'little') return next(e)
    const list = rows(limits, now || (await $.clock.now()))
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
