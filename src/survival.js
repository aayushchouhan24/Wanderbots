// Survival mode: play the early game like a player.
// Each call looks at the inventory and the base, picks the first unmet goal and does one step:
//   food -> crafting table -> wooden pickaxe -> stone tools -> chest -> shelter -> torch -> store loot -> keep gathering
// It is stateless (re-planned every tick), so it picks up where it left off after a restart.
import pf from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { save } from './store.js'

const { goals, Movements } = pf
const wait = ms => new Promise(r => setTimeout(r, ms))
// walk to a goal, giving up after `ms` so one bad path can't freeze the bot
function goto(b, goal, ms = 25000) {
  let t
  return Promise.race([b.pathfinder.goto(goal), new Promise((_, no) => { t = setTimeout(() => { b.pathfinder.stop(); no(new Error('could not get there in time')) }, ms) })]).finally(() => clearTimeout(t))
}
const ANIMALS = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'mooshroom'])
const JUNK = /^(dirt|gravel|sand|cobbled_deepslate|andesite|diorite|granite|tuff|netherrack|rotten_flesh|.*_seeds|.*_sapling|poppy|dandelion|stick|flint|bone|string|feather|leather|apple|.*wool)$/
const KEEP_COBBLE = 32

// base layout around the centre (dx, dz): table, chest and torch inside a 5x5 hut
const TABLE = [-1, -1], CHEST = [-1, 1], TORCH = [1, 1]
const RING = [], ROOF = []
for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
  if (Math.abs(dx) === 2 || Math.abs(dz) === 2) for (let dy = 0; dy < 3; dy++) if (!(dx === 0 && dz === -2 && dy < 2)) RING.push([dx, dy, dz]) // door on -z side
  ROOF.push([dx, 3, dz])
}
ROOF.sort((a, b) => Math.max(Math.abs(b[0]), Math.abs(b[2])) - Math.max(Math.abs(a[0]), Math.abs(a[2]))) // outside in, so each has a neighbour to stick to
const SHELTER = [...RING, ...ROOF]

const count = (b, test) => b.inventory.items().filter(i => typeof test === 'string' ? i.name === test : test.test(i.name)).reduce((n, i) => n + i.count, 0)
const has = (b, name) => count(b, name) > 0
const id = (b, name) => b.registry.itemsByName[name]?.id
const at = (base, [dx, dy, dz]) => new Vec3(base.x + dx, base.y + dy, base.z + dz)
const air = bl => !bl || bl.name === 'air' || bl.name === 'cave_air' || bl.boundingBox === 'empty'

// survival movements: may dig and pillar, but never inside its own base or through chests/tables
export function survivalMoves(b, base) {
  const m = new Movements(b)
  m.canDig = true; m.allow1by1towers = true; m.allowSprinting = false
  for (const n of ['crafting_table', 'chest', 'furnace', 'torch']) if (b.registry.blocksByName[n]) m.blocksCantBreak.add(b.registry.blocksByName[n].id)
  if (base) m.exclusionAreasBreak = [bl => Math.abs(bl.position.x - base.x) <= 2 && Math.abs(bl.position.z - base.z) <= 2 && bl.position.y >= base.y - 1 && bl.position.y <= base.y + 3 ? Infinity : 0]
  return m
}

async function equipFor(b, block) {
  const best = { pickaxe: /_pickaxe$/, axe: /_axe$/, shovel: /_shovel$/ }
  const want = /_log$|planks|wood/.test(block.name) ? 'axe' : /dirt|grass|sand|gravel/.test(block.name) ? 'shovel' : 'pickaxe'
  const tools = b.inventory.items().filter(i => best[want].test(i.name)).sort((x, y) => (y.name.startsWith('stone') ? 2 : 1) - (x.name.startsWith('stone') ? 2 : 1))
  if (tools[0]) await b.equip(tools[0], 'hand')
}

async function collectNear(b, pos) {
  await wait(350)
  for (let i = 0; i < 3; i++) {
    const it = b.nearestEntity(x => x.name === 'item' && x.position.distanceTo(pos) < 5)
    if (!it) return
    await goto(b, new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.5)).catch(() => {})
    await wait(200)
  }
}

// dig the nearest block matching `test`, walk over its drops
async function gather(b, st, test, what) {
  const bl = b.findBlock({ matching: x => test(x.name), maxDistance: 40 })
  if (!bl) { st.task = `survival: no ${what} nearby, exploring`; await explore(b); return }
  await goto(b, new goals.GoalLookAtBlock(bl.position, b.world, { reach: 4 }))
  await equipFor(b, bl)
  await b.dig(b.blockAt(bl.position), true)
  st.count('mined')
  await collectNear(b, bl.position)
}

async function explore(b) {
  const p = b.entity.position, a = Math.random() * Math.PI * 2
  await goto(b, new goals.GoalNearXZ(p.x + Math.cos(a) * 30, p.z + Math.sin(a) * 30, 3)).catch(() => {})
}

async function planks(b, n) {
  while (count(b, /_planks$/) < n && count(b, /_log$/) > 0) {
    const log = b.inventory.items().find(i => /_log$/.test(i.name))
    const r = b.recipesFor(id(b, log.name.replace(/^stripped_/, '').replace(/_log$/, '_planks')), null, 1, null)[0]
    if (!r) return
    await b.craft(r, 1, null)
  }
}

async function craft(b, st, name, n = 1, base) {
  const item = id(b, name); if (!item) return false
  let table = null
  let r = b.recipesFor(item, null, 1, null)[0]
  if (!r) {
    table = b.findBlock({ matching: id(b, 'crafting_table') ? b.registry.blocksByName.crafting_table.id : -1, maxDistance: 24 })
    if (!table) return false
    r = b.recipesFor(item, null, 1, table)[0]
    if (!r) return false
    await goto(b, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 3))
  }
  await b.craft(r, n, table)
  st.count('crafted'); return true
}

// place an item from the inventory at a target position (needs a solid neighbour)
async function placeAt(b, name, pos) {
  if (!air(b.blockAt(pos))) return true
  const item = b.inventory.items().find(i => typeof name === 'string' ? i.name === name : name.test(i.name))
  if (!item) return false
  for (const f of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    const ref = b.blockAt(pos.offset(...f))
    if (ref && !air(ref) && ref.boundingBox === 'block') {
      if (b.entity.position.distanceTo(pos) > 4) await goto(b, new goals.GoalNear(pos.x, pos.y, pos.z, 3)).catch(() => {})
      await b.equip(item, 'hand')
      try { await b.placeBlock(ref, pos.minus(ref.position)) } catch (e) { if (air(b.blockAt(pos))) throw new Error(`can't place ${item.name} at ${pos}: ${e.message}`) }
      await wait(150)
      return !air(b.blockAt(pos))
    }
  }
  return false
}

// place something inside the base, trying the preferred spot first, then the other inside spots
async function placeInBase(b, name, home, pref) {
  let last
  for (const [dx, dz] of [pref, [1, -1], [-1, 0], [1, 0], [0, 1], [-1, -1], [-1, 1], [1, 1]]) {
    if (dx === 0 && dz === 0) continue
    try { if (await placeAt(b, name, at(home, [dx, 0, dz]))) return true } catch (e) { last = e }
  }
  throw last || new Error('no room for ' + name)
}

const nearBase = (b, base, blockName) => b.findBlock({ point: new Vec3(base.x, base.y, base.z), matching: b.registry.blocksByName[blockName]?.id ?? -1, maxDistance: 6 })

// one step of survival play. Returns a promise (caller marks the bot busy while it runs).
export async function survive(b, st, cfg, c, home) {
  // base: its saved place/spot, or where it is now
  if (!home) { const p = b.entity.position.floored(); home = cfg.spot = { x: p.x, y: p.y, z: p.z, label: 'base' }; save() }
  if (!st.survMoves) { b.pathfinder.setMovements(survivalMoves(b, home)); st.survMoves = true }
  const task = t => { st.task = 'survival: ' + t }

  // food: hunt an animal if hungry with nothing to eat
  if (b.food < 12 && !b.inventory.items().some(i => b.registry.foodsByName[i.name])) {
    const prey = b.nearestEntity(x => ANIMALS.has(x.name) && x.position.distanceTo(b.entity.position) < 32)
    if (prey) {
      task('hunting ' + prey.name)
      const sword = b.inventory.items().find(i => /_sword$|_axe$/.test(i.name)); if (sword) await b.equip(sword, 'hand')
      for (let i = 0; i < 20 && prey.isValid; i++) {
        if (prey.position.distanceTo(b.entity.position) > 3) await goto(b, new goals.GoalFollow(prey, 2)).catch(() => {})
        await b.lookAt(prey.position.offset(0, prey.height / 2, 0), true); b.attack(prey); await wait(650)
      }
      st.count('kills'); return collectNear(b, prey.position)
    }
  }

  const logs = count(b, /_log$/), plank = count(b, /_planks$/), cobble = count(b, 'cobblestone')
  const pick = has(b, 'stone_pickaxe') || has(b, 'iron_pickaxe') || has(b, 'diamond_pickaxe') ? 2 : has(b, 'wooden_pickaxe') ? 1 : 0
  const isLog = n => /_log$/.test(n) && !n.startsWith('stripped'), isStone = n => n === 'stone' || n === 'cobblestone' || n === 'deepslate'

  // crafting table at the base
  const table = nearBase(b, home, 'crafting_table')
  if (!table) {
    if (!has(b, 'crafting_table')) {
      if (plank + logs * 4 < 4) { task(`chopping wood (${logs}/2 logs)`); return gather(b, st, isLog, 'trees') }
      task('crafting a crafting table'); await planks(b, 4); return craft(b, st, 'crafting_table')
    }
    task('placing crafting table'); return placeInBase(b, 'crafting_table', home, TABLE)
  }

  // tools
  if (pick === 0) {
    if (plank + logs * 4 < 5) { task(`chopping wood for tools (${logs} logs)`); return gather(b, st, isLog, 'trees') }
    task('crafting a wooden pickaxe'); await planks(b, 5); if (count(b, 'stick') < 2) await craft(b, st, 'stick'); return craft(b, st, 'wooden_pickaxe')
  }
  for (const [tool, need] of [['stone_pickaxe', 3], ['stone_sword', 2], ['stone_axe', 3]]) {
    if (has(b, tool) || (tool !== 'stone_pickaxe' && pick < 2)) continue
    if (cobble < need) { task(`mining stone for ${tool.replace('_', ' ')} (${cobble}/${need})`); return gather(b, st, isStone, 'stone') }
    if (count(b, 'stick') < 2) { await planks(b, 2); await craft(b, st, 'stick') }
    task('crafting ' + tool.replace('_', ' ')); return craft(b, st, tool)
  }

  // storage chest at the base
  const chest = nearBase(b, home, 'chest')
  if (!chest) {
    if (!has(b, 'chest')) {
      if (plank + logs * 4 < 8) { task(`chopping wood for a chest (${plank + logs * 4}/8 planks)`); return gather(b, st, isLog, 'trees') }
      task('crafting a chest'); await planks(b, 8); return craft(b, st, 'chest')
    }
    task('placing the chest'); return placeInBase(b, 'chest', home, CHEST)
  }

  // shelter: 5x5 hut with a door and a roof
  st.badCells ||= new Set()
  const todo = SHELTER.filter(o => !st.badCells.has(o.join()) && air(b.blockAt(at(home, o))))
  if (todo.length) {
    const blocks = count(b, 'cobblestone') + count(b, /_planks$/)
    if (blocks < Math.min(todo.length, 16)) { task(`gathering blocks for the shelter (${blocks}/${Math.min(todo.length, 16)})`); return gather(b, st, isStone, 'stone') }
    task(`building the shelter (${SHELTER.length - todo.length}/${SHELTER.length})`)
    await goto(b, new goals.GoalBlock(home.x, home.y, home.z)).catch(() => {})
    for (const o of todo.slice(0, 8)) {
      const pos = at(home, o)
      if (pos.floored().equals(b.entity.position.floored()) || pos.floored().equals(b.entity.position.floored().offset(0, 1, 0))) continue
      try { if (await placeAt(b, /^cobblestone$|_planks$/, pos)) st.count('placed') } catch { st.badCells.add(o.join()) } // skip cells it can't fill
    }
    return
  }

  // torch inside, if it found coal
  const torchPos = at(home, [TORCH[0], 0, TORCH[1]])
  if (air(b.blockAt(torchPos)) && b.blockAt(torchPos.offset(0, -1, 0))?.boundingBox === 'block') {
    if (!has(b, 'torch') && (has(b, 'coal') || has(b, 'charcoal'))) { if (count(b, 'stick') < 1) { await planks(b, 2); await craft(b, st, 'stick') } task('crafting torches'); return craft(b, st, 'torch') }
    if (has(b, 'torch')) { task('placing a torch'); return placeAt(b, 'torch', torchPos) }
  }

  // store loot in the chest
  const extra = b.inventory.items().filter(i => JUNK.test(i.name) || (i.name === 'cobblestone' && count(b, 'cobblestone') > KEEP_COBBLE) || /_ore$|^raw_|coal$|_ingot$/.test(i.name))
  if (extra.length && b.inventory.emptySlotCount() < 12) {
    task('storing items in the chest')
    await goto(b, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2))
    const box = await b.openContainer(chest)
    for (const i of extra) await box.deposit(i.type, null, i.name === 'cobblestone' ? i.count - KEEP_COBBLE : i.count).catch(() => {})
    box.close(); st.count('stored'); return
  }

  // keep busy: stock up on wood and stone, then hang around the base
  if (logs < 16) { task(`gathering wood (${logs}/16)`); return gather(b, st, isLog, 'trees') }
  if (cobble < KEEP_COBBLE) { task(`mining stone (${cobble}/${KEEP_COBBLE})`); return gather(b, st, isStone, 'stone') }
  task('base done, hanging out'); return 'idle'
}
