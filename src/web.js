// Control panel: serves public/index.html and a small JSON API under /api.
import http from 'node:http'
import fs from 'node:fs'
import { S, DEFAULTS, save, newId, serverKey } from './store.js'
import * as auth from './auth.js'
import { start, stop, restart, live, stats, placeOf } from './bots.js'
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
  return DEFAULTS[k]
}

// validate { name, host, port, version } for a new or edited bot; returns error text or the clean bot fields
function botFields(body, cur = {}) {
  const f = {
    name: body.name ?? cur.name, host: String(body.host ?? cur.host ?? '').trim().toLowerCase(),
    port: body.port === undefined || body.port === '' ? cur.port ?? 25565 : +body.port,
    version: body.version ?? cur.version ?? 'auto',
  }
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
      if (serverKey(f.host, f.port) !== serverKey(cfg.host, cfg.port)) delete cfg.at // places belong to a server
      Object.assign(cfg, f); save(); restart(id); return send(200, {})
    }
    if (act === 'send') {
      const p = placeOf(body.place); if (!p) return send(400, { error: 'no place' })
      if (p.server !== serverKey(cfg.host, cfg.port)) return send(400, { error: 'that place is on another server' })
      cfg.at = p.id; save(); st?.goto?.(p); return send(200, {})
    }
    if (act === 'roam') { delete cfg.at; save(); st?.roam?.(); return send(200, {}) }
    if (act === 'restart') { restart(id); return send(200, {}) }
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
