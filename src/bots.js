// Bot lifecycle: connect, reconnect, modes, stats. Each bot has its own server.
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import { S, save, serverKey } from './store.js'
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
    const b = mineflayer.createBot({ ...conn, username: cfg.name, version, auth: 'offline', viewDistance: S.set.view, hideErrors: true })
    st.bot = b; st.task = 'joining'; st.busy = false
    tickEnd(b, version)
    b.loadPlugin(pathfinder)
    attachChat(b, st, cfg, { setMode: p => setMode(id, p) })
    let brain

    b.once('spawn', () => {
      st.joined = Date.now(); st.err = ''
      log(st, 'event', `joined ${cfg.host}${st.via ? ' (via ViaProxy)' : ''} as ${version}`)
      st.moves = () => {
        const m = new Movements(b)
        m.canDig = false; m.allow1by1towers = false; m.allowSprinting = S.set.sprint // never breaks or builds
        b.pathfinder.setMovements(m)
      }
      st.moves()
      const loop = () => { const c = cfgOf(id); if (c) think(b, st, c).catch(() => { st.busy = false }); brain = setTimeout(loop, rnd(600, 1500)) }
      loop()
    })
    b.on('death', () => { b.pathfinder?.stop(); st.busy = false })
    b.on('wake', () => { st.task = 'woke up' })
    b.on('kicked', r => { st.err = 'kicked: ' + text(r).slice(0, 200); log(st, 'event', st.err); console.log(`[${cfg.name}@${cfg.host}] kicked:`, text(r)) })
    b.on('error', e => { st.err = e.message })
    b.on('end', () => {
      clearTimeout(brain); st.bot = null; st.joined = 0; st.task = 'reconnecting'; st.moves = null
      if (!st.stop) { log(st, 'event', 'disconnected, retrying'); st.timer = setTimeout(run, Math.max(5, S.set.reconnect) * 1000) }
    })
  }
  run()
}

export function stop(id) {
  const st = live.get(id); if (!st) return
  st.stop = true; clearTimeout(st.timer); st.bot?.quit(); live.delete(id)
}

export const restart = id => { stop(id); start(id) }
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
        inv: b ? b.inventory.items().map(i => ({ n: i.displayName || i.name, c: i.count })) : [],
        hand: b?.heldItem?.displayName,
        log: st.log || [],
      }
    }),
  }
}
