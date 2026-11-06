// Bot lifecycle: connect, reconnect, modes, stats. Each bot has its own server.
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import { S, save, serverKey, eff } from './store.js'
import { detect, text, servers } from './version.js'
import { think, rnd, homeOf } from './brain.js'
import { attachChat, log, say } from './chat.js'
import { tickEnd } from './fixes.js'
import * as via from './viaproxy.js'

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
  if (st?.bot?.pathfinder) { st.bot.pathfinder.stop(); st.following = null; st.busy = false; log(st, 'event', 'mode → ' + cfg.mode) }
}

export function start(id) {
  const c0 = cfgOf(id)
  if (live.has(id) || !c0 || c0.paused) return
  const st = { task: 'connecting', err: '', joined: 0, log: [] }
  // lifetime stats live in the bot's saved config; saved at most once a minute
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

export function stop(id) {
  const st = live.get(id); if (!st) return
  st.stop = true; clearTimeout(st.timer); st.bot?.quit(); live.delete(id)
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
