// Storage sense: remember containers and what's in them, remember useful places, keep valuables safe,
// pack with shulker boxes, and keep the inventory from filling up with junk.
import { Vec3 } from 'vec3'
import * as skills from './mc/skills.js'
import * as world from './mc/world.js'
import { save } from './store.js'

const CONTAINER = /^(chest|trapped_chest|barrel|ender_chest|(\w+_)?shulker_box)$/
const POI = /^(crafting_table|furnace|blast_furnace|smoker|anvil|enchanting_table|brewing_stand|\w+_bed|chest|trapped_chest|barrel|ender_chest|(\w+_)?shulker_box|nether_portal|(deepslate_)?(diamond|iron|gold|emerald)_ore|ancient_debris)$/
// worth keeping safe instead of carrying around
export const VALUABLE = /^(diamond|diamond_block|emerald|emerald_block|gold_ingot|gold_block|raw_gold|raw_gold_block|iron_block|raw_iron_block|netherite_ingot|netherite_scrap|netherite_block|ancient_debris|enchanted_book|enchanted_golden_apple|golden_apple|totem_of_undying|nether_star|heart_of_the_sea|lapis_block|redstone_block|music_disc_\w+|\w+_smithing_template)$/
const KEEP = { diamond: 3, golden_apple: 4, enchanted_golden_apple: 1, totem_of_undying: 1, gold_ingot: 2 } // carried on purpose
const JUNK = /^(dirt|gravel|sand|andesite|diorite|granite|tuff|cobbled_deepslate|calcite|netherrack|rotten_flesh|poisonous_potato|spider_eye|\w+_seeds|\w+_sapling|short_grass|tall_grass|fern|vine|dead_bush|bush|leaf_litter|\w+_leaves|poppy|dandelion|\w+_tulip|bamboo|kelp|seagrass|bone|string|feather|egg|brown_egg|arrow|flint)$/
const JUNK_KEEP = { dirt: 32, cobbled_deepslate: 0, gravel: 0, sand: 0, andesite: 0, diorite: 0, granite: 0, tuff: 0, arrow: 0, flint: 1 }
const GEAR = /_(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots)$|^(shield|bow|crossbow|fishing_rod|shears|flint_and_steel|bucket|water_bucket|torch|crafting_table|furnace)$/

const key = p => `${p.x},${p.y},${p.z}`
const counts = items => { const m = {}; for (const i of items) m[i.name] = (m[i.name] || 0) + i.count; return m }
const fmt = items => Object.entries(items).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ') || 'empty'
let saveTimer = null
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 5000) }

function mem(cfg) { cfg.mem ||= { containers: {}, ender: null, poi: {} }; return cfg.mem }

// ---------- memory ----------
// record a container's contents whenever it's opened (and again when it closes)
export function attachStorageMemory(b, getCfg) {
  if (b._storageWrapped) return
  b._storageWrapped = true
  const open = b.openContainer.bind(b)
  b.openContainer = async (block, ...rest) => {
    const w = await open(block, ...rest)
    const rec = () => { const cfg = getCfg(); if (cfg && block?.position) record(b, cfg, block, w) }
    rec(); w.once('close', rec)
    return w
  }
  // look around for useful places every 30 s, and forget containers that are gone
  const scan = setInterval(() => { const cfg = getCfg(); if (cfg && b.entity) scanPlaces(b, cfg) }, 30e3)
  b.once('end', () => clearInterval(scan))
}

function record(b, cfg, block, w) {
  const m = mem(cfg), items = counts(w.containerItems())
  if (block.name === 'ender_chest') m.ender = { items, t: Date.now() } // same contents in every ender chest
  else m.containers[key(block.position)] = { type: block.name, pos: { ...block.position }, dim: b.game?.dimension, items, t: Date.now() }
  saveSoon()
}

function scanPlaces(b, cfg) {
  const m = mem(cfg), dim = b.game?.dimension, p = b.entity.position
  const found = b.findBlocks({ matching: bl => POI.test(bl.name), maxDistance: 32, count: 80 })
  const seen = new Set()
  for (const v of found) {
    const bl = b.blockAt(v); if (!bl) continue
    const k = `${bl.name}@${key(v)}`; seen.add(key(v))
    m.poi[k] = { type: bl.name, pos: { x: v.x, y: v.y, z: v.z }, dim, t: Date.now() }
  }
  // forget things that were in range but are gone now (mined, picked up)
  for (const [k, e] of Object.entries(m.poi)) if (e.dim === dim && new Vec3(e.pos.x, e.pos.y, e.pos.z).distanceTo(p) < 28 && !seen.has(key(e.pos))) delete m.poi[k]
  for (const [k, c] of Object.entries(m.containers)) {
    if (c.dim !== dim) continue
    const v = new Vec3(c.pos.x, c.pos.y, c.pos.z), bl = b.blockAt(v)
    if (bl && v.distanceTo(p) < 28 && !CONTAINER.test(bl.name)) delete m.containers[k]
  }
  // keep memory small: at most 12 of each kind, nearest first
  const byType = {}
  for (const [k, e] of Object.entries(m.poi)) (byType[e.type.replace(/^\w+_(bed|shulker_box)$/, '$1')] ||= []).push([k, e])
  for (const list of Object.values(byType)) list.sort((a, b2) => new Vec3(a[1].pos.x, a[1].pos.y, a[1].pos.z).distanceTo(p) - new Vec3(b2[1].pos.x, b2[1].pos.y, b2[1].pos.z).distanceTo(p)).slice(12).forEach(([k]) => delete m.poi[k])
  saveSoon()
}

// where is an item: inventory, known containers, ender chest
export function whereIs(b, cfg, item) {
  const m = mem(cfg), name = String(item).toLowerCase().replace(/\s+/g, '_')
  const out = []
  const inv = counts(b.inventory.items()); for (const [k, v] of Object.entries(inv)) if (k.includes(name)) out.push(`${v} ${k} in your inventory`)
  for (const c of Object.values(m.containers)) for (const [k, v] of Object.entries(c.items)) if (k.includes(name)) out.push(`${v} ${k} in the ${c.type} at ${c.pos.x} ${c.pos.y} ${c.pos.z}`)
  if (m.ender) for (const [k, v] of Object.entries(m.ender.items)) if (k.includes(name)) out.push(`${v} ${k} in your ender chest`)
  return out.length ? out.join('; ') : `no ${name} anywhere you remember`
}

// short memory summary for the AI and the panel
export function memorySummary(b, cfg) {
  const m = mem(cfg), p = b.entity?.position, dim = b.game?.dimension
  const dist = e => p ? Math.round(new Vec3(e.pos.x, e.pos.y, e.pos.z).distanceTo(p)) : 0
  const lines = []
  const conts = Object.values(m.containers).filter(c => c.dim === dim).sort((a, b2) => dist(a) - dist(b2)).slice(0, 5)
  for (const c of conts) lines.push(`${c.type} at ${c.pos.x} ${c.pos.y} ${c.pos.z} (${dist(c)} m): ${fmt(c.items).slice(0, 160)}`)
  if (m.ender) lines.push(`ender chest contents: ${fmt(m.ender.items).slice(0, 160)}`)
  const near = {}
  for (const e of Object.values(m.poi)) { if (e.dim !== dim || /^(chest|trapped_chest|barrel)$/.test(e.type)) continue; const t = e.type.replace(/^\w+_(bed|shulker_box)$/, '$1').replace(/^deepslate_/, ''); if (!near[t] || dist(e) < dist(near[t])) near[t] = e }
  const places = Object.entries(near).map(([t, e]) => `${t} ${e.pos.x} ${e.pos.y} ${e.pos.z} (${dist(e)} m)`)
  if (places.length) lines.push('known places: ' + places.join(', '))
  return lines
}

// ---------- what to carry ----------
// valuables beyond what it carries on purpose
export function extraValuables(b) {
  const inv = counts(b.inventory.items()), out = {}
  for (const [k, v] of Object.entries(inv)) if (VALUABLE.test(k) && v > (KEEP[k] || 0)) out[k] = v - (KEEP[k] || 0)
  return out
}
const junkExtra = b => { const inv = counts(b.inventory.items()), out = {}; for (const [k, v] of Object.entries(inv)) if (JUNK.test(k) && v > (JUNK_KEEP[k] ?? 4)) out[k] = v - (JUNK_KEEP[k] ?? 4); return out }

async function depositInto(b, block, wanted) {
  await skills.goToPosition(b, block.position.x, block.position.y, block.position.z, 2)
  const box = await b.openContainer(block)
  let moved = 0
  try {
    for (const [name, n] of Object.entries(wanted)) {
      const id = b.registry.itemsByName[name]?.id; if (!id) continue
      await box.deposit(id, null, n).then(() => { moved += n }, () => {})
    }
  } finally { box.close() }
  return moved
}

// nearest usable storage: an ender chest (safe), else a chest/barrel at or near the base, else any known one within 64
function findStorage(b, cfg, home, { enderOk = true } = {}) {
  const near = name => world.getNearestBlock(b, name, 24)
  if (enderOk) { const e = near('ender_chest'); if (e) return e }
  const p = b.entity.position, m = mem(cfg), dim = b.game?.dimension
  const homeV = home && new Vec3(home.x, home.y, home.z)
  const seenChests = Object.values(m.poi).filter(e => /^(chest|trapped_chest|barrel)$/.test(e.type) && !m.containers[key(e.pos)]).map(e => ({ type: e.type, pos: e.pos, dim: e.dim, items: {} }))
  const known = [...Object.values(m.containers), ...seenChests].filter(c => c.dim === dim && /^(chest|trapped_chest|barrel)$/.test(c.type) && Object.values(c.items).reduce((a, n) => a + n, 0) < 26 * 64)
    .map(c => ({ c, v: new Vec3(c.pos.x, c.pos.y, c.pos.z) }))
    .filter(({ v }) => v.distanceTo(p) < 96)
    .sort((a, b2) => (homeV ? a.v.distanceTo(homeV) - b2.v.distanceTo(homeV) : 0) || a.v.distanceTo(p) - b2.v.distanceTo(p))
  if (known[0]) { const bl = b.blockAt(known[0].v); if (bl && CONTAINER.test(bl.name)) return bl }
  return near('chest') || near('barrel')
}

// put valuables away (ender chest first). Returns a report.
export async function storeValuables(b, cfg, home) {
  const extra = extraValuables(b)
  if (!Object.keys(extra).length) return 'no valuables to store'
  let target = findStorage(b, cfg, home)
  if (!target && home) { // walk home and look for a chest there
    await skills.goToPosition(b, home.x, home.y, home.z, 3).catch(() => {})
    target = findStorage(b, cfg, home)
  }
  if (!target) {
    if (await packIntoShulker(b, extra)) return `no chest or ender chest nearby, packed ${fmt(extra)} into a shulker box`
    return 'no chest, ender chest or shulker box to keep valuables in (place a chest at your base)'
  }
  const moved = await depositInto(b, target, extra)
  return `stored ${moved} valuable items (${fmt(extra)}) in the ${target.name} at ${target.position.x} ${target.position.y} ${target.position.z}`
}

// ---------- shulker boxes ----------
const hasShulker = b => b.inventory.items().find(i => /shulker_box$/.test(i.name))
export async function packIntoShulker(b, wanted) {
  const sh = hasShulker(b)
  if (!sh || !Object.keys(wanted).length) return false
  const pos = world.getNearestFreeSpace(b, 1, 4)
  if (!pos) return false
  if (!await skills.placeBlock(b, sh.name, pos.x, pos.y, pos.z)) return false
  const block = b.blockAt(new Vec3(pos.x, pos.y, pos.z))
  let ok = false
  try {
    const box = await b.openContainer(block)
    try { for (const [name, n] of Object.entries(wanted)) { const id = b.registry.itemsByName[name]?.id; if (id && !/shulker_box$/.test(name)) await box.deposit(id, null, n).catch(() => {}) } ok = true } finally { box.close() }
  } finally {
    await skills.breakBlockAt(b, pos.x, pos.y, pos.z) // the box keeps its contents when broken
    await skills.pickupNearbyItems(b)
    delete mem(b._wbCfg?.() || {}).containers?.[key(pos)]
  }
  return ok
}

// ---------- bundles (experimental) ----------
// Put small odd stacks into a bundle (pick the stack up, right-click it onto the bundle). A bundle holds 64 "weight":
// that's one full stack, or many small ones. Checks that slots were really freed, and gives up if clicks don't work.
export async function packIntoBundle(b, st = {}) {
  if (st.bundleBroken) return 'bundles do not seem to work on this server'
  const bundle = b.inventory.items().find(i => /(^|_)bundle$/.test(i.name))
  if (!bundle) return 'no bundle'
  const small = b.inventory.items().filter(i => i !== bundle && i.count <= 8 && !GEAR.test(i.name) && !/shulker_box$|bundle$/.test(i.name) && i.stackSize >= 16)
    .sort((x, y) => x.count - y.count).slice(0, 6)
  if (!small.length) return 'nothing small to put in the bundle'
  const before = b.inventory.emptySlotCount()
  for (const it of small) {
    try {
      await b.clickWindow(it.slot, 0, 0)        // pick up the stack
      await b.clickWindow(bundle.slot, 1, 0)    // right-click onto the bundle: puts it inside
      if (b.inventory.selectedItem || b.currentWindow?.selectedItem) await b.clickWindow(it.slot, 0, 0) // put back what didn't fit
    } catch { break }
    await new Promise(r => setTimeout(r, 250))
  }
  const freed = b.inventory.emptySlotCount() - before
  if (freed <= 0) { st.bundleBroken = true; return 'could not fill the bundle (server or version does not accept it), will not try again' }
  return `put ${freed} small stacks into the bundle`
}

// ---------- inventory cleanup ----------
// keep at least a few free slots: store or drop junk, pack bulk into a shulker if there is one
export async function tidyInventory(b, cfg, home) {
  if (b.inventory.emptySlotCount() > 5) return 'inventory is fine'
  const out = []
  const junk = junkExtra(b)
  const storage = findStorage(b, cfg, home, { enderOk: false })
  if (storage && storage.position.distanceTo(b.entity.position) < 24 && Object.keys(junk).length) { out.push(`stored ${await depositInto(b, storage, junk)} junk items in the ${storage.name}`) }
  else if (Object.keys(junk).length) {
    for (const [name, n] of Object.entries(junk)) await skills.discard(b, name, n).catch(() => {})
    out.push('dropped junk: ' + fmt(junk))
  }
  if (b.inventory.emptySlotCount() <= 4 && b.inventory.items().some(i => /(^|_)bundle$/.test(i.name))) out.push(await packIntoBundle(b, b._wbState || {}))
  if (b.inventory.emptySlotCount() <= 3 && hasShulker(b)) {
    const bulk = {}; for (const i of b.inventory.items()) if (!GEAR.test(i.name) && !b.registry.foodsByName[i.name] && !/shulker_box$/.test(i.name)) bulk[i.name] = (bulk[i.name] || 0) + i.count
    if (await packIntoShulker(b, bulk)) out.push('packed bulk items into a shulker box')
  }
  out.push(`${b.inventory.emptySlotCount()} free slots now`)
  return out.join('. ')
}
