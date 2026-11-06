// Chat: per-bot log, rate-limited sending, replies, greetings and owner commands.
import { S, save, newId, eff } from './store.js'
import { rnd } from './brain.js'
import { aiReply, aiReady, aiCall } from './ai.js'
import { inbox } from './aiplay.js'
import { isCalled } from './social.js'
import { listSchematics, startBuild, addSchematicFromUrl, placeOnGround } from './schemstore.js'

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
  const norm = String(text).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim(), now0 = Date.now()
  st.said ||= {}
  for (const [k, t] of Object.entries(st.said)) if (now0 - t > 180e3) delete st.said[k]
  if (st.said[norm]) return // said this already
  if (/\b(thanks|thank you|thx|ty)\b/.test(norm)) { if (now0 - (st.thankedAt || 0) < 300e3) return; st.thankedAt = now0 }
  st.said[norm] = now0
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
    const c = eff(cfg), now = Date.now(), named = isCalled(b.username, msg, c.nicknames) // full name, short form or nickname
    st.convo ||= {}
    const talking = named || now - (st.convo[user] || 0) < 60e3 // keeps talking to someone for a minute after they started
    // owners can give orders in plain language (no ! needed)
    if (owners(cfg).includes(user.toLowerCase()) && !msg.startsWith('!') && (named || Object.keys(b.players).length <= 3)) {
      st.convo[user] = now
      if (cfg.mode === 'ai') { inbox(st, `YOUR OWNER ${user} says: ${msg}`); return }
      if (aiReady()) { ownerOrder(b, st, cfg, user, msg, setMode).catch(e => log(st, 'event', 'owner order failed: ' + String(e.message || e).slice(0, 100))); return }
    }
    if (cfg.mode === 'ai' && (talking || Object.keys(b.players).length <= 3)) { st.convo[user] = now; inbox(st, `${user} says in chat: ${msg}`); return }
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

// turn an owner's plain-language message into one of the bot's commands (one quick AI call)
const ORDERS = [
  ['follow', 'Follow the owner around.'], ['come', 'Come to the owner and follow them.'], ['stay', 'Stay where the owner is standing.'],
  ['guard', 'Guard the spot where the owner is standing and fight mobs.'], ['roam', 'Wander around freely.'], ['idle', 'Stand still (AFK).'],
  ['goto', 'Go to a saved place and stay there.', { place: { type: 'string', description: 'Saved place name' } }],
  ['status', 'Tell the owner your health, food, position and what you are doing.'],
  ['ai', 'Switch to playing by itself with AI, working towards a goal (use for any task like gathering, building, crafting, mining, fighting).', { goal: { type: 'string', description: 'The task or goal, in the owner\'s words' } }],
  ['build', 'Build a saved schematic (design), or one from a link the owner pasted.', { schematic: { type: 'string', description: 'Schematic name, or empty if a link was given' }, url: { type: 'string', description: 'Link to a schematic file, if the owner pasted one' }, where: { type: 'string', description: 'here (where the owner stands), base, or x y z' } }],
  ['reply', 'Just answer in chat (questions, small talk).', { message: { type: 'string', description: 'Short reply' } }],
]
async function ownerOrder(b, st, cfg, user, msg, setMode) {
  const places = S.places.filter(p => p.server === `${cfg.host}:${cfg.port}`).map(p => p.name)
  const res = await aiCall({
    max_tokens: 300,
    system: `You control a Minecraft bot named ${b.username}. Its owner ${user} just wrote in chat. Pick the one command that does what the owner wants. Saved places: ${places.join(', ') || 'none'}. Saved schematics: ${listSchematics().map(s => s.name).join(', ') || 'none'}. Current mode: ${cfg.mode || 'roam'}.`,
    tools: ORDERS.map(([name, description, props = {}]) => ({ name, description, input_schema: { type: 'object', properties: props, required: Object.keys(props) } })),
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: `${user}: ${msg}` }],
  })
  const call = res.content.find(x => x.type === 'tool_use')
  if (!call) return
  log(st, 'event', `owner ${user}: "${msg}" -> ${call.name}`)
  if (call.name === 'reply') return later(b, st, String(call.input.message || '').slice(0, 200))
  if (call.name === 'build') {
    let name = call.input.schematic, url = call.input.url || (msg.match(/https?:\/\/\S+/) || [])[0]
    try {
      if (url) { later(b, st, 'downloading the schematic...'); name = (await addSchematicFromUrl(url)).name }
      const s = listSchematics().find(x => x.name.toLowerCase() === String(name || '').toLowerCase()) || (listSchematics().length === 1 && !name ? listSchematics()[0] : null)
      if (!s) return later(b, st, `don't have a schematic called ${name || 'that'}${listSchematics().length ? ' (I have: ' + listSchematics().map(x => x.name).join(', ') + ')' : ''}`)
      const them = b.players[user]?.entity?.position, where = call.input.where || 'here'
      const origin = where === 'base' && (cfg.spot || S.places.find(p => p.id === cfg.at)) || (where === 'here' && them) || them || b.entity.position
      startBuild(cfg, s.name, where === 'here' && them ? origin : await placeOnGround(b, s.name, origin), {})
      if (cfg.mode === 'ai') inbox(st, `YOUR OWNER ${user} asked you to build ${s.name}. A build job is started: use continueBuild and gather missing materials.`)
      return later(b, st, `ok, building ${s.name} (${s.blocks} blocks)`)
    } catch (e) { return later(b, st, String(e.message).slice(0, 180)) }
  }
  if (call.name === 'ai') { setMode({ mode: 'ai' }); st.aiGoal = String(call.input.goal || msg).slice(0, 300); inbox(st, `YOUR OWNER ${user} asked: ${msg}`); return later(b, st, 'on it') }
  return command(b, st, cfg, user, [call.name === 'come' ? 'come' : call.name, ...(call.input.place ? String(call.input.place).split(' ') : [])], setMode)
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
