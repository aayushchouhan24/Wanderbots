// Schematics: load .litematic / .schem / .nbt (also inside .zip), list materials, and build them.
// Two build modes:
//  - survival: place blocks by hand from the inventory (reports missing materials). Facing of stairs etc. is best-effort.
//  - commands: /setblock and /fill, exact and fast. Needs the bot to be op (or have those commands).
import nbt from 'prismarine-nbt'
import { unzipSync } from 'fflate'
import { Vec3 } from 'vec3'
import * as skills from './mc/skills.js'

const wait = ms => new Promise(r => setTimeout(r, ms))
const dbg = (...a) => { if (process.env.WB_DEBUG) console.log('[build]', ...a) }
const AIR = new Set(['air', 'cave_air', 'void_air', 'structure_void'])
const KEEP = /crafting_table|chest|furnace|_bed$|_door$/ // don't break these while clearing

// ---------- parsing ----------
const strip = n => String(n).replace(/^minecraft:/, '')
const stateKey = (name, props) => { const p = Object.entries(props || {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(','); return strip(name) + (p ? `[${p}]` : '') }
export const splitState = s => { const m = String(s).match(/^([^[]+)(?:\[(.*)\])?$/); return { name: m[1], props: Object.fromEntries((m[2] || '').split(',').filter(Boolean).map(kv => kv.split('='))) } }
const long64 = v => Array.isArray(v) ? BigInt.asUintN(64, (BigInt(v[0]) << 32n) | BigInt(v[1] >>> 0)) : BigInt.asUintN(64, BigInt(v))

function fromLitematic(root) {
  const regions = Object.values(root.Regions || {})
  if (!regions.length) throw new Error('litematic has no regions')
  const cells = [], palette = [], index = new Map()
  const pid = key => { if (!index.has(key)) { index.set(key, palette.length); palette.push(key) } return index.get(key) }
  for (const r of regions) {
    const pos = r.Position, size = r.Size
    const sx = Math.abs(size.x), sy = Math.abs(size.y), sz = Math.abs(size.z)
    const min = { x: pos.x + (size.x < 0 ? size.x + 1 : 0), y: pos.y + (size.y < 0 ? size.y + 1 : 0), z: pos.z + (size.z < 0 ? size.z + 1 : 0) }
    const pal = r.BlockStatePalette.map(p => stateKey(p.Name, p.Properties))
    const bits = BigInt(Math.max(2, Math.ceil(Math.log2(pal.length))))
    const mask = (1n << bits) - 1n, longs = r.BlockStates.map(long64)
    const total = sx * sy * sz
    for (let i = 0; i < total; i++) {
      const bit = BigInt(i) * bits, li = Number(bit / 64n), off = bit % 64n
      let v = longs[li] >> off
      if (off + bits > 64n) v |= longs[li + 1] << (64n - off)
      const key = pal[Number(v & mask)]
      if (!key || AIR.has(splitState(key).name)) continue
      const x = i % sx, z = Math.floor(i / sx) % sz, y = Math.floor(i / (sx * sz))
      cells.push([min.x + x, min.y + y, min.z + z, pid(key)])
    }
  }
  return normalize(cells, palette)
}

function fromSponge(root) {
  const s = root.Schematic || root // v3 wraps everything in "Schematic"
  const w = s.Width, h = s.Height, l = s.Length
  const palObj = s.Blocks?.Palette || s.Palette, data = s.Blocks?.Data || s.BlockData
  if (!palObj || !data) throw new Error('schem file has no block palette')
  const pal = []; for (const [k, i] of Object.entries(palObj)) pal[i] = stateKey(splitState(strip(k)).name, splitState(strip(k)).props)
  const cells = [], palette = [], index = new Map()
  const pid = key => { if (!index.has(key)) { index.set(key, palette.length); palette.push(key) } return index.get(key) }
  let i = 0, p = 0
  const bytes = data.map(b => b & 0xff)
  while (p < bytes.length) {
    let v = 0, shift = 0, b
    do { b = bytes[p++]; v |= (b & 0x7f) << shift; shift += 7 } while (b & 0x80)
    const key = pal[v]
    if (key && !AIR.has(splitState(key).name)) cells.push([i % w, Math.floor(i / (w * l)), Math.floor(i / w) % l, pid(key)])
    i++
  }
  return normalize(cells, palette)
}

function fromStructure(root) {
  const pals = root.palette || root.palettes?.[0]
  if (!pals || !root.blocks) throw new Error('structure file has no blocks')
  const pal = pals.map(p => stateKey(p.Name, p.Properties))
  const cells = [], palette = [], index = new Map()
  const pid = key => { if (!index.has(key)) { index.set(key, palette.length); palette.push(key) } return index.get(key) }
  for (const bl of root.blocks) { const key = pal[bl.state]; if (key && !AIR.has(splitState(key).name)) cells.push([bl.pos[0], bl.pos[1], bl.pos[2], pid(key)]) }
  return normalize(cells, palette)
}

// shift so the minimum corner is 0,0,0 and compute size
function normalize(cells, palette) {
  if (!cells.length) throw new Error('the schematic is empty')
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const c of cells) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], c[k]); max[k] = Math.max(max[k], c[k]) }
  for (const c of cells) for (let k = 0; k < 3; k++) c[k] -= min[k]
  return { palette, cells, size: { x: max[0] - min[0] + 1, y: max[1] - min[1] + 1, z: max[2] - min[2] + 1 } }
}

const EXT = /\.(litematic|schem|nbt|schematic)$/i
// buf: file contents (zip or schematic). Returns { name, format, size, palette, cells, materials }
export async function parseSchematic(filename, buf) {
  let name = filename, data = Buffer.from(buf)
  if (/\.zip$/i.test(filename) || (data[0] === 0x50 && data[1] === 0x4b)) {
    const files = unzipSync(new Uint8Array(data))
    const entry = Object.keys(files).filter(f => EXT.test(f) && !/__MACOSX/.test(f)).sort((a, b) => files[b].length - files[a].length)[0]
    if (!entry) throw new Error('no .litematic, .schem or .nbt file inside the zip')
    name = entry.split('/').pop(); data = Buffer.from(files[entry])
  }
  if (/\.schematic$/i.test(name)) throw new Error('old MCEdit .schematic files (before 1.13) are not supported: open it in Litematica or WorldEdit and save as .litematic or .schem')
  const { parsed } = await nbt.parse(data)
  const root = nbt.simplify(parsed)
  const format = /\.litematic$/i.test(name) || root.Regions ? 'litematic' : root.blocks && (root.palette || root.palettes) ? 'structure' : 'schem'
  const s = format === 'litematic' ? fromLitematic(root) : format === 'structure' ? fromStructure(root) : fromSponge(root)
  const clean = name.replace(EXT, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'schematic'
  return { name: clean, format, file: name, ...s, materials: materials(s) }
}

// ---------- materials ----------
const NO_ITEM = /^(water|lava|fire|soul_fire|bubble_column|piston_head|moving_piston|nether_portal|end_portal|end_gateway|frosted_ice|light|barrier|structure_block|jigsaw|command_block|.*_cauldron|big_dripleaf_stem|tall_seagrass)$/
export function itemFor(state) {
  const { name: n, props } = splitState(state)
  if (NO_ITEM.test(n)) return null
  if ((n.endsWith('_bed') && props.part === 'head') || (/_door$|^tall_grass$|^large_fern$|^sunflower$|^lilac$|^rose_bush$|^peony$|^pitcher_plant$/.test(n) && props.half === 'upper')) return null // other half of a 2-block thing
  const map = { wall_torch: 'torch', soul_wall_torch: 'soul_torch', redstone_wall_torch: 'redstone_torch', redstone_wire: 'redstone', tripwire: 'string', cocoa: 'cocoa_beans',
    carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds', wheat: 'wheat_seeds', melon_stem: 'melon_seeds', pumpkin_stem: 'pumpkin_seeds', attached_melon_stem: 'melon_seeds',
    attached_pumpkin_stem: 'pumpkin_seeds', sweet_berry_bush: 'sweet_berries', bamboo_sapling: 'bamboo', kelp_plant: 'kelp', cave_vines: 'glow_berries', cave_vines_plant: 'glow_berries', grass_path: 'dirt', dirt_path: 'dirt', farmland: 'dirt' }
  if (map[n]) return map[n]
  if (n.startsWith('potted_')) return 'flower_pot'
  return n.replace(/_wall_(sign|hanging_sign|banner|head|skull|fan)$/, '_$1').replace(/^(.*)_wall_torch$/, '$1_torch')
}
function materials(s) {
  const m = {}
  for (const c of s.cells) {
    const st = s.palette[c[3]], it = itemFor(st)
    if (!it) continue
    m[it] = (m[it] || 0) + (/_slab$/.test(splitState(st).name) && splitState(st).props.type === 'double' ? 2 : 1)
  }
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]))
}

// ---------- rotation ----------
const FACE = ['north', 'east', 'south', 'west']
function rotateState(state, rot) {
  if (!rot) return state
  const { name, props } = splitState(state)
  const p = { ...props }
  if (FACE.includes(p.facing)) p.facing = FACE[(FACE.indexOf(p.facing) + rot) % 4]
  if (p.axis && rot % 2) p.axis = p.axis === 'x' ? 'z' : p.axis === 'z' ? 'x' : p.axis
  if (p.rotation !== undefined) p.rotation = String((+p.rotation + rot * 4) % 16)
  if (rot % 2 && ('north' in p || 'east' in p)) { const n = p.north, e = p.east, s = p.south, w = p.west; const f = [n, e, s, w]; [p.north, p.east, p.south, p.west] = [f[(4 - rot) % 4], f[(5 - rot) % 4], f[(6 - rot) % 4], f[(7 - rot) % 4]] }
  else if (rot === 2 && ('north' in p)) { [p.north, p.south, p.east, p.west] = [p.south, p.north, p.west, p.east] }
  return stateKey(name, p)
}
function rotatePos(x, z, rot, size) {
  if (rot === 1) return [size.z - 1 - z, x]
  if (rot === 2) return [size.x - 1 - x, size.z - 1 - z]
  if (rot === 3) return [z, size.x - 1 - x]
  return [x, z]
}

// blocks that hang on others: place after everything solid
const ATTACHED = /torch|button|lever|ladder|_sign$|_banner$|carpet|rail|redstone_wire|tripwire|_pressure_plate|vine|flower_pot|potted_|_door$|trapdoor|lantern|_head$|_skull$|item_frame|painting|snow$|_bed$|seagrass|kelp|coral_fan|^(short_|tall_)?grass$|fern|flower|sapling|mushroom|dandelion|poppy|tulip|orchid|allium|bluet|daisy|cornflower|lily|berry|bamboo|sugar_cane|cactus|candle/
export function plan(s, origin, rot = 0) {
  const out = []
  for (const [x, y, z, p] of s.cells) {
    const [rx, rz] = rotatePos(x, z, rot, s.size)
    const state = rotateState(s.palette[p], rot)
    out.push({ pos: new Vec3(origin.x + rx, origin.y + y, origin.z + rz), state, late: ATTACHED.test(splitState(state).name) })
  }
  return out.sort((a, b) => (a.late - b.late) || (a.pos.y - b.pos.y) || (a.pos.x - b.pos.x) || (a.pos.z - b.pos.z))
}

const matches = (block, state) => block && strip(block.name) === splitState(state).name

// ---------- building ----------
// job: { schem, origin, rot, mode, done }  -> places up to `max` blocks, returns a report and updates job.done
export async function buildStep(b, s, job, { max = 60, shouldStop = () => false } = {}) {
  const steps = plan(s, job.origin, job.rot)
  if (job.mode === 'commands') return buildWithCommands(b, steps, job, { max: max * 4, shouldStop })
  const have = () => { const m = {}; for (const i of b.inventory.items()) m[i.name] = (m[i.name] || 0) + i.count; return m }
  let placed = 0, missing = {}, remaining = 0
  for (const st of steps) {
    if (shouldStop() || b.interrupt_code || placed >= max) { if (!placed && remaining < 3) dbg('skip: stop', shouldStop(), b.interrupt_code, placed); remaining++; continue }
    if (!b.entity) { remaining++; continue } // disconnected: nothing is known
    const cur = b.blockAt(st.pos)
    if (!cur) { remaining++; continue } // chunk not loaded yet: still to do
    if (matches(cur, st.state)) continue
    const item = itemFor(st.state)
    if (!item) continue
    remaining++
    if (!(have()[item] > 0)) { missing[item] = (missing[item] || 0) + 1; continue }
    if (!AIR.has(cur.name) && !/water|lava/.test(cur.name) && !KEEP.test(cur.name)) await skills.breakBlockAt(b, st.pos.x, st.pos.y, st.pos.z).catch(() => {})
    const { props } = splitState(st.state)
    const on = props.type === 'top' || props.half === 'top' ? 'top' : 'bottom'
    const ok = await skills.placeBlock(b, item, st.pos.x, st.pos.y, st.pos.z, on).catch(e => { dbg('place threw', e.message); return false })
    if (ok) { placed++; remaining-- } else if (remaining < 6) dbg('place failed', item, String(st.pos), 'was', cur.name, '| output:', (b.output || '').slice(-200))
  }
  job.placed = (job.placed || 0) + placed
  const miss = Object.entries(missing).sort((a, b) => b[1] - a[1])
  job.missing = Object.fromEntries(miss)
  const done = remaining === 0
  return { placed, remaining, done, missing: job.missing,
    report: `${job.schem}: placed ${placed} this step, ${done ? 'finished!' : `${remaining} blocks to go`}${miss.length ? '. Missing: ' + miss.slice(0, 8).map(([k, v]) => `${v} ${k}`).join(', ') : ''}` }
}

// /setblock and /fill (rows of the same block along x), throttled so the server doesn't kick for spam
async function buildWithCommands(b, steps, job, { max, shouldStop }) {
  let denied = null
  const onMsg = m => { if (/unknown or incomplete command|do not have permission|you don't have permission|not allowed/i.test(m)) denied = m }
  b.on('messagestr', onMsg)
  let sent = 0, done = true
  try {
    // group consecutive identical states along x
    const todo = steps.filter(st => !matches(b.blockAt(st.pos), st.state) || b.blockAt(st.pos) === null)
    for (let i = 0; i < todo.length;) {
      if (shouldStop() || b.interrupt_code || sent >= max) { done = false; break }
      if (denied) throw new Error(`the server refused the build command ("${denied.slice(0, 80)}"). Make the bot op (/op ${b.username}) or use survival mode.`)
      let j = i
      while (j + 1 < todo.length && todo[j + 1].state === todo[i].state && todo[j + 1].pos.y === todo[i].pos.y && todo[j + 1].pos.z === todo[i].pos.z && todo[j + 1].pos.x === todo[j].pos.x + 1) j++
      const a = todo[i].pos, z = todo[j].pos
      b.chat(i === j ? `/setblock ${a.x} ${a.y} ${a.z} minecraft:${todo[i].state}` : `/fill ${a.x} ${a.y} ${a.z} ${z.x} ${z.y} ${z.z} minecraft:${todo[i].state}`)
      sent++; i = j + 1
      await wait(130) // ~8 commands a second
    }
    await wait(800)
    if (denied) throw new Error(`the server refused the build command ("${denied.slice(0, 80)}"). Make the bot op (/op ${b.username}) or use survival mode.`)
  } finally { b.removeListener('messagestr', onMsg) }
  const left = b.entity ? steps.filter(st => !matches(b.blockAt(st.pos), st.state)).length : steps.length // unknown counts as not done
  job.placed = (job.placed || 0) + sent
  return { placed: sent, remaining: left, done: done && left === 0, missing: {}, report: `${job.schem}: sent ${sent} build commands, ${left ? `${left} blocks not matching yet` : 'finished!'}` }
}
