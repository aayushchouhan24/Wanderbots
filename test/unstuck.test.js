import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test, mock } from 'node:test'

let moveAway
mock.module('../src/mc/skills.js', { namedExports: { moveAway: (...args) => moveAway(...args) } })
mock.module('../src/mc/world.js', { namedExports: {} })
mock.module('../src/mc/mcdata.js', { namedExports: {} })
const { McAgent, DEFAULT_MODES } = await import('../src/mc/agent.js')
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bot = new EventEmitter()
  bot.pathfinder = { stop: t.mock.fn() }
  bot.quit = t.mock.fn(() => bot.emit('end'))
  const narrate = t.mock.fn()
  const agent = new McAgent(bot, {
    narrate, modes: Object.fromEntries(Object.keys(DEFAULT_MODES).map(k => [k, false])),
  })
  bot.entity = { position: { clone() { return this }, distanceTo() { return 0 } } }
  agent.isIdle = () => false
  const mode = bot.modes.map.unstuck
  mode.prev_location = bot.entity.position
  mode.stuck_time = 21
  t.after(() => { agent.running = false; bot.emit('end') })
  return { bot, agent, mode, narrate }
}

test('hung recovery disconnects only its bot once after ten seconds', async t => {
  const { bot, agent, mode } = setup(t)
  moveAway = () => new Promise(() => {})
  await mode.update(agent)
  await flush()
  t.mock.timers.tick(9999)
  assert.equal(bot.quit.mock.callCount(), 0)
  t.mock.timers.tick(1)
  assert.equal(bot.quit.mock.callCount(), 1)
  assert.equal(bot.quit.mock.calls[0].arguments[0], "Got stuck and couldn't get unstuck")
  assert.equal(agent.running, false)
  assert.equal(bot.interrupt_code, true)
  agent.cleanKill('again')
  assert.equal(bot.quit.mock.callCount(), 1)
})

for (const outcome of ['success', 'failure', 'disconnect']) {
  test(`${outcome} clears the recovery watchdog`, async t => {
    const { bot, agent, mode, narrate } = setup(t)
    moveAway = () => outcome === 'disconnect' ? new Promise(() => {})
      : outcome === 'failure' ? Promise.reject(new Error('no path')) : Promise.resolve(true)
    const endListeners = bot.listenerCount('end')
    await mode.update(agent)
    await flush()
    if (outcome === 'disconnect') bot.emit('end')
    else assert.equal(bot.listenerCount('end'), endListeners)
    t.mock.timers.tick(10001)
    await flush()
    assert.equal(bot.quit.mock.callCount(), 0)
    assert.equal(narrate.mock.calls.some(c => c.arguments[0] === "I'm free."), outcome === 'success')
    if (outcome !== 'disconnect') assert.equal(mode.active, false)
  })
}
