// Control panel: serves public/index.html and a small JSON API under /api.
import http from 'node:http'
import fs from 'node:fs'
import { S, DEFAULTS, save, newId, serverKey, eff } from './store.js'
import * as auth from './auth.js'
import { start, stop, restart, live, stats, placeOf, setMode, chat, invAction } from './bots.js'
import { MODES } from './brain.js'
import { SUPPORTED } from './version.js'
import { aiReady, aiConfig } from './ai.js'
import { listSchematics, addSchematic, addSchematicFromUrl, deleteSchematic, startBuild, placeOnGround } from './schemstore.js'

const page = fs.readFileSync(new URL('../public/index.html', import.meta.url))
const validName = n => /^[A-Za-z0-9_]{3,16}$/.test(n)
const validHost = h => /^[A-Za-z0-9.-]{1,253}$/.test(h)
const validPort = p => Number.isInteger(p) && p > 0 && p < 65536
const short = n => String(n || '').trim().slice(0, 32)

// coerce a shared setting to its allowed type/range
function clean(k, v) {
  if (typeof DEFAULTS[k] === 'boolean') return !!v
  if (k === 'aiMax' || k === 'aiThinkMax') return Math.max(0, Math.min(500, Math.round(+v || 0)))
  if (k === 'retaliate') return ['everyone', 'others', 'off'].includes(v) ? v : 'everyone'
  if (k === 'nicknames') return String(v || '').split(',').map(s => s.trim().slice(0, 24)).filter(Boolean).slice(0, 10).join(', ')
  if (k === 'goal') return String(v || '').trim().slice(0, 300)
  if (typeof DEFAULTS[k] === 'number') return Math.max(0, Math.min(64, +v || 0))
  if (k === 'view') return ['tiny', 'short', 'normal'].includes(v) ? v : 'tiny'
  if (k === 'combat') return ['auto', 'flee', 'fight', 'ignore'].includes(v) ? v : 'auto'
  if (k === 'persona') return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (k === 'owners') return String(v || '').split(',').map(s => s.trim()).filter(validName).slice(0, 20).join(', ')
  return DEFAULTS[k]
}

// turn a mode request from the panel into a bot patch; returns error text or the patch
function modePatch(cfg, st, { mode, place, player, here, xyz }) {
  if (!MODES.includes(mode)) return 'unknown mode'
  if (mode === 'follow') {
    const name = String(player || '').trim()
    if (!validName(name)) return 'pick a player to follow'
    return { mode, follow: name }
  }
  if (['stay', 'guard', 'farm', 'survive', 'auto'].includes(mode)) {
    if (xyz) { // walk to exact coordinates
      const [x, y, z] = String(xyz).trim().split(/[\s,]+/).map(Number)
      if (![x, y, z].every(Number.isFinite) || [x, y, z].some(n => Math.abs(n) > 3e7)) return 'coordinates must be like: 100 64 -20'
      return { mode, spot: { x: Math.round(x), y: Math.round(y), z: Math.round(z) } }
    }
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
  const limit = q.url.startsWith('/api/schematics') ? 22e6 : 1e4 // schematic uploads (base64) can be big
  for await (const c of q) { raw += c; if (raw.length > limit) throw new Error('too big') }
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

  if (what === 'state') return send(200, { ...stats(), versions: ['auto', ...SUPPORTED.slice().reverse()], aiKeySet: !!S.aiKey, ai: { ...aiConfig(), ready: aiReady() }, schematics: listSchematics() })
  if (what === 'schematics') { // { filename, data: base64 } upload, or { url }
    if (q.method === 'DELETE') { await deleteSchematic(id); return send(200, {}) }
    if (body.url) return send(200, await addSchematicFromUrl(String(body.url).trim()))
    if (!body.data) return send(400, { error: 'choose a file or paste a link' })
    return send(200, await addSchematic(String(body.filename || 'upload.zip'), Buffer.from(String(body.data), 'base64')))
  }
  if (what === 'aiconfig') { // { provider, region, model }
    const provider = body.provider === 'anthropic' ? 'anthropic' : 'bedrock'
    const region = String(body.region || '').trim(), model = String(body.model || '').trim()
    if (region && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) return send(400, { error: 'region looks wrong (e.g. us-east-1)' })
    if (model && !/^[A-Za-z0-9.:_/-]{3,120}$/.test(model)) return send(400, { error: 'model id looks wrong' })
    S.ai = { provider, ...(region && { region }), ...(model && { model }) }; save(); return send(200, {})
  }
  if (what === 'aikey') { // write-only: the key is never returned
    const k = String(body.key || '').trim()
    if (k && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) return send(400, { error: 'that does not look like an Anthropic API key (sk-ant-...)' })
    S.aiKey = k; save(); return send(200, {})
  }

  if (what === 'settings') { // shared behaviour for all bots
    const old = { ...S.set }
    for (const k in DEFAULTS) if (k in body) S.set[k] = clean(k, body[k])
    if ('combat' in body) S.set.combatChosen = true // an explicit choice is kept as is
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
    if (act === 'settings') { // per-bot overrides: { key: value } sets, { key: null } back to shared, { reset: true } clears all
      const before = JSON.stringify(eff(cfg))
      if (body.reset) delete cfg.set
      else for (const k in DEFAULTS) if (k in body) {
        cfg.set ||= {}
        const v = body[k] === null ? null : clean(k, body[k])
        if (v === null || v === S.set[k]) delete cfg.set[k]; else cfg.set[k] = v
        if (k === 'combat' && v !== null && v !== S.set[k]) cfg.set.combatChosen = true
      }
      if (cfg.set && !Object.keys(cfg.set).length) delete cfg.set
      save()
      if (JSON.parse(before).view !== eff(cfg).view) restart(id); else st?.moves?.()
      return send(200, {})
    }
    if (act === 'extras') { // on-join commands and timed auto-message
      if ('onJoin' in body) {
        const t = String(body.onJoin || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 5).map(l => l.slice(0, 250)).join('\n')
        if (t) cfg.onJoin = t; else delete cfg.onJoin
      }
      if ('autoMsg' in body) {
        const text = String(body.autoMsg?.text || '').trim().slice(0, 250), mins = Math.max(1, Math.min(1440, Math.round(+body.autoMsg?.mins || 0)))
        if (text && +body.autoMsg?.mins) cfg.autoMsg = { text, mins }; else delete cfg.autoMsg
      }
      save(); return send(200, { note: 'applies on next join' })
    }
    if (act === 'build') { // { schem, where: 'base' | 'here' | 'x y z', rot: 0-3, mode: auto | survival | commands }
      if (!listSchematics().some(s => s.name === body.schem)) return send(400, { error: 'pick a schematic' })
      const pos = st?.bot?.entity?.position, home = cfg.spot || S.places.find(p => p.id === cfg.at)
      let origin = body.where === 'here' ? pos : body.where === 'base' ? home : null
      if (!origin && /^-?\d+\s+-?\d+\s+-?\d+$/.test(String(body.where || '').trim())) { const [x, y, z] = String(body.where).trim().split(/\s+/).map(Number); origin = { x, y, z } }
      if (!origin) return send(400, { error: body.where === 'base' ? 'this bot has no base yet' : 'the bot is not in the world' })
      if ((body.where === 'here' || body.where === 'base') && st?.bot?.entity) origin = await placeOnGround(st.bot, body.schem, origin) // on the surface, not in a cave
      startBuild(cfg, body.schem, origin, { rot: +body.rot || 0, mode: ['survival', 'commands'].includes(body.mode) ? body.mode : 'auto' })
      return send(200, {})
    }
    if (act === 'buildstop') { if (cfg.build) { cfg.build.state = 'done'; cfg.build.stopped = true; save() } return send(200, {}) }
    if (act === 'inv') { const err = await invAction(id, body.action, body.slot); return err ? send(400, { error: err }) : send(200, {}) }
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
