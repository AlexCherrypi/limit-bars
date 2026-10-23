import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// 2026-10-08 11:43 Europe/Berlin
const NOW = Date.parse('2026-10-08T09:43:00.000Z')

const LIMITS = [
  { kind: 'five_hour', percentUsed: 41, resetsAt: '2026-10-08T11:00:00.000Z' },
  { kind: 'seven_day', percentUsed: 63, resetsAt: '2026-10-14T00:00:00.000Z' },
]

const status: { current: string | undefined } = { current: undefined }

const HOME = '/home/u'
const CONFIG = `${HOME}/.claude.json`
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const LONG = { timeoutMs: 30_000 }

// The account's usage meter as the second `claude` answers get_usage: the 5-hour and
// 7-day utilization in percent, with limits[] as a live answer carries it.
function meter(fiveHour: number, sevenDay: number) {
  return {
    five_hour: { utilization: fiveHour, resets_at: '2026-10-08T12:00:00Z' },
    seven_day: { utilization: sevenDay, resets_at: '2026-10-14T00:00:00Z' },
    limits: [],
  }
}

function usageStdout(rateLimits: unknown): string {
  const unreached = rateLimits === 'unreached'
  const response = { rate_limits_available: unreached || rateLimits !== null, rate_limits: unreached ? null : rateLimits }
  return [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'limit-bars', response } }),
    '',
  ].join('\n')
}

type Run = { argv: string[]; init: { stdin?: string; env?: Record<string, string> } }

// The world beneath the plugin: the session's own figures, ~/.claude.json and the
// second claude. `server.current` is what the meter answers (rate_limits; null: a
// login without rate limits; 'unreached': the fetch failed with nothing cached;
// undefined: the second claude fails).
function world(on: On, rateLimits = LIMITS, env: Record<string, string> = {}) {
  status.current = undefined
  const seen = {
    own: { current: rateLimits },
    files: new Map<string, { text: string; mtimeMs: number }>(),
    server: { current: undefined as unknown },
    runs: [] as Run[],
    // Called inside the second claude's run, before it answers.
    during: { current: undefined as (() => void) | undefined },
  }
  mock.env(on, { TZ: 'Europe/Berlin', ...env })
  on('ui.status', (_$, e) => {
    status.current = e.text
    return { value: undefined } as never
  })
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: seen.own.current } }) as never)
  on('session.start', () => ({ cwd: '/' }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }) as never)
  on('fs.stat', (_$, e) => {
    const f = seen.files.get(e.path)
    if (!f) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } } as never
  })
  on('fs.read', (_$, e) => {
    const f = seen.files.get(e.path)
    if (!f) throw new Error(`ENOENT ${e.path}`)
    return { value: f.text } as never
  })
  on('process.run', (_$, e) => {
    const run = e as unknown as Run
    seen.runs.push(run)
    seen.during.current?.()
    const answer = seen.server.current
    return {
      value: answer === undefined ? { exitCode: 1, stdout: '', stderr: 'failed' } : { exitCode: 0, stdout: usageStdout(answer), stderr: '' },
    } as never
  })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  return { clock: mock.clock(on, { now: NOW }), seen }
}

let mtime = 1
// ~/.claude.json signed in as `uuid` (null: no claude.ai login), or `text` as written.
function login(seen: ReturnType<typeof world>['seen'], uuid: string | null, text?: string) {
  const cfg = uuid ? { numStartups: 3, oauthAccount: { accountUuid: uuid, emailAddress: 'x@example.com' } } : { numStartups: 3 }
  seen.files.set(CONFIG, { text: text ?? JSON.stringify(cfg), mtimeMs: mtime++ })
}

let stepIndex = 0
async function respond($: Engine) {
  for await (const _ of $.turn.step({ turnId: 't1', index: stepIndex++, model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
}

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 60 },
} as const

describe('limit-bars', () => {
  test('draws both windows with their reset time on the right', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/' } as never)
    const ui = await $.ui.mount({ plugin: 'limit-bars', surface: 'terminal', ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /41%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /13:00/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /63%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Mi\ 14\.10\.\ 02:00/ })).toBeDefined()
    await ui.unmount()
  })

  test('a new measurement moves the bar', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/' } as never)
    await $.session.measure({
      context: { window: 1_000_000 },
      rateLimits: [{ ...LIMITS[0]!, percentUsed: 92 }, LIMITS[1]!],
      changed: ['rateLimits'],
    } as never)
    const ui = await $.ui.mount({ plugin: 'limit-bars', surface: 'terminal', ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /92%/ })).toBeDefined()
    await ui.unmount()
  })

  test('a window past its reset shows 0% until the next figure', LONG, async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2 * 60 * 60 * 1000)
    const ui = await $.ui.mount({ plugin: 'limit-bars', surface: 'terminal', ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /^\s+0% $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /41%/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /63%/ })).toBeDefined()
    await ui.unmount()
  })

  test('auto: a status line until the band draws in the terminal', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/' } as never)
    expect(status.current).toBe('5h ▰▰▰▱▱▱▱▱ 41% ↻13:00 (1h 17m) · 7d ▰▰▰▰▰▱▱▱ 63% ↻Mi 14.10. 02:00 (5d 14h)')
    const ui = await $.ui.mount({ plugin: 'limit-bars', surface: 'terminal', ...BAND } as never)
    expect(status.current).toBeUndefined()
    await ui.unmount()
  })

  test('auto: the status line stays where no band is drawn', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/' } as never)
    await $.session.measure({
      context: { window: 1_000_000 },
      rateLimits: [{ ...LIMITS[0]!, percentUsed: 92 }, LIMITS[1]!],
      changed: ['rateLimits'],
    } as never)
    expect(status.current).toContain('5h ▰▰▰▰▰▰▰▱ 92%')
  })

  test('both: the status line stays beside the band', { options: { display: 'both' } }, async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/' } as never)
    const ui = await $.ui.mount({ plugin: 'limit-bars', surface: 'terminal', ...BAND } as never)
    expect(status.current).toContain('7d ')
    await ui.unmount()
  })

  test('big: no status line, only the bars', { options: { display: 'big' } }, async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/' } as never)
    expect(status.current).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'limit-bars', surface: 'terminal', ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /41%/ })).toBeDefined()
    await ui.unmount()
  })

  test('little: only the status line, no bars', { options: { display: 'little' } }, async ($, on) => {
    world(on)
    // The engine's own band beneath: nothing to show.
    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.session.start({ cwd: '/' } as never)
    const ui = await $.ui.mount({ plugin: 'limit-bars', surface: 'terminal', ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /41%/ })).toBeUndefined()
    expect(status.current).toContain('5h ▰▰▰▱▱▱▱▱ 41%')
    await ui.unmount()
  })
})

describe('limit-bars: the account and the server reading', () => {
  const OFF = { options: { reading: 'off' } }
  const mount = ($: Engine) => $.ui.mount({ plugin: 'limit-bars', surface: 'terminal', ...BAND } as never)
  const fetches = (seen: ReturnType<typeof world>['seen']) => seen.runs.filter(r => r.init.stdin?.includes('"get_usage"'))

  test('after a switch to another account the bars show the new one at once', OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(0) // off: no reading while nothing changed
    expect(status.current).toContain('41%')

    seen.server.current = meter(12, 34)
    login(seen, B)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(1)
    expect(status.current).toContain('5h ▰▱▱▱▱▱▱▱ 12%')
    expect(status.current).toContain('34%')
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: /12%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /41%/ })).toBeUndefined()
    await ui.unmount()

    const run = fetches(seen)[0]!
    expect(run.argv.slice(1)).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '',
    ])
    expect(run.init.env?.LIMIT_BARS_CHILD).toBe('1')
    expect(run.init.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('')
  })

  test('the old account\'s figures go, also when the new one has none yet', OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    login(seen, B) // the second claude fails
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(1)
    expect(status.current).toBeUndefined()

    // The next response is the new account's.
    seen.own.current = [{ ...LIMITS[0]!, percentUsed: 7 }, LIMITS[1]!]
    await respond($)
    expect(status.current).toContain('5h ▰▱▱▱▱▱▱▱ 7%')
  })

  test('idle, the server is asked every 5 minutes; while responses come, never', LONG, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    seen.server.current = meter(50, 70)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(1_000)
    // At the start the host's figures are of unknown age: the server's count.
    expect(fetches(seen)).toHaveLength(1)
    expect(status.current).toContain('50%')

    seen.own.current = [{ ...LIMITS[0]!, percentUsed: 52 }, LIMITS[1]!]
    for (let m = 0; m < 4; m++) {
      await clock.advance(60_000)
      await respond($)
      await $.session.measure({ context: { window: 1_000_000 }, rateLimits: seen.own.current, changed: ['rateLimits'] } as never)
    }
    expect(fetches(seen)).toHaveLength(1) // every response brings figures
    expect(status.current).toContain('52%')

    await clock.advance(4 * 60_000 + 50_000)
    expect(fetches(seen)).toHaveLength(1)
    seen.server.current = meter(55, 71)
    await clock.advance(12_000)
    expect(fetches(seen)).toHaveLength(2) // five minutes after the last response
    expect(status.current).toContain('55%')
  })

  test('a cached answer is no reading, and a failure backs off', LONG, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    seen.server.current = { five_hour: { utilization: 99, resets_at: null }, seven_day: { utilization: 99, resets_at: null } }
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(1_000)
    expect(fetches(seen)).toHaveLength(1)
    expect(status.current).toContain('41%')
    expect(status.current).not.toContain('99%')
    await clock.advance(4 * 60_000)
    expect(fetches(seen)).toHaveLength(1)
    await clock.advance(62_000)
    expect(fetches(seen)).toHaveLength(2)
  })

  test('a login without rate limits is asked again only after an hour', LONG, async ($, on) => {
    const { clock, seen } = world(on, [], { HOME })
    login(seen, A)
    seen.server.current = null
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(1_000)
    await clock.advance(59 * 60_000)
    expect(fetches(seen)).toHaveLength(1)
  })

  test('a file half written or gone for a moment is no switch', OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    login(seen, A, '{"oauthAccount": {"accountU')
    await clock.advance(2_000)
    seen.files.delete(CONFIG)
    await clock.advance(2_000)
    login(seen, A)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(0)
    expect(status.current).toContain('41%')
  })

  test('a reading the account switched under is dropped, and the new one is read', OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    seen.server.current = meter(77, 88)
    login(seen, B)
    // While the second claude runs, the account changes once more.
    seen.during.current = () => {
      seen.during.current = undefined
      login(seen, A)
    }
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(1)
    expect(status.current ?? '').not.toContain('77%')

    seen.server.current = meter(5, 6)
    await clock.advance(12_000)
    expect(fetches(seen)).toHaveLength(2)
    expect(status.current).toContain('5h ▱▱▱▱▱▱▱▱ 5%')
  })

  test('without a claude.ai login nothing is asked', async ($, on) => {
    const { clock, seen } = world(on, [], { HOME })
    login(seen, null)
    seen.server.current = meter(1, 2)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(10 * 60_000)
    expect(fetches(seen)).toHaveLength(0)
  })

  test('the second claude itself stays still', async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME, LIMIT_BARS_CHILD: '1' })
    login(seen, A)
    seen.server.current = meter(1, 2)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(10 * 60_000)
    expect(seen.runs).toHaveLength(0)
    expect(status.current).toBeUndefined()
  })
})
