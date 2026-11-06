// Persistent state: bots, places, settings and the login-key hash.
// Uses MongoDB when MONGO_URI is set, otherwise a local JSON file.
import fs from 'node:fs'
import crypto from 'node:crypto'

// shared behaviour for all bots; editable from the panel
export const DEFAULTS = {
  combat: 'flee',     // hostile mobs: 'flee' | 'fight' | 'ignore'  (guards always fight)
  guardR: 12,         // how far a guard looks for mobs
  roam: 15, homeR: 6, // wander radius when roaming / around a place
  lookPlayers: true, eat: true, gear: true, pickup: true, sleep: true, fidget: true, sprint: false,
  replies: true,      // answer when someone says the bot's name
  greet: false,       // say hi when players join
  owners: '',         // comma-separated player names allowed to use !commands in chat
  reconnect: 10, view: 'tiny',
}

export const S = {
  bots: [],    // [{ id, name, host, port, version, mode, at?, spot?, follow?, paused? }]  at = place id
  places: [],  // [{ id, name, server: 'host:port', x, y, z }]
  set: { ...DEFAULTS },
  keyHash: '',
}

export const newId = () => crypto.randomBytes(4).toString('hex')
export const serverKey = (host, port) => `${host}:${port}`

const FILE = './data.json'
let col

function apply(d) {
  if (!d) return
  // migrate the old single-server format: global host/port, places as object/entries
  const oldServer = d.host ? serverKey(d.host, d.port || 25565) : ''
  let places = d.places || []
  if (!Array.isArray(places) || (places.length && Array.isArray(places[0]))) {
    places = (Array.isArray(places) ? places : Object.entries(places)).map(([name, p]) => ({ id: newId(), name, server: oldServer, ...p }))
  }
  const bots = (d.bots || []).map(b => ({
    id: b.id || newId(), name: b.name, host: b.host || d.host || 'localhost', port: b.port || d.port || 25565,
    version: b.version || d.set?.version || 'auto', at: places.find(p => p.id === b.at || p.name === b.at)?.id,
    spot: b.spot, follow: b.follow, paused: b.paused, mode: b.mode || (b.at ? 'stay' : 'roam'),
  }))
  const { version, flee, ...set } = d.set || {}
  if (flee === false && !set.combat) set.combat = 'ignore'
  Object.assign(S, { bots, places, keyHash: d.keyHash || '', set: { ...DEFAULTS, ...set } })
}

export async function loadStore() {
  if (process.env.MONGO_URI) {
    const { MongoClient } = await import('mongodb')
    const cli = new MongoClient(process.env.MONGO_URI, { maxPoolSize: 2 })
    await cli.connect()
    col = cli.db().collection('state')
    apply(await col.findOne({ _id: 'main' }))
    console.log('[store] mongodb,', S.bots.length, 'bots')
  } else {
    try { apply(JSON.parse(fs.readFileSync(FILE))) } catch {}
    console.log('[store] file', FILE)
  }
}

export function save() {
  const d = { bots: S.bots, places: S.places, set: S.set, keyHash: S.keyHash }
  if (col) col.replaceOne({ _id: 'main' }, d, { upsert: true }).catch(e => console.log('[store] save failed:', e.message))
  else fs.writeFileSync(FILE, JSON.stringify(d, null, 1))
}
