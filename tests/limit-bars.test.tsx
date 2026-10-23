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
    // How long the second claude and a model request take (on the mocked clock).
    runMs: { current: 0 },
    stepMs: { current: 0 },
    // How the step ends, and what changes when its response lands.
    stop: { current: 'end_turn' as string | null },
    onLand: { current: undefined as (() => void) | undefined },
    surfaces: { current: ['terminal'] as string[] },
    // The status line while the second claude ran.
    statusDuringRun: [] as (string | undefined)[],
  }
  let clock: ReturnType<typeof mock.clock>
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
  on('session.surfaces', () => ({ value: seen.surfaces.current }) as never)
  on('process.run', async (_$, e) => {
    const run = e as unknown as Run
    seen.runs.push(run)
    seen.statusDuringRun.push(status.current)
    seen.during.current?.()
    const answer = seen.server.current
    if (seen.runMs.current) await clock.sleep(seen.runMs.current)
    return {
      value: answer === undefined ? { exitCode: 1, stdout: '', stderr: 'failed' } : { exitCode: 0, stdout: usageStdout(answer), stderr: '' },
    } as never
  })
  on('turn.step', async function* (_$, e) {
    if (seen.stepMs.current) await clock.sleep(seen.stepMs.current)
    seen.onLand.current?.()
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: seen.stop.current, usage: null } as never
  })
  clock = mock.clock(on, { now: NOW })
  return { clock, seen }
}

let mtime = 1
// ~/.claude.json signed in as `uuid` (null: no claude.ai login), or `text` as written.
function login(seen: ReturnType<typeof world>['seen'], uuid: string | null, text?: string, path = CONFIG) {
  const cfg = uuid ? { numStartups: 3, oauthAccount: { accountUuid: uuid, emailAddress: 'x@example.com' } } : { numStartups: 3 }
  seen.files.set(path, { text: text ?? JSON.stringify(cfg), mtimeMs: mtime++ })
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
    expect(run.init.env).not.toHaveProperty('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
    // No key in the environment: nothing to leave out. A token the session runs on, as the child does.
    expect(run.init.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(run.init.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
  })

  const KEY = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbb'
  const withKeys = (seen: ReturnType<typeof world>['seen'], approved: string[], rejected: string[]) =>
    login(seen, A, JSON.stringify({ oauthAccount: { accountUuid: A }, customApiKeyResponses: { approved, rejected } }))

  test('the second claude leaves out an API key the session does not run on', LONG, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME, ANTHROPIC_API_KEY: KEY })
    seen.server.current = meter(12, 34)
    const lastEnv = () => fetches(seen).at(-1)!.init.env
    withKeys(seen, [], [KEY.slice(-20)])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(1)
    // Declined at the prompt: the session runs on the claude.ai login, which -p would pass over.
    expect(lastEnv()?.ANTHROPIC_API_KEY).toBe('')

    withKeys(seen, [KEY.slice(-20)], [])
    await clock.advance(5 * 60_000)
    expect(fetches(seen)).toHaveLength(2)
    expect(lastEnv()).not.toHaveProperty('ANTHROPIC_API_KEY') // approved: the session runs on the key

    withKeys(seen, [], [])
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await clock.advance(5 * 60_000)
    expect(fetches(seen)).toHaveLength(3)
    expect(lastEnv()).not.toHaveProperty('ANTHROPIC_API_KEY') // -p and the SDK take it as it is
  })

  test('with nonessential traffic turned off the server is not asked', async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    seen.server.current = meter(12, 34)
    login(seen, A)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    login(seen, B)
    await clock.advance(30 * 60_000)
    expect(fetches(seen)).toHaveLength(0)
    seen.own.current = [{ ...LIMITS[0]!, percentUsed: 14 }, LIMITS[1]!]
    await respond($)
    expect(status.current).toContain('14%') // the session's own
  })

  test('the account watch is kept for the session', OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    on('session.id', () => ({ value: 'sess-1' }) as never)
    const writes: unknown[] = []
    on('state.set', (_$, e, next) => {
      if ((e as unknown as { key: string }).key === 'account') writes.push((e as unknown as { value: unknown }).value)
      return next(e)
    })
    login(seen, A)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    expect(writes.at(-1)).toEqual({ session: 'sess-1', account: A, waiting: false, switchPending: false, reading: null })
    login(seen, B) // the second claude fails
    await clock.advance(2_000)
    expect(writes.at(-1)).toEqual({ session: 'sess-1', account: B, waiting: true, switchPending: true, reading: null })
    await respond($)
    expect(writes.at(-1)).toEqual({ session: 'sess-1', account: B, waiting: false, switchPending: false, reading: null })
  })

  const kept = (on: On, value: Record<string, unknown>) => {
    on('session.id', () => ({ value: 'sess-1' }) as never)
    on('state.get', (_$, e, next) => {
      if ((e as unknown as { key: string }).key !== 'account') return next(e)
      return { value: { value: { session: 'sess-1', switchPending: false, reading: null, ...value }, version: 1 } } as never
    })
  }

  test('a fresh copy of the module still waits for the new account after a reload', OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME }) // the host still holds A's figures
    kept(on, { account: B, waiting: true, switchPending: true })
    login(seen, B)
    await $.session.start({ cwd: '/' } as never) // a changed option reloaded the mod
    expect(status.current ?? '').not.toContain('41%')
    seen.server.current = meter(12, 34)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(1) // the new account is read at once, as before the reload
    expect(status.current).toContain('12%')
  })

  test('a switch while no copy of the module ran is still seen', OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    kept(on, { account: A, waiting: false })
    login(seen, B)
    await $.session.start({ cwd: '/' } as never)
    seen.server.current = meter(12, 34)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(1)
    expect(status.current).toContain('12%')
    expect(status.current).not.toContain('41%')
  })

  test("another session's kept account is not taken", OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    on('session.id', () => ({ value: 'sess-2' }) as never)
    on('state.get', (_$, e, next) => {
      if ((e as unknown as { key: string }).key !== 'account') return next(e)
      return { value: { value: { session: 'sess-1', account: A, waiting: false, switchPending: false, reading: null }, version: 1 } } as never
    })
    login(seen, B)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(0) // no switch: this session started on B
    expect(status.current).toContain('41%')
  })

  test('a session on an apiKeyHelper reads no limits from the server', async ($, on) => {
    const { clock, seen } = world(on, [], { HOME })
    on('settings.read', () => ({ value: { apiKeyHelper: '~/bin/anthropic-key.sh' } }) as never)
    seen.server.current = meter(12, 34) // the claude.ai login's, which the session does not run on
    login(seen, A)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(30 * 60_000)
    expect(fetches(seen)).toHaveLength(0)
    expect(status.current).toBeUndefined()
  })

  test('under VS Code the key counts only once approved, as in the terminal', async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME, ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' })
    seen.server.current = meter(12, 34)
    withKeys(seen, [], [])
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    seen.surfaces.current = ['vscode']
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(1)
    expect(fetches(seen)[0]!.init.env?.ANTHROPIC_API_KEY).toBe('')
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
    await clock.advance(62_000)
    expect(fetches(seen)).toHaveLength(2)
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

  test('a response sent before a switch does not bring the old account back', { ...OFF, ...LONG }, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    seen.stepMs.current = 20_000
    const step = respond($) // A's request goes out
    await clock.advance(2_000)
    seen.server.current = meter(13, 35)
    login(seen, B) // a /login in another window
    await clock.advance(6_000)
    expect(status.current).toContain('13%')
    await clock.advance(13_000)
    await step // A's response lands, its headers still A's
    expect(status.current).toContain('13%')
    expect(status.current).not.toContain('41%')
    await clock.advance(10 * 60_000)
    expect(status.current).toContain('13%')

    // The first response sent under B brings B's own figures.
    seen.stepMs.current = 0
    seen.own.current = [{ ...LIMITS[0]!, percentUsed: 14 }, LIMITS[1]!]
    await respond($)
    expect(status.current).toContain('5h ▰▱▱▱▱▱▱▱ 14%')
  })

  test('while a request from before the switch is out, no response brings figures for the new account', { ...OFF, ...LONG }, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    const measure = (percentUsed: number) =>
      $.session.measure({
        context: { window: 1_000_000 },
        rateLimits: [{ ...LIMITS[0]!, percentUsed }, LIMITS[1]!],
        changed: ['rateLimits'],
      } as never)
    login(seen, A)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    seen.stepMs.current = 20_000
    const a = respond($) // a subagent's request under A
    await clock.advance(2_000)
    login(seen, B) // the second claude fails
    await clock.advance(2_000)
    expect(status.current ?? '').not.toContain('41%')

    seen.stepMs.current = 2_000
    seen.own.current = [{ ...LIMITS[0]!, percentUsed: 14 }, LIMITS[1]!]
    const b = respond($) // under B, while A's is out
    await clock.advance(2_000)
    await b
    await measure(41) // A's headers come in after it
    expect(status.current ?? '').not.toContain('41%')
    await clock.advance(14_000)
    await a
    expect(status.current ?? '').not.toContain('41%')

    // A request from before the switch comes back while a new one is out.
    seen.stepMs.current = 10_000
    const c = respond($) // under B
    await clock.advance(2_000)
    login(seen, A)
    await clock.advance(2_000)
    seen.stepMs.current = 20_000
    const d = respond($) // under A again
    await clock.advance(6_000)
    await c
    seen.own.current = [{ ...LIMITS[0]!, percentUsed: 14 }, LIMITS[1]!] // c's headers: B's
    await clock.advance(14_000)
    await d
    expect(status.current ?? '').not.toContain('14%')

    seen.stepMs.current = 0
    seen.own.current = [{ ...LIMITS[0]!, percentUsed: 42 }, LIMITS[1]!]
    await respond($) // nothing from before the switch is out any more
    expect(status.current).toContain('42%')
  })

  test('a response after a switch ends the retries for the new account', OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    login(seen, B) // the second claude fails
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(1)
    seen.own.current = [{ ...LIMITS[0]!, percentUsed: 14 }, LIMITS[1]!]
    await respond($)
    expect(status.current).toContain('14%')
    await clock.advance(2 * 60 * 60_000)
    expect(fetches(seen)).toHaveLength(1) // reading is off: no more readings
  })

  test('a step without a response after a switch keeps the old figures away', OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    login(seen, B) // the second claude fails
    await clock.advance(2_000)
    seen.stop.current = null
    await respond($)
    expect(status.current).toBeUndefined()
  })

  test('the old figures go at once, before the new account is read', OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    seen.runMs.current = 3_000
    seen.server.current = meter(12, 34)
    login(seen, B)
    await clock.advance(2_000)
    expect(seen.statusDuringRun).toEqual([undefined])
    await clock.advance(3_000)
    expect(status.current).toContain('12%')
  })

  test('a switch seen only after an idle reading is drawn at once', async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    seen.server.current = meter(50, 70)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(1_000)
    expect(status.current).toContain('50%')
    // The next idle reading: the account changes while the second claude runs.
    seen.during.current = () => {
      seen.during.current = undefined
      login(seen, B)
      seen.server.current = undefined // and B's reading fails
    }
    await clock.advance(5 * 60_000)
    expect(fetches(seen)).toHaveLength(2)
    expect(status.current).toBeUndefined()
  })

  test("the old account's server reading is never shown for the new one", async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    seen.server.current = meter(50, 70)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(1_000)
    expect(status.current).toContain('50%')
    seen.server.current = undefined
    login(seen, B)
    await clock.advance(2_000)
    expect(status.current).toBeUndefined() // at once, while the next reading waits its 10 s
    await clock.advance(10_000)
    expect(fetches(seen)).toHaveLength(2)
    expect(status.current).toBeUndefined()
  })

  test("a response after an idle reading is drawn at once", async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    seen.server.current = meter(50, 70)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(1_000)
    expect(status.current).toContain('50%')
    await clock.advance(2 * 60_000)
    // As the engine does it: the measure while the response comes in, then the step's end.
    seen.own.current = [{ ...LIMITS[0]!, percentUsed: 53 }, LIMITS[1]!]
    await $.session.measure({ context: { window: 1_000_000 }, rateLimits: seen.own.current, changed: ['rateLimits'] } as never)
    await respond($)
    expect(status.current).toContain('53%')
  })

  test('a failed reading for a new account is tried again within a minute, also with off', { ...OFF, ...LONG }, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    seen.server.current = 'unreached' // 429 with nothing cached
    login(seen, B)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(1)
    seen.server.current = meter(12, 34)
    await clock.advance(32_000)
    expect(fetches(seen)).toHaveLength(2)
    expect(status.current).toContain('12%')
    await clock.advance(30 * 60_000)
    expect(fetches(seen)).toHaveLength(2) // off: then nothing more
  })

  test('a switch during the hour-long wait after a login without rate limits is read at once', LONG, async ($, on) => {
    const { clock, seen } = world(on, [], { HOME })
    login(seen, A)
    seen.server.current = null
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(1_000)
    expect(fetches(seen)).toHaveLength(1)
    await clock.advance(10 * 60_000)
    seen.server.current = meter(12, 34)
    login(seen, B)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(2)
    expect(status.current).toContain('12%')
  })

  test('failures back off 5, then 10 minutes', LONG, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A) // the second claude fails
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(1_000)
    expect(fetches(seen)).toHaveLength(1)
    await clock.advance(5 * 60_000 + 2_000)
    expect(fetches(seen)).toHaveLength(2)
    await clock.advance(9 * 60_000)
    expect(fetches(seen)).toHaveLength(2)
    await clock.advance(62_000)
    expect(fetches(seen)).toHaveLength(3)
  })

  test('reading 15: idle, every 15 minutes', { options: { reading: '15' }, ...LONG }, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    login(seen, A)
    seen.server.current = meter(50, 70)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(1_000)
    expect(fetches(seen)).toHaveLength(1)
    await clock.advance(14 * 60_000)
    expect(fetches(seen)).toHaveLength(1)
    await clock.advance(62_000)
    expect(fetches(seen)).toHaveLength(2)
  })

  test('nothing is read where nothing draws (-p, the SDK)', LONG, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    seen.surfaces.current = []
    login(seen, A)
    seen.server.current = meter(50, 70)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(10 * 60_000)
    expect(fetches(seen)).toHaveLength(0)
  })

  test('CLAUDE_CONFIG_DIR holds the account file', OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME, CLAUDE_CONFIG_DIR: '/cfg' })
    login(seen, A, undefined, '/cfg/.claude.json')
    login(seen, B) // ~/.claude.json is not the engine's here
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    seen.server.current = meter(12, 34)
    login(seen, A) // nothing changes for the session
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(0)
    login(seen, B, undefined, '/cfg/.claude.json')
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(1)
    expect(status.current).toContain('12%')
  })

  test('an older install keeps the account in ~/.claude/.config.json, which the engine goes by', OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    const LEGACY = `${HOME}/.claude/.config.json`
    login(seen, A, undefined, LEGACY)
    login(seen, B) // ~/.claude.json is not the engine's here
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    seen.server.current = meter(12, 34)
    login(seen, A)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(0)
    login(seen, B, undefined, LEGACY)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(1)
    expect(status.current).toContain('12%')
  })

  test('an empty ~/.claude/.config.json beside ~/.claude.json is not the engine\'s', OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME })
    seen.files.set(`${HOME}/.claude/.config.json`, { text: '', mtimeMs: 1 })
    login(seen, A)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    seen.server.current = meter(12, 34)
    login(seen, B)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(1)
  })

  test('with a custom OAuth URL the account is in ~/.claude-custom-oauth.json', OFF, async ($, on) => {
    const { clock, seen } = world(on, LIMITS, { HOME, CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://login.example.com' })
    const CUSTOM = `${HOME}/.claude-custom-oauth.json`
    login(seen, A, undefined, CUSTOM)
    login(seen, B)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    seen.server.current = meter(12, 34)
    login(seen, A)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(0)
    login(seen, B, undefined, CUSTOM)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(1)
  })

  test('on Windows the account file is in USERPROFILE, also where a shell sets HOME', OFF, async ($, on) => {
    const PROFILE = '/c/Users/u' // as the kit spells paths; the engine takes C:\Users\u as given
    const { clock, seen } = world(on, LIMITS, { HOME: '/home/u', USERPROFILE: PROFILE, OS: 'Windows_NT' })
    login(seen, A, undefined, `${PROFILE}/.claude.json`)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2_000)
    seen.server.current = meter(12, 34)
    login(seen, B, undefined, `${PROFILE}/.claude.json`)
    await clock.advance(2_000)
    expect(fetches(seen)).toHaveLength(1)
    expect(status.current).toContain('12%')
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
