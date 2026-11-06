// Persistent state: bots, places, server, settings and the login-key hash.
// Uses MongoDB when MONGO_URI is set, otherwise a local JSON file.
import fs from 'node:fs'

// default bot behaviour; every field is editable from the panel
export const DEFAULTS = { version: 'auto', roam: 15, homeR: 6, lookPlayers: true, eat: true, fidget: true, sprint: false, reconnect: 10, view: 'tiny' }

export const S = {
  host: process.env.HOST || 'localhost',
  port: +(process.env.PORT_MC || 25565),
  bots: [],      // [{ name, at? }]
  places: {},    // { name: { x, y, z } }
  set: { ...DEFAULTS },
  keyHash: '',
}

const FILE = process.env.DATA || './data.json'
let col

function apply(d) {
  if (!d) return
  Object.assign(S, {
    host: d.host ?? S.host, port: d.port ?? S.port, bots: d.bots || [], keyHash: d.keyHash || '',
    places: Array.isArray(d.places) ? Object.fromEntries(d.places) : d.places || {},
    set: { ...DEFAULTS, ...d.set },
  })
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
  if (!S.bots.length && process.env.NAME) S.bots = [{ name: process.env.NAME }]
}

export function save() {
  // places stored as entries so names with "." or "$" are safe in MongoDB
  const d = { host: S.host, port: S.port, bots: S.bots, places: Object.entries(S.places), set: S.set, keyHash: S.keyHash }
  if (col) col.replaceOne({ _id: 'main' }, d, { upsert: true }).catch(e => console.log('[store] save failed:', e.message))
  else fs.writeFileSync(FILE, JSON.stringify(d, null, 1))
}
