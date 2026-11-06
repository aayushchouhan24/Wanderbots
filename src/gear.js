// Gear upgrade: turn valuable materials into the best tools and armor and wear them.
// Takes only what it needs from a nearby chest, turns storage blocks into ingots/diamonds (1 block = 9),
// crafts diamond gear first, then iron for anything still missing, equips it all, and puts leftovers back.
import * as skills from './mc/skills.js'
import * as world from './mc/world.js'

const TIERS = [
  { mat: 'diamond', item: 'diamond', block: 'diamond_block' },
  { mat: 'iron', item: 'iron_ingot', block: 'iron_block' },
]
const PIECES = [['sword', 2, 1], ['pickaxe', 3, 2], ['axe', 3, 2], ['shovel', 1, 2], ['chestplate', 8, 0], ['leggings', 7, 0], ['helmet', 5, 0], ['boots', 4, 0]] // [type, material, sticks]
const ARMOR_SLOT = { helmet: 5, chestplate: 6, leggings: 7, boots: 8 }
const RANK = n => !n ? 0 : n.startsWith('netherite') ? 5 : n.startsWith('diamond') ? 4 : n.startsWith('iron') ? 3 : n.startsWith('chainmail') ? 2.5 : n.startsWith('copper') ? 2.2 : n.startsWith('stone') ? 2 : n.startsWith('golden') ? 1.5 : 1
const JUNK = /^(dirt|grass_block|short_grass|tall_grass|fern|vine|wheat_seeds|.*_seeds|gravel|sand|andesite|diorite|granite|tuff|cobbled_deepslate|rotten_flesh|.*_sapling|leaf_litter|.*_leaves|bamboo|feather|bricks|egg|brown_egg|bone|string)$/
export const VALUABLE = /^(diamond|iron_ingot|gold_ingot|netherite_ingot|diamond_block|iron_block|gold_block|netherite_block)$/

const inv = b => world.getInventoryCounts(b)
const current = (b, type) => ARMOR_SLOT[type] ? b.inventory.slots[ARMOR_SLOT[type]]?.name : Object.keys(inv(b)).filter(n => n.endsWith('_' + type)).sort((x, y) => RANK(y) - RANK(x))[0]
const units = (have, t) => (have[t.item] || 0) + 9 * (have[t.block] || 0)

// pieces still worth making with this tier, and the material they need
function plan(b, t) {
  const list = PIECES.filter(([type]) => RANK(current(b, type)) < RANK(t.mat))
  return { list, material: list.reduce((n, p) => n + p[1], 0), sticks: list.reduce((n, p) => n + p[2], 0) }
}

export function canUpgrade(b) {
  const have = inv(b)
  return TIERS.some(t => { const p = plan(b, t); return p.list.some(([, cost]) => units(have, t) >= cost) })
}

async function withChest(b, fn) {
  const chest = world.getNearestBlock(b, 'chest', 16)
  if (!chest) return false
  await skills.goToPosition(b, chest.position.x, chest.position.y, chest.position.z, 2)
  const box = await b.openContainer(chest)
  try { await fn(box) } finally { box.close() }
  return true
}

export async function upgradeGear(b) {
  const out = []
  // 1. make room and take exactly what's needed (materials for the missing pieces, wood for sticks)
  await withChest(b, async box => {
    for (const i of b.inventory.items()) if (JUNK.test(i.name)) await box.deposit(i.type, null, i.count).catch(() => {})
    for (const t of TIERS) {
      const p = plan(b, t), have = units(inv(b), t), need = p.material - have
      if (!p.list.length || need <= 0) continue
      for (const name of [t.item, t.block]) { // loose items first, then blocks
        const left = p.material - units(inv(b), t)
        if (left <= 0) break
        const inBox = box.containerItems().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
        const take = Math.min(inBox, name === t.block ? Math.ceil(left / 9) : left)
        if (take > 0 && b.inventory.emptySlotCount() > 2) await box.withdraw(b.registry.itemsByName[name].id, null, take).then(() => out.push(`took ${take} ${name}`), () => {})
      }
    }
    const wood = Object.keys(inv(b)).some(n => /_planks$|_log$/.test(n)) || (inv(b).stick || 0) >= 8
    if (!wood) {
      const w = box.containerItems().find(i => /_planks$|_log$/.test(i.name))
      if (w) await box.withdraw(w.type, null, Math.min(w.count, 4)).catch(() => {})
    }
  }).catch(e => out.push('chest problem: ' + e.message))

  // 2. storage blocks -> items, only as many as needed
  for (const t of TIERS) {
    const p = plan(b, t), have = inv(b)
    const short = p.material - (have[t.item] || 0)
    if (p.list.length && short > 0 && have[t.block]) await skills.craftRecipe(b, t.item, Math.min(have[t.block], Math.ceil(short / 9)))
  }
  // 3. sticks
  const sticksNeeded = Math.max(plan(b, TIERS[0]).sticks, plan(b, TIERS[1]).sticks)
  if ((inv(b).stick || 0) < sticksNeeded) {
    if (!Object.keys(inv(b)).some(n => n.endsWith('_planks'))) {
      const log = Object.keys(inv(b)).find(n => n.endsWith('_log'))
      if (log) await skills.craftRecipe(b, log.replace(/^stripped_/, '').replace(/_log$/, '_planks'), 1)
    }
    if (Object.keys(inv(b)).some(n => n.endsWith('_planks'))) await skills.craftRecipe(b, 'stick', Math.ceil((sticksNeeded - (inv(b).stick || 0)) / 4))
    if ((inv(b).stick || 0) < 1) out.push('no wood for sticks, so no tools yet (armor still works)')
  }
  // 4. craft the best gear per slot: diamond first, then iron
  const made = []
  for (const t of TIERS) {
    for (const [type, cost, sticks] of PIECES) {
      if (RANK(current(b, type)) >= RANK(t.mat)) continue
      const have = inv(b)
      if ((have[t.item] || 0) < cost || (have.stick || 0) < sticks) continue
      if (b.inventory.emptySlotCount() < 1) { out.push('inventory full'); break }
      if (await skills.craftRecipe(b, `${t.mat}_${type}`, 1)) made.push(`${t.mat}_${type}`)
    }
  }
  if (made.length) out.push('crafted ' + made.join(', '))
  // 5. wear and hold the best
  for (const type of Object.keys(ARMOR_SLOT)) {
    const piece = Object.keys(inv(b)).filter(n => n.endsWith('_' + type)).sort((x, y) => RANK(y) - RANK(x))[0]
    if (piece && RANK(piece) > RANK(b.inventory.slots[ARMOR_SLOT[type]]?.name)) await skills.equip(b, piece)
  }
  const sword = current(b, 'sword'); if (sword) await skills.equip(b, sword)
  // 6. put leftover storage blocks back, keep a little
  await withChest(b, async box => {
    for (const t of TIERS) { const n = inv(b)[t.block] || 0; if (n > 1) await box.deposit(b.registry.itemsByName[t.block].id, null, n - 1).catch(() => {}) }
  }).catch(() => {})
  const worn = Object.values(ARMOR_SLOT).map(s => b.inventory.slots[s]?.name).filter(Boolean)
  out.push(`wearing ${worn.join(', ') || 'no armor'}; holding ${b.heldItem?.name || 'nothing'}`)
  const msg = out.join('. ')
  skills.log(b, msg)
  return { made, msg }
}
