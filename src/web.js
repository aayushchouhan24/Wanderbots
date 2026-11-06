// Control panel: serves public/index.html and a small JSON API under /api.
import http from 'node:http'
import fs from 'node:fs'
import { S, DEFAULTS, save, newId, serverKey } from './store.js'
import * as auth from './auth.js'
import { start, stop, restart, live, stats, placeOf, setMode, chat } from './bots.js'
import { MODES } from './brain.js'
import { SUPPORTED } from './version.js'

const page = fs.readFileSync(new URL('../public/index.html', import.meta.url))
const validName = n => /^[A-Za-z0-9_]{3,16}$/.test(n)
const validHost = h => /^[A-Za-z0-9.-]{1,253}$/.test(h)
const validPort = p => Number.isInteger(p) && p > 0 && p < 65536
const short = n => String(n || '').trim().slice(0, 32)

// coerce a shared setting to its allowed type/range
function clean(k, v) {
  if (typeof DEFAULTS[k] === 'boolean') return !!v
  if (typeof DEFAULTS[k] === 'number') return Math.max(0, Math.min(64, +v || 0))
  if (k === 'view') return ['tiny', 'short', 'normal'].includes(v) ? v : 'tiny'
  if (k === 'combat') return ['flee', 'fight', 'ignore'].includes(v) ? v : 'flee'
  if (k === 'owners') return String(v || '').split(',').map(s => s.trim()).filter(validName).slice(0, 20).join(', ')
  return DEFAULTS[k]
}

// turn a mode request from the panel into a bot patch; returns error text or the patch
function modePatch(cfg, st, { mode, place, player, here }) {
  if (!MODES.includes(mode)) return 'unknown mode'
  if (mode === 'follow') {
    const name = String(player || '').trim()
    if (!validName(name)) return 'pick a player to follow'
    return { mode, follow: name }
  }
  if (mode === 'stay' || mode === 'guard') {
    if (place) {
      const p = placeOf(place); if (!p) return 'no place'
      if (p.server !== serverKey(cfg.host, cfg.port)) return 'that place is on another server'
      return { mode, at: p.id }
    }
    const pos = st?.bot?.entity?.position
    if (here || !cfg.at) { if (!pos) return 'bot is not in the world'; return { mode, spot: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } } }
    return { mode }
  }
  return { mode }
}

// "play.x.net:25566", "play.x.net", "https://play.x.net:25566/" -> { host, port }
export function parseAddress(a) {
  const s = String(a || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '')
  const m = s.match(/^(.*?)(?::(\d+))?$/)
  return { host: m[1], port: m[2] ? +m[2] : 25565 }
}

// validate { name, address | host+port, version } for a new or edited bot; returns error text or the clean bot fields
function botFields(body, cur = {}) {
  const addr = body.address !== undefined ? parseAddress(body.address)
    : { host: String(body.host ?? cur.host ?? '').trim().toLowerCase(), port: body.port === undefined || body.port === '' ? cur.port ?? 25565 : +body.port }
  const f = { name: body.name ?? cur.name, ...addr, version: body.version ?? cur.version ?? 'auto' }
  if (!validName(f.name)) return 'username: 3-16 letters, numbers or _'
  if (!validHost(f.host)) return 'server address looks wrong'
  if (!validPort(f.port)) return 'port must be 1-65535'
  if (f.version !== 'auto' && !SUPPORTED.includes(f.version)) return 'unsupported version'
  if (S.bots.some(b => b !== cur && b.name === f.name && b.host === f.host && b.port === f.port)) return 'that username is already on this server'
  return f
}

async function readBody(q) {
  let raw = ''
  for await (const c of q) { raw += c; if (raw.length > 1e4) throw new Error('too big') }
  try { return JSON.parse(raw || '{}') } catch { return {} }
}

async function handle(q, body, send) {
  const [, , what, id0, act] = q.url.split('/') // /api/<what>/<id>/<act>
  const id = id0 && decodeURIComponent(id0)
  const ip = String(q.headers['x-forwarded-for'] || q.socket.remoteAddress).split(',')[0].trim()
  const token = String(q.headers['x-token'] || '')

  if (what === 'login') { const r = auth.login(ip, body.key); return send(r.code, r) }
  if (!auth.check(token)) return send(401, { error: 'login' })
  if (what === 'logout') { auth.logout(token); return send(200, {}) }
  if (what === 'key') { const err = auth.changeKey(body.key); return err ? send(400, { error: err }) : send(200, { relogin: true }) }

  if (what === 'state') return send(200, { ...stats(), versions: ['auto', ...SUPPORTED.slice().reverse()] })

  if (what === 'settings') { // shared behaviour for all bots
    const old = { ...S.set }
    for (const k in DEFAULTS) if (k in body) S.set[k] = clean(k, body[k])
    save()
    if (old.view !== S.set.view) S.bots.forEach(b => restart(b.id)) // needs a rejoin
    else for (const st of live.values()) st.moves?.()
    return send(200, {})
  }

  if (what === 'places') {
    if (q.method === 'DELETE') {
      S.places = S.places.filter(p => p.id !== id)
      S.bots.forEach(b => { if (b.at === id) delete b.at })
    } else {
      const name = short(body.name), server = String(body.server || '')
      if (!name) return send(400, { error: 'name needed' })
      if (!S.bots.some(b => serverKey(b.host, b.port) === server)) return send(400, { error: 'pick a server' })
      S.places.push({ id: newId(), name, server, x: +body.x || 0, y: +body.y || 0, z: +body.z || 0 })
    }
    save(); return send(200, {})
  }

  if (what === 'all') { // bulk actions: roam | idle | rejoin | pause | resume | send {place} | chat {text}
    const p = id === 'send' && placeOf(body.place)
    if (id === 'send' && !p) return send(400, { error: 'pick a place' })
    let n = 0
    for (const cfg of S.bots) {
      const st = live.get(cfg.id)
      if (id === 'roam' || id === 'idle') setMode(cfg.id, { mode: id })
      else if (id === 'rejoin') { delete cfg.paused; restart(cfg.id) }
      else if (id === 'pause') { cfg.paused = true; stop(cfg.id) }
      else if (id === 'resume') { delete cfg.paused; start(cfg.id) }
      else if (id === 'send') { if (p.server !== serverKey(cfg.host, cfg.port)) continue; setMode(cfg.id, { mode: 'stay', at: p.id }) }
      else if (id === 'chat') { if (!chat(cfg.id, String(body.text || '').slice(0, 250))) continue }
      else return send(404, { error: 'unknown action' })
      n++
    }
    save(); return send(200, { n })
  }

  if (what === 'bots') {
    if (q.method === 'POST' && !id) {
      const f = botFields(body); if (typeof f === 'string') return send(400, { error: f })
      const bot = { id: newId(), ...f }; S.bots.push(bot); save(); start(bot.id); return send(200, {})
    }
    const cfg = S.bots.find(b => b.id === id), st = live.get(id)
    if (!cfg) return send(404, { error: 'no bot' })
    if (q.method === 'DELETE') { stop(id); S.bots = S.bots.filter(b => b !== cfg); save(); return send(200, {}) }
    if (act === 'edit') { // username / server / port / version -> rejoin
      const f = botFields(body, cfg); if (typeof f === 'string') return send(400, { error: f })
      if (serverKey(f.host, f.port) !== serverKey(cfg.host, cfg.port)) { delete cfg.at; delete cfg.spot; if (cfg.mode === 'stay' || cfg.mode === 'guard') cfg.mode = 'roam' } // places belong to a server
      Object.assign(cfg, f); save(); restart(id); return send(200, {})
    }
    if (act === 'mode') { // { mode, place?, player?, here? }
      const r = modePatch(cfg, st, body); if (typeof r === 'string') return send(400, { error: r })
      setMode(id, r); return send(200, {})
    }
    if (act === 'send') { const r = modePatch(cfg, st, { mode: 'stay', place: body.place }); if (typeof r === 'string') return send(400, { error: r }); setMode(id, r); return send(200, {}) }
    if (act === 'roam') { setMode(id, { mode: 'roam' }); return send(200, {}) }
    if (act === 'chat') {
      const msg = String(body.text || '').trim().slice(0, 250)
      if (!msg) return send(400, { error: 'empty message' })
      return chat(id, msg) ? send(200, {}) : send(400, { error: 'bot is not in the world' })
    }
    if (act === 'pause') { cfg.paused = true; save(); stop(id); return send(200, {}) }
    if (act === 'resume') { delete cfg.paused; save(); start(id); return send(200, {}) }
    if (act === 'restart') { delete cfg.paused; save(); restart(id); return send(200, {}) }
    if (act === 'here') {
      const pos = st?.bot?.entity?.position, name = short(body.name)
      if (!pos) return send(400, { error: 'bot is not in the world' })
      if (!name) return send(400, { error: 'name needed' })
      S.places.push({ id: newId(), name, server: serverKey(cfg.host, cfg.port), x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) })
      save(); return send(200, {})
    }
  }
  send(404, { error: 'not found' })
}

export function startWeb(port) {
  http.createServer(async (q, r) => {
    const send = (code, o) => { r.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); r.end(JSON.stringify(o)) }
    if (q.url === '/') { r.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' }); return r.end(page) }
    if (!q.url.startsWith('/api/')) return send(404, { error: 'not found' })
    try { await handle(q, await readBody(q), send) } catch (e) { send(400, { error: e.message }) }
  }).listen(port, () => console.log('[web] panel on port', port))
}
