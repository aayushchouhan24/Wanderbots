// Bot lifecycle: connect, reconnect, modes, stats. Each bot has its own server.
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import { S, save, serverKey, eff } from './store.js'
import { detect, text, servers } from './version.js'
import { think, rnd, homeOf } from './brain.js'
import { attachChat, log, say } from './chat.js'
import { tickEnd } from './fixes.js'
import * as via from './viaproxy.js'
import { initMcData } from './mc/mcdata.js'
import { stopAI, inbox } from './aiplay.js'
import { fightPlayer, watchAttackers } from './combat.js'
import { watchGifts, watchApproach } from './social.js'
import { upgradeGear, canUpgrade, VALUABLE } from './gear.js'
import { attachStorageMemory, memorySummary, extraValuables } from './storage.js'
import { watchLoops } from './antiloop.js'
import * as skills from './mc/skills.js'

const GREET = ['hey {p}, need something?', "yo {p}, what's up?", 'hi {p}! need anything?', 'oh hey {p}']
const THANKS = ['thanks {p}!', 'ty {p} :)', 'oh nice, thanks {p}!']
const pick = a => a[Math.floor(Math.random() * a.length)]
const MAKES_ITEMS = /collect|craft|smelt|take|clearFurnace|workOnBase|routine|buildHouse|attack|discard|item_collecting|hunting|pickup|recover|fightBack/i

const { pathfinder, Movements } = pf
export const live = new Map() // bot id -> runtime state
const cfgOf = id => S.bots.find(b => b.id === id)
export const placeOf = id => S.places.find(p => p.id === id)

// change what a bot is doing: { mode, at?, spot?, follow? } — saved, applied on the next think
export function setMode(id, patch) {
  const cfg = cfgOf(id); if (!cfg) return
  if ('at' in patch) delete cfg.spot
  if ('spot' in patch) delete cfg.at
  Object.assign(cfg, patch)
  for (const k of ['at', 'spot', 'follow']) if (cfg[k] == null) delete cfg[k]
  save()
  const st = live.get(id)
  if (st?.bot?.pathfinder) { if (cfg.mode !== 'ai') stopAI(st); st.bot.pathfinder.stop(); st.following = null; st.busy = false; log(st, 'event', 'mode → ' + cfg.mode) }
}

export function start(id) {
  const c0 = cfgOf(id)
  if (live.has(id) || !c0 || c0.paused) return
  const st = { task: 'connecting', err: '', joined: 0, log: [] }
  // lifetime stats live in the bot's saved config; saved at most once a minute
  st.logTrim = setInterval(() => { if (st.log.length > 80) st.log.splice(0, st.log.length - 60); if (st.aiInbox?.length > 10) st.aiInbox.splice(0, st.aiInbox.length - 10) }, 5000)
  st.count = (k, n = 1) => { const c = cfgOf(id); if (!c) return; c.stats ||= {}; c.stats[k] = (c.stats[k] || 0) + n; dirty = true }
  live.set(id, st)

  const run = async () => {
    const cfg = cfgOf(id)
    if (st.stop || !cfg) return
    let version
    try { version = await detect(cfg.host, cfg.port, cfg.version) } catch (e) {
      st.err = 'cannot reach server: ' + (e.message || e.code || 'no reply'); st.task = 'offline'; st.timer = setTimeout(run, 15000); return
    }
    st.version = version
    // server newer than mineflayer supports -> go through the local ViaProxy
    const srv = servers.get(serverKey(cfg.host, cfg.port))
    let conn = { host: cfg.host, port: cfg.port }
    st.via = false
    if (srv?.unsupported && cfg.version === 'auto') {
      try { await via.ensure() } catch (e) {
        st.task = 'unsupported'; st.err = `server runs ${srv.server}, newest direct version is ${srv.newest}, and ViaProxy failed: ${e.message}`
        st.timer = setTimeout(run, 60000); return
      }
      if (st.stop) return
      conn = { host: via.VIA.host, port: via.VIA.port, fakeHost: via.route(cfg.host, cfg.port, srv.target) }
      st.via = true
    }
    const b = mineflayer.createBot({ ...conn, username: cfg.name, version, auth: 'offline', viewDistance: cfg.mode === 'ai' && eff(cfg).view === 'tiny' ? 'short' : eff(cfg).view, hideErrors: true })
    st.bot = b; st.task = 'joining'; st.busy = false
    tickEnd(b, version)
    b.loadPlugin(pathfinder)
    initMcData(b) // pvp, collectblock, armor manager + game data for Mindcraft's skills
    // Mindcraft's skills expect these even outside AI mode (AI mode replaces bot.modes with the real modes)
    b.output = ''; b.interrupt_code = false
    b._wbCfg = () => cfgOf(id); b._wbState = st
    b.modes = { isOn: () => false, setOn() {}, pause() {}, unpause() {}, exists: () => false, getDocs: () => '', getMiniDocs: () => '', flushBehaviorLog: () => '', behavior_log: '' }
    attachChat(b, st, cfg, { setMode: p => setMode(id, p) })
    let brain

    b.once('spawn', () => {
      st.joined = Date.now(); st.err = ''; st.count('joins')
      // on-join commands, e.g. "/login mypassword" on AuthMe servers (one per line)
      const lines = String(cfgOf(id)?.onJoin || '').split('\n').map(l => l.trim()).filter(Boolean)
      lines.forEach((l, i) => setTimeout(() => { if (st.bot === b) { b.chat(l); log(st, 'me', l.startsWith('/') ? l.split(' ')[0] + ' …' : l) } }, 1500 + i * 2500))
      // timed auto-message
      const am = cfgOf(id)?.autoMsg
      if (am?.text && am.mins >= 1) st.autoTimer = setInterval(() => { st.count('msgs'); say(b, st, am.text) }, am.mins * 60e3)
      log(st, 'event', `joined ${cfg.host}${st.via ? ' (via ViaProxy)' : ''} as ${version}`)
      st.moves = () => {
        const m = new Movements(b)
        m.canDig = false; m.allow1by1towers = false; m.allowSprinting = eff(cfgOf(id)).sprint // never breaks or builds
        b.pathfinder.setMovements(m)
      }
      st.moves()
      if (!st.watching) attachWatchers(b, st, id)
      const loop = () => { const c = cfgOf(id); if (c) think(b, st, c).catch(() => { st.busy = false }); brain = setTimeout(loop, rnd(600, 1500)) }
      loop()
    })
    b.on('death', () => {
      b.pathfinder?.stop(); st.busy = false; st.recovering = false; st.count('deaths')
      // remember where it died (saved, so it survives a restart) to go back for the items
      const p = b.entity?.position, c = cfgOf(id)
      if (p && c) { c.lastDeath = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), dim: b.game?.dimension, t: Date.now() }; save(); log(st, 'event', `died at ${c.lastDeath.x} ${c.lastDeath.y} ${c.lastDeath.z}`) }
    })
    b.on('entityDead', en => { if (en.id === st.target) st.count('kills') })
    b.on('playerCollect', (who, item) => { if (who === b.entity) st.count('picked') })
    b.on('wake', () => { st.task = 'woke up' })
    b.on('kicked', r => { st.err = 'kicked: ' + text(r).slice(0, 200); log(st, 'event', st.err); console.log(`[${cfg.name}@${cfg.host}] kicked:`, text(r)) })
    b.on('error', e => { st.err = e.message })
    b.on('end', () => {
      clearTimeout(brain); clearInterval(st.autoTimer); if (st.joined) st.count('online', Math.round((Date.now() - st.joined) / 1000)); st.bot = null; st.joined = 0; st.task = 'reconnecting'; st.moves = null
      if (!st.stop) { log(st, 'event', 'disconnected, retrying'); st.timer = setTimeout(run, Math.max(5, eff(cfgOf(id) || cfg).reconnect) * 1000) }
    })
  }
  run()
}

// fighting back, gifts and greetings (once per connection)
function attachWatchers(b, st, id) {
  st.watching = true
  try { attachStorageMemory(b, () => cfgOf(id)) } catch (e) { log(st, 'event', 'storage memory unavailable: ' + e.message) } // remember every container it opens
  try {
    watchLoops(b, st, spot => { // stuck placing/breaking the same block
      log(st, 'event', `stuck placing/breaking the same block at ${spot}: walking only (no pillaring/digging) for 2 minutes`)
      st.busy = false
      if (st.ai?.agent) { st.ai.agent.requestInterrupt(); inbox(st, `You got stuck placing and breaking the same block at ${spot}, so that path doesn't work. For 2 minutes you can only walk (no pillaring or digging): pick a different route or a different target.`) }
    })
  } catch (e) { log(st, 'event', 'loop watch unavailable: ' + e.message) }
  b.once('end', () => { st.watching = false })
  const cfgNow = () => cfgOf(id)
  watchAttackers(b, st, () => cfgNow() && eff(cfgNow()), name => {
    log(st, 'event', `${name} took me to half health, fighting back`)
    if (st.ai?.agent) {
      inbox(st, `${name} attacked you and brought you to half health. You are fighting back automatically.`)
      st.ai.agent.actions.runAction('action:fightBack', async () => { skills.log(b, await fightPlayer(b, name, () => b.interrupt_code)) }, { timeout: 2 })
        .then(r => { inbox(st, `Fight with ${name}: ${r.message || 'over'}.`); st.revenge = null })
    } else { b.pathfinder.stop(); st.busy = false } // brain.js picks up st.revenge
  })
  const giftBusy = () => {
    const ag = st.ai?.agent
    if ((ag && !ag.isIdle()) || st.busy) st.lastActive = Date.now()
    const last = Math.max(st.lastActive || 0, ag?.actions.lastActive || 0)
    return Date.now() - last < 6000 // anything it did in the last 6 s may have added items
  }
  watchGifts(b, giftBusy, (from, item, n, how) => {
    const giver = from || Object.values(b.players).map(p => p.entity).filter(e => e && e !== b.entity && e.position.distanceTo(b.entity.position) < 16)[0]?.username
    if (!from && !giver) return // nobody around: not a gift
    if (VALUABLE.test(item) || /^(diamond|iron|netherite)_(sword|pickaxe|axe|shovel|helmet|chestplate|leggings|boots)$/.test(item)) {
      clearTimeout(st.gearTimer) // several stacks arrive at once: upgrade once, a moment later
      st.gearTimer = setTimeout(() => {
        if (st.gearRunning || Date.now() - (st.gearAt || 0) < 120e3) return
        if (!canUpgrade(b) && !/_(sword|pickaxe|axe|shovel|helmet|chestplate|leggings|boots)$/.test(item)) return
        st.gearAt = Date.now()
        if (st.ai?.agent) { st.gearRunning = true; st.ai.agent.actions.runAction('action:upgradeGear', () => upgradeGear(b), { timeout: 5 }).then(r => { st.gearRunning = false; inbox(st, 'You upgraded your gear with the gift: ' + (r.message || 'done')) }) }
        else st.gearUpgrade = true
      }, 3000)
    }
    if (/^(dirt|grass_block|short_grass|tall_grass|fern|large_fern|vine|.*_seeds|.*_sapling|.*_flower|dandelion|poppy|bush|firefly_bush|leaf_litter|.*_leaves|stick|cobblestone|gravel|sand|rotten_flesh|bone|string|feather|egg|brown_egg|bamboo|kelp|seagrass)$/.test(item)) return // junk: not worth a thank-you
    st.gifts ||= {}
    const key = giver || '?', g = st.gifts[key] ||= { items: {}, t: 0, timer: null }
    g.items[item] = (g.items[item] || 0) + n
    if (g.timer || Date.now() - g.t < 300e3) { if (!g.timer) g.timer = setTimeout(() => { g.timer = null }, 300e3 - (Date.now() - g.t)); return } // already told about this giver recently
    g.timer = setTimeout(() => {
      g.timer = null; g.t = Date.now()
      const list = Object.entries(g.items).map(([k, v]) => `${v} ${k}`).join(', '); g.items = {}
      const text2 = `${giver || 'someone'} gave you ${list}`
      log(st, 'event', text2)
      if (st.ai) inbox(st, `Gift: ${text2}. Thank them ONCE in chat, then use it if it helps (equip better armor/tools, eat good food). Don't mention it again.`)
      else if (giver) say(b, st, pick(THANKS).replace('{p}', giver))
    }, 4000) // wait a moment so several stacks become one gift
    return
  })
  watchApproach(b, (name, d) => {
    const cfg = cfgNow(); if (!cfg) return
    if (st.ai) inbox(st, `${name} walked up to you (${d} m away). If it fits, greet them briefly or ask what they need. Don't repeat greetings.`)
    else if (eff(cfg).replies) say(b, st, pick(GREET).replace('{p}', name))
  })
}

export function stop(id) {
  const st = live.get(id); if (!st) return
  st.stop = true; clearTimeout(st.timer); clearInterval(st.logTrim); st.bot?.quit(); live.delete(id)
}

export const restart = id => { stop(id); start(id) }

let dirty = false
setInterval(() => { if (dirty) { dirty = false; save() } }, 60e3).unref()

// inventory actions from the panel: hold / drop one stack / drop everything
export async function invAction(id, action, slot) {
  const b = live.get(id)?.bot; if (!b?.entity) return 'bot is not in the world'
  const item = b.inventory.slots[+slot]
  if (action === 'dropall') { for (const i of b.inventory.items()) await b.tossStack(i).catch(() => {}); return }
  if (!item) return 'that slot is empty'
  if (action === 'hold') return b.equip(item, 'hand').then(() => {}, e => e.message)
  if (action === 'drop') return b.tossStack(item).then(() => {}, e => e.message)
  return 'unknown action'
}
export function chat(id, msg) { const st = live.get(id); if (!st?.bot?.entity) return false; say(st.bot, st, msg); return true }

export function stats() {
  return {
    places: S.places, set: S.set,
    mem: Math.round(process.memoryUsage().rss / 1048576),
    bots: S.bots.map(c => {
      const st = live.get(c.id) || {}, b = st.bot, e = b?.entity, srv = servers.get(serverKey(c.host, c.port)) || {}
      const home = homeOf(c), players = b ? Object.keys(b.players).filter(n => n !== b.username) : []
      return {
        id: c.id, name: c.name, host: c.host, port: c.port, version: c.version,
        mode: c.mode || 'roam', at: c.at, spot: c.spot, follow: c.follow, paused: !!c.paused, home: home?.label,
        using: st.version, via: st.via, server: srv.server, motd: srv.motd, online: srv.online, max: srv.max,
        task: c.paused ? 'paused' : st.task, err: st.err, up: st.joined ? Math.round((Date.now() - st.joined) / 1000) : 0,
        hp: b?.health, food: b?.food, ping: b?.player?.ping, dim: b?.game?.dimension, xp: b?.experience?.level,
        day: b?.time ? (b.time.isDay ? 'day' : 'night') : null,
        pos: e ? [e.position.x, e.position.y, e.position.z].map(Math.round) : null,
        players, nearby: b ? players.filter(n => b.players[n]?.entity && b.players[n].entity.position.distanceTo(e.position) < 32) : [],
        inv: b ? b.inventory.items().map(i => ({ n: i.displayName || i.name, c: i.count, s: i.slot })) : [],
        stats: { ...(c.stats || {}), online: (c.stats?.online || 0) + (st.joined ? Math.round((Date.now() - st.joined) / 1000) : 0) },
        build: c.build ? { schem: c.build.schem, state: c.build.state, placed: c.build.placed || 0, remaining: c.build.remaining, mode: c.build.mode, origin: c.build.origin, missing: c.build.missing || {} } : null,
        memory: b?.entity ? memorySummary(b, c) : [], carrying: b?.entity ? extraValuables(b) : {}, freeSlots: b?.entity ? b.inventory.emptySlotCount() : null,
        aiNotes: st.aiNotes || '', aiHistory: (st.aiHistory || []).slice(-8), aiPaused: st.aiPaused || '',
        own: c.set || {}, onJoin: c.onJoin || '', autoMsg: c.autoMsg || null,
        spawnBed: c.spawnBed || null, lastDeath: c.lastDeath ? { ...c.lastDeath, ago: Math.round((Date.now() - c.lastDeath.t) / 1000) } : null,
        worldSpawn: b?.spawnPoint ? [b.spawnPoint.x, b.spawnPoint.y, b.spawnPoint.z] : null,
        hand: b?.heldItem?.displayName,
        log: st.log || [],
      }
    }),
  }
}
