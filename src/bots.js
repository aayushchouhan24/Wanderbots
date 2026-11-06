// Bot lifecycle: connect, reconnect, go to places, roam. Each bot has its own server.
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import { S, serverKey } from './store.js'
import { detect, text, servers } from './version.js'
import { think, rnd } from './brain.js'

const { pathfinder, Movements, goals } = pf
export const live = new Map() // bot id -> runtime state
const cfgOf = id => S.bots.find(b => b.id === id)
export const placeOf = id => S.places.find(p => p.id === id)

export function start(id) {
  if (live.has(id) || !cfgOf(id)) return
  const st = { task: 'connecting', err: '', joined: 0, home: null, eating: false }
  live.set(id, st)

  const run = async () => {
    const cfg = cfgOf(id)
    if (st.stop || !cfg) return
    let version
    try { version = await detect(cfg.host, cfg.port, cfg.version) } catch (e) {
      st.err = 'cannot reach server: ' + (e.message || e.code || 'no reply'); st.task = 'offline'; st.timer = setTimeout(run, 15000); return
    }
    st.version = version
    const b = mineflayer.createBot({ host: cfg.host, port: cfg.port, username: cfg.name, version, auth: 'offline', viewDistance: S.set.view, hideErrors: true })
    st.bot = b; st.task = 'joining'
    b.loadPlugin(pathfinder)
    let brain

    b.once('spawn', () => {
      st.joined = Date.now(); st.err = ''
      st.moves = () => {
        const m = new Movements(b)
        m.canDig = false; m.allow1by1towers = false; m.allowSprinting = S.set.sprint // never breaks or builds
        b.pathfinder.setMovements(m)
      }
      st.roam = () => { st.home = null; st.task = 'roaming'; b.pathfinder.stop() }
      st.goto = p => { st.home = { ...p, label: p.name }; st.task = 'going → ' + p.name; b.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 1)) }
      st.moves()
      const p = placeOf(cfgOf(id)?.at)
      p ? st.goto(p) : st.roam()
      const loop = () => { think(b, st).catch(() => {}); brain = setTimeout(loop, rnd(700, 1800)) }
      loop()
    })
    b.on('path_update', r => { if (r.status === 'noPath' && st.task.startsWith('going')) st.task = 'stuck: ' + st.home?.label })
    b.on('death', () => { b.pathfinder?.stop(); if (st.home) setTimeout(() => st.goto?.(st.home), 3000) })
    b.on('kicked', r => { st.err = 'kicked: ' + text(r).slice(0, 200); console.log(`[${cfg.name}@${cfg.host}] kicked:`, text(r)) })
    b.on('error', e => { st.err = e.message })
    b.on('end', () => {
      clearTimeout(brain); st.bot = null; st.joined = 0; st.task = 'reconnecting'; st.roam = st.goto = st.moves = null
      if (!st.stop) st.timer = setTimeout(run, Math.max(5, S.set.reconnect) * 1000)
    })
  }
  run()
}

export function stop(id) {
  const st = live.get(id); if (!st) return
  st.stop = true; clearTimeout(st.timer); st.bot?.quit(); live.delete(id)
}

export const restart = id => { stop(id); start(id) }
export const restartAll = () => S.bots.forEach(b => restart(b.id))

export function stats() {
  return {
    places: S.places, set: S.set,
    mem: Math.round(process.memoryUsage().rss / 1048576),
    bots: S.bots.map(c => {
      const st = live.get(c.id) || {}, b = st.bot, e = b?.entity, srv = servers.get(serverKey(c.host, c.port)) || {}
      return {
        id: c.id, name: c.name, host: c.host, port: c.port, version: c.version, at: c.at,
        using: st.version, server: srv.server, motd: srv.motd, online: srv.online, max: srv.max,
        task: st.task, err: st.err, up: st.joined ? Math.round((Date.now() - st.joined) / 1000) : 0,
        hp: b?.health, food: b?.food, ping: b?.player?.ping, dim: b?.game?.dimension,
        pos: e ? [e.position.x, e.position.y, e.position.z].map(Math.round) : null,
      }
    }),
  }
}
