// Per-bot "agent" object that Mindcraft's skills and modes expect:
// an action manager (one action at a time, interruptible, with timeouts) and the modes loop.
// Action manager adapted from Mindcraft (https://github.com/mindcraft-bots/mindcraft), src/agent/action_manager.js
// Copyright (c) 2024 Kolby Nottingham. MIT License, see src/mc/LICENSE-mindcraft.
import { initModes } from './modes.js'

// Mindcraft's default survival modes (cowardice off, cheat off)
export const DEFAULT_MODES = {
  self_preservation: true, unstuck: true, cowardice: false, self_defense: true, hunting: true,
  item_collecting: true, torch_placing: true, elbow_room: true, idle_staring: true, cheat: false,
}

class ActionManager {
  constructor(agent) {
    this.agent = agent
    this.executing = false
    this.currentActionLabel = ''
    this.timedout = false
    this.resume_func = null
  }

  async stop() {
    if (!this.executing) return
    const until = Date.now() + 10e3
    while (this.executing && Date.now() < until) {
      this.agent.requestInterrupt()
      await new Promise(r => setTimeout(r, 300))
    }
  }

  cancelResume() { this.resume_func = null }

  // run one action; returns { success, message, interrupted, timedout }
  async runAction(label, fn, { timeout = 5 } = {}) { // timeout in minutes
    await this.stop()
    this.agent.clearBotLogs()
    this.executing = true
    this.currentActionLabel = label
    this.timedout = false
    const timer = timeout > 0 ? setTimeout(() => { this.timedout = true; this.agent.requestInterrupt() }, timeout * 60e3) : null
    try {
      await fn()
      return this.finish(true)
    } catch (err) {
      const r = this.finish(false)
      r.message = (r.message ? r.message + '\n' : '') + 'Error: ' + String(err?.message || err).slice(0, 300)
      return r
    } finally { clearTimeout(timer) }
  }

  finish(success) {
    const bot = this.agent.bot
    const interrupted = bot.interrupt_code, timedout = this.timedout
    let out = bot.output || ''
    if (out.length > 600) out = out.slice(0, 250) + '\n...\n' + out.slice(-300)
    this.executing = false
    this.currentActionLabel = ''
    this.agent.clearBotLogs()
    if (!interrupted) bot.emit('idle')
    return { success, message: out.trim(), interrupted, timedout }
  }
}

export class McAgent {
  constructor(bot, { narrate, onInterrupted, modes } = {}) {
    this.bot = bot
    this.narrate = narrate
    this.onInterrupted = onInterrupted
    bot.output = ''
    bot.interrupt_code = false
    this.actions = new ActionManager(this)
    initModes(this, { ...DEFAULT_MODES, ...modes })
    // modes loop, one update at a time every 300 ms (like Mindcraft)
    this.running = true
    const loop = async () => {
      while (this.running) {
        const t = Date.now()
        if (bot.entity) await bot.modes.update().catch(() => {})
        await new Promise(r => setTimeout(r, Math.max(0, 300 - (Date.now() - t))))
      }
    }
    loop()
    bot.once('end', () => { this.running = false })
  }

  isIdle() { return !this.actions.executing }

  requestInterrupt() {
    const bot = this.bot
    bot.interrupt_code = true
    try { bot.stopDigging() } catch {}
    try { bot.collectBlock?.cancelTask() } catch {}
    try { bot.pathfinder.stop() } catch {}
    try { bot.pvp?.stop() } catch {}
  }

  clearBotLogs() { this.bot.output = ''; this.bot.interrupt_code = false }

  stop() { this.running = false; return this.actions.stop() }
}
