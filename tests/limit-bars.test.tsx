import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// 2026-10-08 11:43 Europe/Berlin
const NOW = Date.parse('2026-10-08T09:43:00.000Z')

const LIMITS = [
  { kind: 'five_hour', percentUsed: 41, resetsAt: '2026-10-08T11:00:00.000Z' },
  { kind: 'seven_day', percentUsed: 63, resetsAt: '2026-10-14T00:00:00.000Z' },
]

function world(on: On, rateLimits = LIMITS) {
  mock.env(on, { TZ: 'Europe/Berlin' })
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits } }) as never)
  on('session.start', () => ({ cwd: '/' }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }) as never)
  return mock.clock(on, { now: NOW })
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

  test('a window past its reset shows 0% until the next figure', async ($, on) => {
    const clock = world(on)
    await $.session.start({ cwd: '/' } as never)
    await clock.advance(2 * 60 * 60 * 1000)
    const ui = await $.ui.mount({ plugin: 'limit-bars', surface: 'terminal', ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /^\s+0% $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /41%/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /63%/ })).toBeDefined()
    await ui.unmount()
  })
})
