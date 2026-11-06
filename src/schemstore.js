// Saved schematics: MongoDB collection "schematics" when MONGO_URI is set, otherwise ./schematics/*.json.
// Also runs build jobs (cfg.build) for bots.
import fs from 'node:fs'
import { Vec3 } from 'vec3'
import { getDb, save } from './store.js'
import { parseSchematic, buildStep } from './schematic.js'

const DIR = './schematics'
const cache = new Map() // name -> parsed schematic
const meta = new Map()  // name -> { name, format, size, blocks, materials }
const toMeta = s => ({ name: s.name, format: s.format, file: s.file, size: s.size, blocks: s.cells.length, materials: Object.fromEntries(Object.entries(s.materials).slice(0, 12)) })

export async function loadSchematics() {
  const db = getDb()
  if (db) for (const d of await db.collection('schematics').find({}, { projection: { meta: 1 } }).toArray()) meta.set(d._id, d.meta)
  else if (fs.existsSync(DIR)) for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.json'))) { try { const s = JSON.parse(fs.readFileSync(`${DIR}/${f}`)); meta.set(s.name, toMeta(s)) } catch {} }
}
export const listSchematics = () => [...meta.values()]

export async function getSchematic(name) {
  if (cache.has(name)) return cache.get(name)
  const db = getDb()
  let s = null
  if (db) { const d = await db.collection('schematics').findOne({ _id: name }); s = d && JSON.parse(d.data) }
  else if (fs.existsSync(`${DIR}/${name}.json`)) s = JSON.parse(fs.readFileSync(`${DIR}/${name}.json`))
  if (s) cache.set(name, s)
  return s
}

export async function addSchematic(filename, buf) {
  let s
  try { s = await parseSchematic(filename, buf) } catch (e) { throw new Error(/not supported|no .litematic|empty|no regions|no block|no blocks/.test(e.message) ? e.message : `could not read ${filename} as a schematic (is it a .litematic, .schem, .nbt or a .zip with one inside?)`) }
  let name = s.name, n = 2
  while (meta.has(name)) name = `${s.name}-${n++}`
  s.name = name
  const db = getDb()
  if (db) await db.collection('schematics').replaceOne({ _id: name }, { _id: name, meta: toMeta(s), data: JSON.stringify(s) }, { upsert: true })
  else { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(`${DIR}/${name}.json`, JSON.stringify(s)) }
  cache.set(name, s); meta.set(name, toMeta(s))
  return toMeta(s)
}

// download from a direct link (sites with browser checks, like Planet Minecraft, need a manual download + upload)
export async function addSchematicFromUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('give a http(s) link')
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Wanderbots schematic importer' } })
  if (!res.ok) throw new Error([401, 403, 429, 503].includes(res.status) ? `the site blocked the download (${res.status}); it only lets browsers download. Download the file in your browser and upload it in the panel.` : `download failed (${res.status})`)
  const type = res.headers.get('content-type') || ''
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > 15e6) throw new Error('file is bigger than 15 MB')
  if (/text\/html/i.test(type) || buf.slice(0, 15).toString().toLowerCase().includes('<!doctype') || buf.slice(0, 6).toString().toLowerCase() === '<html>')
    throw new Error('that link gives a web page, not a file (the site may block downloads by bots). Download it in your browser and upload it in the panel.')
  const name = decodeURIComponent(new URL(res.url).pathname.split('/').pop() || 'schematic.zip')
  return addSchematic(name, buf)
}

export async function deleteSchematic(name) {
  const db = getDb()
  if (db) await db.collection('schematics').deleteOne({ _id: name })
  else if (fs.existsSync(`${DIR}/${name}.json`)) fs.unlinkSync(`${DIR}/${name}.json`)
  cache.delete(name); meta.delete(name)
}

// ---------- build jobs ----------
// Put a build on solid ground at the surface instead of in the air or inside a cave:
// scan the footprint's centre column from high up down to the first solid block with 2 air blocks above it.
const SOFT = /leaves|log$|wood$|grass$|fern|flower|snow$|vine|air|water|lava|bush|sapling|mushroom|leaf_litter/
export function groundAt(b, x, z, nearY) {
  for (let y = Math.min(nearY + 120, 319); y > nearY - 40; y--) {
    const bl = b.blockAt(new Vec3(x, y, z)), up = b.blockAt(new Vec3(x, y + 1, z)), up2 = b.blockAt(new Vec3(x, y + 2, z))
    if (!bl || !up || !up2) continue
    if (bl.boundingBox === 'block' && !SOFT.test(bl.name) && /air/.test(up.name) && /air/.test(up2.name)) {
      // open sky above? (not a cave ceiling)
      let open = true
      for (let k = 3; k < 24; k++) { const c = b.blockAt(new Vec3(x, y + k, z)); if (c && c.boundingBox === 'block' && !/leaves/.test(c.name)) { open = false; break } }
      if (open) return y + 1
    }
  }
  return null
}
export async function placeOnGround(b, schemName, origin) {
  const s = await getSchematic(schemName)
  const cx = Math.round(origin.x + (s ? s.size.x / 2 : 0)), cz = Math.round(origin.z + (s ? s.size.z / 2 : 0))
  const y = groundAt(b, cx, cz, Math.round(origin.y))
  return y == null ? origin : { x: origin.x, y, z: origin.z }
}

// cfg.build = { schem, origin: {x,y,z}, rot, mode: 'auto' | 'survival' | 'commands', state: 'running' | 'waiting' | 'done', placed, missing }
export function startBuild(cfg, schem, origin, { rot = 0, mode = 'auto' } = {}) {
  cfg.build = { schem, origin: { x: Math.round(origin.x), y: Math.round(origin.y), z: Math.round(origin.z) }, rot: ((+rot % 4) + 4) % 4, mode, state: 'running', placed: 0, missing: {}, started: Date.now() }
  save()
  return cfg.build
}

// one step of the current build; returns a short report
export async function runBuild(b, cfg, opts = {}) {
  const job = cfg.build
  if (!job || job.state === 'done') return 'no build in progress'
  const s = await getSchematic(job.schem)
  if (!s) { job.state = 'done'; save(); return `schematic ${job.schem} not found` }
  let r
  if (job.mode === 'auto' || job.mode === 'commands') {
    try { r = await buildStep(b, s, { ...job, mode: 'commands' }, opts); job.placed = (job.placed || 0) + r.placed }
    catch (e) {
      if (job.mode === 'commands') { job.state = 'waiting'; save(); return 'build stopped: ' + e.message }
      job.mode = 'survival' // not op: place by hand instead
      r = await buildStep(b, s, job, opts)
    }
  } else r = await buildStep(b, s, job, opts)
  job.missing = r.missing
  job.remaining = r.remaining
  if (r.done) job.state = 'done'
  else if (job.mode === 'survival' && r.placed === 0 && Object.keys(r.missing).length) job.state = 'waiting' // out of materials
  else job.state = 'running'
  save()
  return r.report + (job.state === 'waiting' ? ' Waiting for materials.' : '')
}
