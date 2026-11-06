// Control panel: serves public/index.html and a small JSON API under /api.
import http from 'node:http'
import fs from 'node:fs'
import { S, DEFAULTS, save } from './store.js'
import * as auth from './auth.js'
import { start, stop, restartAll, stats, live } from './bots.js'
import { SUPPORTED, server } from './version.js'

const page = fs.readFileSync(new URL('../public/index.html', import.meta.url))
const validName = n => /^[A-Za-z0-9_]{3,16}$/.test(n)
const place = n => String(n || '').slice(0, 32)

// coerce a settings value to its allowed type/range
function clean(k, v) {
  if (typeof DEFAULTS[k] === 'boolean') return !!v
  if (typeof DEFAULTS[k] === 'number') return Math.max(0, Math.min(64, +v || 0))
  if (k === 'version') return v === 'auto' || SUPPORTED.includes(v) ? v : 'auto'
  if (k === 'view') return ['tiny', 'short', 'normal'].includes(v) ? v : 'tiny'
  return DEFAULTS[k]
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

  if (what === 'server') {
    S.host = String(body.host || S.host).trim(); S.port = +body.port || 25565; server.info = null
    save(); restartAll(); return send(200, {})
  }

  if (what === 'settings') {
    const old = { ...S.set }
    for (const k in DEFAULTS) if (k in body) S.set[k] = clean(k, body[k])
    save()
    if (old.version !== S.set.version || old.view !== S.set.view) restartAll() // needs a rejoin
    else for (const st of live.values()) st.moves?.()
    return send(200, {})
  }

  if (what === 'places') {
    if (q.method === 'DELETE') delete S.places[id]
    else { if (!body.name) return send(400, { error: 'name needed' }); S.places[place(body.name)] = { x: +body.x || 0, y: +body.y || 0, z: +body.z || 0 } }
    save(); return send(200, {})
  }

  if (what === 'bots') {
    if (q.method === 'POST' && !id) {
      if (!validName(body.name) || S.bots.some(b => b.name === body.name)) return send(400, { error: 'name: 3-16 chars A-Z 0-9 _, unique' })
      S.bots.push({ name: body.name }); save(); start(body.name); return send(200, {})
    }
    const cfg = S.bots.find(b => b.name === id), st = live.get(id)
    if (!cfg) return send(404, { error: 'no bot' })
    if (q.method === 'DELETE') { stop(id); S.bots = S.bots.filter(b => b !== cfg); save(); return send(200, {}) }
    if (act === 'rename') {
      if (!validName(body.name) || S.bots.some(b => b.name === body.name)) return send(400, { error: 'bad name' })
      stop(id); cfg.name = body.name; save(); start(cfg.name); return send(200, {})
    }
    if (act === 'send') {
      const p = S.places[body.place]; if (!p) return send(400, { error: 'no place' })
      cfg.at = body.place; save(); st?.goto?.(p, body.place); return send(200, {})
    }
    if (act === 'roam') { delete cfg.at; save(); st?.roam?.(); return send(200, {}) }
    if (act === 'restart') { stop(id); start(id); return send(200, {}) }
    if (act === 'here' && st?.bot?.entity) {
      const p = st.bot.entity.position
      S.places[place(body.name)] = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }
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
