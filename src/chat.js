// Chat: per-bot log, rate-limited sending, replies, greetings and owner commands.
import { S, save, newId, eff } from './store.js'
import { rnd } from './brain.js'
import { aiReply, aiReady } from './ai.js'

const pick = a => a[Math.floor(Math.random() * a.length)]
const REPLY = ['hi', 'hey', 'yo', 'sup', 'hello :)', 'hm?', "what's up", 'yeah?', 'hey there']
const GREET = ['hey {p}', 'hi {p}', 'yo {p}', 'welcome {p}', 'o/ {p}', 'hello {p}']
const HELP = '!come !follow !stay !guard !roam !idle !goto <place> !status'

// keep the last 60 lines per bot for the panel
export function log(st, type, text) {
  st.log ||= []
  st.log.push({ t: Date.now(), type, text: String(text).slice(0, 300) })
  if (st.log.length > 60) st.log.shift()
}

// at most one message every 3s per bot, like a person typing
export function say(b, st, text) {
  const now = Date.now(), at = Math.max(now, (st.nextSay || 0))
  st.nextSay = at + 3000
  setTimeout(() => { try { b.chat(String(text).slice(0, 250)); log(st, 'me', text) } catch {} }, at - now)
}
const later = (b, st, text) => setTimeout(() => say(b, st, text), rnd(1200, 3500)) // human reply delay

const owners = cfg => eff(cfg).owners.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

export function attachChat(b, st, cfg, { setMode }) {
  b.on('messagestr', (msg, pos) => { if (pos !== 'game_info' && msg.trim()) log(st, pos === 'chat' ? 'chat' : 'server', msg) })
  b.on('death', () => log(st, 'event', 'died'))
  b.on('playerJoined', p => {
    if (!st.joined || Date.now() - st.joined < 10e3 || p.username === b.username) return
    log(st, 'event', p.username + ' joined')
    st.greeted ||= {}
    if (eff(cfg).greet && chance(0.6) && Date.now() - (st.greeted[p.username] || 0) > 10 * 60e3) {
      st.greeted[p.username] = Date.now()
      setTimeout(() => say(b, st, pick(GREET).replace('{p}', p.username)), rnd(2500, 7000))
    }
  })
  b.on('playerLeft', p => { if (st.joined && p.username !== b.username) log(st, 'event', p.username + ' left') })

  b.on('chat', (user, message) => {
    if (user === b.username) return
    const msg = message.trim(), lower = msg.toLowerCase()
    if (msg.startsWith('!') && owners(cfg).includes(user.toLowerCase())) return command(b, st, cfg, user, msg.slice(1).split(/\s+/), setMode)
    const c = eff(cfg), now = Date.now(), named = lower.includes(b.username.toLowerCase())
    st.convo ||= {}
    const talking = named || now - (st.convo[user] || 0) < 60e3 // keeps talking to someone for a minute after they started
    if (c.ai && aiReady() && talking && now - (st.aiAt || 0) > 4000) {
      st.aiCalls = (st.aiCalls || []).filter(t => now - t < 3600e3)
      if (st.aiCalls.length < c.aiMax) {
        st.aiAt = now; st.aiCalls.push(now); st.convo[user] = now
        aiReply(b, st, cfg, user, msg, c.persona)
          .then(t => { if (t) { st.count?.('aiReplies'); later(b, st, t) } })
          .catch(e => log(st, 'event', 'AI chat error: ' + (e.status ? e.status + ' ' : '') + String(e.message || e).slice(0, 120)))
        return
      }
    }
    if (c.replies && named && now - (st.replied || 0) > 8000) {
      st.replied = now; later(b, st, pick(REPLY))
    }
  })
}

function command(b, st, cfg, user, [cmd, ...args], setMode) {
  const me = b.entity?.position, them = b.players[user]?.entity?.position
  const spot = p => p && { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }
  switch ((cmd || '').toLowerCase()) {
    case 'come': case 'follow': setMode({ mode: 'follow', follow: user }); return later(b, st, 'coming')
    case 'stay': setMode({ mode: 'stay', spot: spot(them || me) }); return later(b, st, 'ok, staying here')
    case 'guard': setMode({ mode: 'guard', spot: spot(them || me) }); return later(b, st, 'guarding this spot')
    case 'roam': setMode({ mode: 'roam' }); return later(b, st, 'ok')
    case 'idle': case 'afk': setMode({ mode: 'idle' }); return later(b, st, 'ok')
    case 'goto': {
      const name = args.join(' ').toLowerCase(), p = S.places.find(x => x.name.toLowerCase() === name && x.server === `${cfg.host}:${cfg.port}`)
      if (!p) return later(b, st, "don't know that place")
      setMode({ mode: 'stay', at: p.id }); return later(b, st, 'going to ' + p.name)
    }
    case 'here': { // save where the owner stands as a place
      const name = args.join(' ').slice(0, 32), p = spot(them)
      if (!name || !p) return later(b, st, 'usage: !here <name> (stand near me)')
      S.places.push({ id: newId(), name, server: `${cfg.host}:${cfg.port}`, ...p }); save(); return later(b, st, 'saved ' + name)
    }
    case 'status': return later(b, st, `hp ${Math.round(b.health)} food ${b.food} at ${spot(me) ? Object.values(spot(me)).join(' ') : '?'} · ${st.task}`)
    case 'help': return later(b, st, HELP)
  }
}
const chance = p => Math.random() < p
