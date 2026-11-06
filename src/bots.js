// Bot lifecycle: connect, reconnect, go to places, roam.
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import { S } from './store.js'
import { detect, text, server } from './version.js'
import { think, rnd } from './brain.js'

const { pathfinder, Movements, goals } = pf
export const live = new Map() // name -> runtime state

export function start(name) {
  if (live.has(name)) return
  const st = { task: 'connecting', err: '', joined: 0, home: null, eating: false }
  live.set(name, st)

  const run = async () => {
    if (st.stop) return
    let version
    try { version = await detect() } catch (e) {
      st.err = 'cannot reach server: ' + (e.message || e.code || 'no reply'); st.task = 'offline'; st.timer = setTimeout(run, 15000); return
    }
    const b = mineflayer.createBot({ host: S.host, port: S.port, username: name, version, auth: 'offline', viewDistance: S.set.view, hideErrors: true })
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
      st.goto = (p, label) => { st.home = { ...p, label }; st.task = 'going → ' + label; b.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 1)) }
      st.moves()
      const cfg = S.bots.find(x => x.name === name)
      cfg?.at && S.places[cfg.at] ? st.goto(S.places[cfg.at], cfg.at) : st.roam()
      const loop = () => { think(b, st).catch(() => {}); brain = setTimeout(loop, rnd(700, 1800)) }
      loop()
    })
    b.on('path_update', r => { if (r.status === 'noPath' && st.task.startsWith('going')) st.task = 'stuck: ' + st.home?.label })
    b.on('death', () => { b.pathfinder?.stop(); if (st.home) setTimeout(() => st.goto?.(st.home, st.home.label), 3000) })
    b.on('kicked', r => { st.err = 'kicked: ' + text(r).slice(0, 200); console.log(`[${name}] kicked:`, text(r)) })
    b.on('error', e => { st.err = e.message })
    b.on('end', () => {
      clearTimeout(brain); st.bot = null; st.joined = 0; st.task = 'reconnecting'; st.roam = st.goto = st.moves = null
      if (!st.stop) st.timer = setTimeout(run, Math.max(5, S.set.reconnect) * 1000)
    })
  }
  run()
}

export function stop(name) {
  const st = live.get(name); if (!st) return
  st.stop = true; clearTimeout(st.timer); st.bot?.quit(); live.delete(name)
}

export function restartAll() { for (const n of [...live.keys()]) stop(n); S.bots.forEach(b => start(b.name)) }

export function stats() {
  return {
    server: { host: S.host, port: S.port, ...server.info },
    places: S.places, set: S.set,
    mem: Math.round(process.memoryUsage().rss / 1048576),
    bots: S.bots.map(({ name, at }) => {
      const st = live.get(name) || {}, b = st.bot, e = b?.entity
      return {
        name, at, task: st.task, err: st.err, up: st.joined ? Math.round((Date.now() - st.joined) / 1000) : 0,
        hp: b?.health, food: b?.food, ping: b?.player?.ping, dim: b?.game?.dimension,
        pos: e ? [e.position.x, e.position.y, e.position.z].map(Math.round) : null,
        players: b ? Object.keys(b.players).length : null,
      }
    }),
  }
}
