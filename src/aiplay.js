// "AI plays" mode: Claude decides what to do next, the bot carries it out.
// Each step: build a short report of the bot's situation -> Claude picks ONE action (a tool call)
// -> run it with a time limit -> remember the result for the next step.
// Fast reflexes (eating, fleeing creepers, fighting, getting items back) stay in brain.js.
import pf from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { S, save, serverKey } from './store.js'
import { aiCall } from './ai.js'
import { say } from './chat.js'
import { goto, gather, craft, planks, placeAt, hunt, count, has, air, survive, survivalMoves } from './survival.js'

const { goals } = pf
const wait = ms => new Promise(r => setTimeout(r, ms))
const near = (b, pos) => Math.round(b.entity.position.distanceTo(pos))
const ACTION_MS = 90e3

// ---------- what the bot can see ----------
const RESOURCES = [
  ['logs', n => /_log$/.test(n) && !n.startsWith('stripped')], ['stone', n => n === 'stone' || n === 'deepslate'],
  ['coal_ore', n => /coal_ore$/.test(n)], ['iron_ore', n => /iron_ore$/.test(n)], ['copper_ore', n => /copper_ore$/.test(n)],
  ['gold_ore', n => /gold_ore$/.test(n)], ['diamond_ore', n => /diamond_ore$/.test(n)], ['sand', n => n === 'sand'],
  ['water', n => n === 'water'], ['lava', n => n === 'lava'], ['crafting_table', n => n === 'crafting_table'],
  ['furnace', n => n === 'furnace'], ['chest', n => n === 'chest'], ['bed', n => /_bed$/.test(n)], ['ripe_crops', null],
]

function observe(b, st, cfg, home) {
  const e = b.entity, p = e.position
  const lines = []
  lines.push(`Time: ${b.time.isDay ? 'day' : 'NIGHT (hostile mobs spawn)'}${b.isRaining ? ', raining' : ''}. Dimension: ${(b.game.dimension || '').replace('minecraft:', '')}.`)
  lines.push(`You: health ${Math.round(b.health)}/20, food ${b.food}/20, level ${b.experience?.level ?? 0}, at ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}, holding ${b.heldItem?.name || 'nothing'}.`)
  const armor = [5, 6, 7, 8].map(s => b.inventory.slots[s]?.name).filter(Boolean)
  lines.push(`Armor: ${armor.join(', ') || 'none'}.`)
  const inv = {}
  for (const i of b.inventory.items()) inv[i.name] = (inv[i.name] || 0) + i.count
  lines.push(`Inventory (${b.inventory.emptySlotCount()} free slots): ${Object.entries(inv).map(([n, c]) => c > 1 ? `${n} x${c}` : n).join(', ') || 'empty'}.`)
  if (home) lines.push(`Base: ${home.x} ${home.y} ${home.z} (${near(b, new Vec3(home.x, home.y, home.z))} m away).`)
  else lines.push('Base: not set (use set_base where you want to live).')
  const res = []
  for (const [name, test] of RESOURCES) {
    const found = b.findBlocks({ matching: test ? bl => test(bl.name) : bl => /^(wheat|carrots|potatoes|beetroots)$/.test(bl.name) && bl.getProperties().age >= (bl.name === 'beetroots' ? 3 : 7), maxDistance: 32, count: 40 })
    if (found.length) res.push(`${name} ${found.length >= 40 ? '40+' : found.length} (nearest ${Math.min(...found.map(v => near(b, v)))} m)`)
  }
  lines.push(`Nearby blocks (32 m): ${res.join(', ') || 'nothing notable'}.`)
  const ents = Object.values(b.entities).filter(x => x !== e && x.position.distanceTo(p) < 32)
  const group = list => { const m = {}; for (const x of list) { const n = x.username || x.name; m[n] = Math.min(m[n] ?? 99, near(b, x.position)) } return Object.entries(m).map(([n, d]) => `${n} (${d} m)`).join(', ') }
  lines.push(`Players: ${group(ents.filter(x => x.type === 'player')) || 'none nearby'}. Online: ${Object.keys(b.players).filter(n => n !== b.username).join(', ') || 'nobody'}.`)
  lines.push(`Hostile mobs: ${group(ents.filter(x => x.type === 'hostile')) || 'none'}. Animals: ${group(ents.filter(x => /^(cow|pig|sheep|chicken|rabbit|mooshroom|horse)$/.test(x.name))) || 'none'}.`)
  const places = S.places.filter(pl => pl.server === serverKey(cfg.host, cfg.port)).map(pl => `${pl.name} (${pl.x} ${pl.y} ${pl.z})`)
  if (places.length) lines.push(`Saved places: ${places.join(', ')}.`)
  lines.push(`Your goal: ${cfg.set?.goal || S.set.goal || 'survive and progress: wooden then stone tools, a base with a chest and bed, iron tools and armor, a farm'}.`)
  if (st.aiNotes) lines.push(`Your notes: ${st.aiNotes}`)
  const hist = (st.aiHistory || []).slice(-8)
  lines.push('Recent actions:' + (hist.length ? '\n' + hist.map(h => `- ${h.action} -> ${h.result}`).join('\n') : ' none yet.'))
  return lines.join('\n')
}

// ---------- the actions Claude can choose ----------
const str = (d, extra = {}) => ({ type: 'string', description: d, ...extra })
const int = (d, min, max) => ({ type: 'integer', description: d, minimum: min, maximum: max })
const tool = (name, description, props = {}, required = []) => ({
  name, description,
  input_schema: { type: 'object', properties: { ...props, plan: str('Optional: replace your notes (your plan / what to remember), max 200 chars.') }, required, additionalProperties: false },
})
const TOOLS = [
  tool('gather', 'Dig/chop the nearest matching blocks and collect the drops. Use "logs" for any tree, "stone" for stone (gives cobblestone, needs a pickaxe), or a block name like "coal_ore", "iron_ore", "sand", "dirt".', { block: str('logs, stone, coal_ore, iron_ore, copper_ore, sand, dirt, gravel, or another block name'), count: int('how many blocks', 1, 16) }, ['block', 'count']),
  tool('craft', 'Craft an item (e.g. oak_planks, stick, crafting_table, wooden_pickaxe, stone_sword, furnace, chest, torch, iron_pickaxe, iron_chestplate, bread, white_bed). Planks are made from logs automatically. Recipes needing a 3x3 grid need a crafting table within 24 m.', { item: str('item name'), count: int('how many items you want', 1, 64) }, ['item']),
  tool('smelt', 'Smelt/cook items in a furnace (places one if you carry it). Uses coal, charcoal or wood as fuel. E.g. raw_iron -> iron_ingot, raw_beef -> cooked_beef, sand -> glass.', { item: str('item to put in, e.g. raw_iron'), count: int('how many', 1, 16) }, ['item']),
  tool('work_on_base', 'Let the built-in routine do the next steps of setting up the base: crafting table, stone tools, chest, a small hut with a roof, bed, torch, storing loot. Good when you just want the base built.'),
  tool('go_to', 'Walk somewhere: "base", a saved place name, a player name, or coordinates "x y z".', { target: str('base | place name | player name | "x y z"') }, ['target']),
  tool('explore', 'Walk out to find new resources.', { direction: str('north, south, east, west or any', { enum: ['north', 'south', 'east', 'west', 'any'] }), distance: int('blocks', 15, 80) }, ['direction']),
  tool('hunt', 'Kill an animal for food or materials (sheep give wool for a bed, cows give leather).', { animal: str('cow, pig, sheep, chicken, rabbit or any') }, ['animal']),
  tool('fight', 'Attack the nearest hostile mob (zombie, skeleton, spider...). Avoid creepers.', { mob: str('mob name or any') }),
  tool('eat', 'Eat the best food you carry.'),
  tool('sleep', 'Sleep in a bed within 24 m (only works at night). Also sets your respawn point.'),
  tool('equip', 'Hold an item or wear armor.', { item: str('item name') }, ['item']),
  tool('store_items', 'Put items into the nearest chest (within 24 m). Keeps tools, weapons, armor, food and torches.', { keep: { type: 'array', items: { type: 'string' }, description: 'extra item names to keep' } }),
  tool('take_items', 'Take items out of the nearest chest.', { item: str('item name'), count: int('how many', 1, 64) }, ['item']),
  tool('place_block', 'Place a block from your inventory next to you (e.g. crafting_table, furnace, chest, torch, a bed, cobblestone).', { item: str('item name') }, ['item']),
  tool('set_base', 'Make where you are standing your base (home for sleeping, storage and building).'),
  tool('follow_player', 'Follow a player for a while.', { player: str('player name'), seconds: int('how long', 5, 120) }, ['player']),
  tool('chat', 'Say something in chat (only when a player is around or talked to you).', { message: str('one short line') }, ['message']),
  tool('wait', 'Stand still for a moment (e.g. waiting for day, crops or health).', { seconds: int('seconds', 3, 30) }),
]

const SYSTEM = `You control a Minecraft bot playing survival like a real player. Each turn you get a report of its situation and choose exactly ONE action by calling one tool.
How to play well:
- Progress: logs -> planks -> crafting table -> wooden pickaxe -> cobblestone -> stone pickaxe, sword, axe -> furnace -> coal + torches -> iron ore -> smelt to iron ingots -> iron pickaxe, sword, armor -> diamonds.
- Keep a base: chest for storage, a bed (3 wool + 3 planks) for respawning and skipping the night, a shelter.
- Food: hunt animals and cook the meat, or farm. Eat before food gets low.
- Night is dangerous: do NOT go gathering or exploring at night. Go to base and sleep if you have a bed; otherwise wait there or do crafting, smelting or storing at base.
- Be efficient: gather enough in one go (e.g. 8-16 blocks), craft several items at once.
- Item names are exact Minecraft ids (white_wool, oak_planks, raw_iron, cobblestone).
- If an action failed, read why and fix the cause instead of repeating it (e.g. craft a crafting table, gather the missing material, explore to find a resource).
- You can only do what the tools allow; reflexes like eating when starving and fleeing creepers happen automatically.
Use the plan field now and then to keep short notes of your current plan. Call one tool only, no extra text.`

// ---------- carrying out actions ----------
const CATS = { logs: n => /_log$/.test(n) && !n.startsWith('stripped'), stone: n => n === 'stone' || n === 'cobblestone' || n === 'deepslate' || n === 'cobbled_deepslate' }
const ARMOR_DEST = [[/_helmet$/, 'head'], [/_chestplate$/, 'torso'], [/_leggings$/, 'legs'], [/_boots$/, 'feet']]
const FUEL = ['coal', 'charcoal', 'coal_block']
const name = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/^minecraft:/, '')
const GENERIC = { wool: /_wool$/, planks: /_planks$/, wood: /_planks$/, log: /_log$/, logs: /_log$/, bed: /_bed$/ }
const GENERIC_DEFAULT = { wool: 'white_wool', planks: 'oak_planks', wood: 'oak_planks', log: 'oak_log', logs: 'oak_log', bed: 'white_bed' }
function itemName(b, s, fromInventory = true) {
  const n = name(s); if (!GENERIC[n]) return n
  const own = fromInventory && b.inventory.items().find(i => GENERIC[n].test(i.name))
  return own?.name || GENERIC_DEFAULT[n]
}

// spot next to the bot to put a block on (air with solid ground below, not where the bot stands)
function spotNear(b) {
  const p = b.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [0, 2], [-2, 0], [0, -2]]) {
    const pos = p.offset(dx, 0, dz)
    if (air(b.blockAt(pos)) && air(b.blockAt(pos.offset(0, 1, 0))) && b.blockAt(pos.offset(0, -1, 0))?.boundingBox === 'block') return pos
  }
  return null
}
async function placeNear(b, item) {
  const pos = spotNear(b); if (!pos) throw new Error('no free spot next to me to place it')
  if (!await placeAt(b, item, pos)) throw new Error('could not place ' + item)
  return pos
}

function missingFor(b, itemId, table) {
  const have = id => b.inventory.items().filter(i => i.type === id).reduce((n, i) => n + i.count, 0)
  const short = r => r.delta.filter(d => d.count < 0).reduce((n, d) => n + Math.max(0, -d.count - have(d.id)), 0)
  const r = b.recipesAll(itemId, null, table || true).sort((x, y) => short(x) - short(y))[0] // the variant closest to craftable
  if (!r) return 'there is no crafting recipe for it'
  const need = r.delta.filter(d => d.count < 0).map(d => {
    const nm = b.registry.items[d.id]?.name, have = b.inventory.items().filter(i => i.type === d.id).reduce((n, i) => n + i.count, 0)
    return have < -d.count ? `${-d.count} ${nm} (have ${have})` : null
  }).filter(Boolean)
  return need.length ? 'missing ' + need.join(', ') : (r.requiresTable && !table ? 'needs a crafting table within 24 m' : 'unknown reason')
}

const ACTIONS = {
  async gather(b, st, { block, count: n = 8 }) {
    const key = name(block), test = CATS[key] || (x => x === key || x === 'deepslate_' + key)
    if (!CATS[key] && !b.registry.blocksByName[key]) throw new Error(`unknown block "${block}"`)
    const before = b.inventory.items().reduce((s, i) => s + i.count, 0)
    for (let i = 0; i < n && !st.abort; i++) {
      if (!b.findBlock({ matching: x => test(x.name), maxDistance: 40 })) { if (i === 0) throw new Error(`no ${key} within 40 m, explore first`); break }
      await gather(b, st, test, key)
    }
    return `picked up ${b.inventory.items().reduce((s, i) => s + i.count, 0) - before} items`
  },
  async craft(b, st, { item, count: n = 1 }) {
    const it = itemName(b, item, false), info = b.registry.itemsByName[it]
    if (!info) throw new Error(`unknown item "${item}"`)
    if (/_planks$/.test(it)) { await planks(b, count(b, /_planks$/) + n); return `now have ${count(b, it)} ${it}` }
    await wait(300) // let the inventory catch up after the last action
    const tryCraft = async () => {
      const before = count(b, it)
      for (let k = 0; k < 16 && count(b, it) < before + n; k++) {
        let ok = false
        try { ok = await craft(b, st, it, 1) } catch { await wait(400); ok = await craft(b, st, it, 1).catch(() => false) }
        if (!ok) break
      }
      return count(b, it) - before
    }
    let made = await tryCraft()
    if (!made) { await planks(b, 8); made = await tryCraft() } // maybe it just needed planks or sticks
    if (!made && b.registry.itemsByName.stick && it !== 'stick') { await craft(b, st, 'stick', 1).catch(() => {}); made = await tryCraft() }
    if (!made) throw new Error(`can't craft ${it}: ${missingFor(b, info.id, b.findBlock({ matching: b.registry.blocksByName.crafting_table.id, maxDistance: 24 }))}`)
    return `crafted ${made} ${it}`
  },
  async smelt(b, st, { item, count: n = 1 }) {
    const it = itemName(b, item), info = b.registry.itemsByName[it]
    if (!info) throw new Error(`unknown item "${item}"`)
    n = Math.min(n, count(b, it)); if (!n) throw new Error(`you have no ${it}`)
    let fb = b.findBlock({ matching: b.registry.blocksByName.furnace.id, maxDistance: 24 })
    if (!fb) {
      if (!has(b, 'furnace')) throw new Error('no furnace nearby or in inventory (craft one from 8 cobblestone)')
      await placeNear(b, 'furnace'); fb = b.findBlock({ matching: b.registry.blocksByName.furnace.id, maxDistance: 6 })
    }
    await goto(b, new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2))
    const f = await b.openFurnace(fb)
    try {
      if (!f.fuelItem()) {
        const fuel = b.inventory.items().find(i => FUEL.includes(i.name)) || b.inventory.items().find(i => /_planks$|_log$/.test(i.name))
        if (!fuel) throw new Error('no fuel (coal, charcoal, planks or logs)')
        await f.putFuel(fuel.type, null, Math.min(fuel.count, FUEL.includes(fuel.name) ? Math.ceil(n / 8) : Math.ceil(n / 1.5)))
      }
      await f.putInput(info.id, null, n)
      for (let t = 0; t < 70 && !st.abort; t++) { await wait(1000); if ((f.outputItem()?.count || 0) >= n || (!f.inputItem() && f.outputItem())) break }
      const out = f.outputItem()
      if (out) await f.takeOutput()
      return out ? `got ${out.count} ${out.name}` : 'nothing came out yet (needs more time or fuel)'
    } finally { f.close() }
  },
  async work_on_base(b, st, _, ctx) {
    for (let i = 0; i < 3 && !st.abort; i++) { const r = await survive(b, st, ctx.cfg, ctx.c, ctx.home); if (r === 'idle') return 'the base is finished' }
    return st.task.replace(/^survival: /, 'base routine: ')
  },
  async go_to(b, st, { target }, ctx) {
    const t = String(target || '').trim()
    let pos
    if (/^base$/i.test(t)) { if (!ctx.home) throw new Error('no base set'); pos = ctx.home }
    else if (/^-?\d+\s+-?\d+\s+-?\d+$/.test(t)) { const [x, y, z] = t.split(/\s+/).map(Number); pos = { x, y, z } }
    else {
      const pl = S.places.find(p => p.name.toLowerCase() === t.toLowerCase() && p.server === serverKey(ctx.cfg.host, ctx.cfg.port))
      const player = b.players[t]?.entity
      pos = pl || player?.position
      if (!pos) throw new Error(`don't know "${t}" (not a saved place or a player I can see)`)
    }
    await goto(b, new goals.GoalNear(pos.x, pos.y, pos.z, 2), ACTION_MS)
    return `arrived (${near(b, new Vec3(pos.x, pos.y, pos.z))} m from target)`
  },
  async explore(b, st, { direction = 'any', distance = 40 }) {
    const a = { east: 0, south: Math.PI / 2, west: Math.PI, north: -Math.PI / 2 }[direction] ?? Math.random() * Math.PI * 2
    const p = b.entity.position, from = p.clone()
    await goto(b, new goals.GoalNearXZ(p.x + Math.cos(a) * distance, p.z + Math.sin(a) * distance, 4), ACTION_MS).catch(() => {})
    return `walked ${Math.round(b.entity.position.distanceTo(from))} m ${direction}`
  },
  async hunt(b, st, { animal = 'any' }) {
    const a = name(animal)
    const prey = b.nearestEntity(x => (a === 'any' ? /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/.test(x.name) : x.name === a) && x.position.distanceTo(b.entity.position) < 40)
    if (!prey) throw new Error(`no ${a === 'any' ? 'animals' : a} within 40 m`)
    await hunt(b, st, prey)
    return `killed a ${prey.name}`
  },
  async fight(b, st, { mob = 'any' }) {
    const m = name(mob)
    const foe = b.nearestEntity(x => x.type === 'hostile' && x.name !== 'creeper' && (m === 'any' || x.name === m) && x.position.distanceTo(b.entity.position) < 24)
    if (!foe) throw new Error('no such mob nearby')
    const weapon = b.inventory.items().find(i => /_sword$|_axe$/.test(i.name)); if (weapon) await b.equip(weapon, 'hand')
    for (let i = 0; i < 30 && foe.isValid && !st.abort && b.health > 6; i++) {
      if (foe.position.distanceTo(b.entity.position) > 3) await goto(b, new goals.GoalFollow(foe, 2), 5000).catch(() => {})
      await b.lookAt(foe.position.offset(0, foe.height * 0.8, 0), true); b.attack(foe); await wait(650)
    }
    if (!foe.isValid) st.count('kills')
    return foe.isValid ? 'stopped fighting (low health or it got away)' : `killed the ${foe.name}`
  },
  async eat(b) {
    const foods = b.inventory.items().filter(i => b.registry.foodsByName[i.name] && !/rotten_flesh|spider_eye|poisonous/.test(i.name))
    const food = foods.sort((x, y) => (b.registry.foodsByName[y.name].saturation || 0) - (b.registry.foodsByName[x.name].saturation || 0))[0]
    if (!food) throw new Error('no food in inventory')
    if (b.food >= 20) throw new Error('not hungry')
    await b.equip(food, 'hand'); await b.consume()
    return `ate ${food.name}, food now ${b.food}`
  },
  async sleep(b) {
    if (b.time.isDay) throw new Error('you can only sleep at night')
    const bed = b.findBlock({ matching: bl => b.isABed(bl), maxDistance: 24 })
    if (!bed) throw new Error('no bed within 24 m')
    await goto(b, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2))
    await b.sleep(bed)
    return 'sleeping'
  },
  async equip(b, st, { item }) {
    const it = itemName(b, item), i = b.inventory.items().find(x => x.name === it)
    if (!i) throw new Error(`no ${it} in inventory`)
    const dest = ARMOR_DEST.find(([re]) => re.test(it))?.[1] || 'hand'
    await b.equip(i, dest)
    return `equipped ${it} (${dest})`
  },
  async store_items(b, st, { keep = [] }) {
    const chest = b.findBlock({ matching: b.registry.blocksByName.chest.id, maxDistance: 24 })
    if (!chest) throw new Error('no chest within 24 m')
    await goto(b, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2))
    const box = await b.openContainer(chest)
    let n = 0
    try {
      const keepSet = new Set(keep.map(name))
      for (const i of b.inventory.items()) {
        if (keepSet.has(i.name) || /_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$|^torch$|^shield$/.test(i.name) || b.registry.foodsByName[i.name]) continue
        await box.deposit(i.type, null, i.count).then(() => n += i.count, () => {})
      }
    } finally { box.close() }
    st.count('stored'); return `stored ${n} items`
  },
  async take_items(b, st, { item, count: n = 64 }) {
    const it = itemName(b, item, false), info = b.registry.itemsByName[it]
    if (!info) throw new Error(`unknown item "${item}"`)
    const chest = b.findBlock({ matching: b.registry.blocksByName.chest.id, maxDistance: 24 })
    if (!chest) throw new Error('no chest within 24 m')
    await goto(b, new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2))
    const box = await b.openContainer(chest)
    try {
      const inBox = box.containerItems().filter(i => i.type === info.id).reduce((s, i) => s + i.count, 0)
      if (!inBox) throw new Error(`no ${it} in the chest`)
      await box.withdraw(info.id, null, Math.min(n, inBox))
      return `took ${Math.min(n, inBox)} ${it}`
    } finally { box.close() }
  },
  async place_block(b, st, { item }) {
    const it = itemName(b, item)
    if (!has(b, it)) throw new Error(`no ${it} in inventory`)
    const pos = await placeNear(b, it); st.count('placed')
    return `placed ${it} at ${pos.x} ${pos.y} ${pos.z}`
  },
  async set_base(b, st, _, ctx) {
    const p = b.entity.position.floored()
    ctx.cfg.spot = { x: p.x, y: p.y, z: p.z, label: 'base' }; delete ctx.cfg.at; save()
    return `base set at ${p.x} ${p.y} ${p.z}`
  },
  async follow_player(b, st, { player, seconds = 30 }) {
    const t = b.players[player]?.entity
    if (!t) throw new Error(`can't see ${player}`)
    b.pathfinder.setGoal(new goals.GoalFollow(t, 2), true)
    for (let i = 0; i < seconds && !st.abort; i++) await wait(1000)
    b.pathfinder.stop(); return `followed ${player}`
  },
  async chat(b, st, { message }) {
    if (Object.keys(b.players).length < 2) throw new Error('nobody else is online')
    say(b, st, String(message).slice(0, 200)); return 'said it'
  },
  async wait(b, st, { seconds = 10 }) {
    for (let i = 0; i < seconds && !st.abort; i++) await wait(1000)
    return 'waited'
  },
}

function remember(st, action, result) {
  st.aiHistory ||= []
  st.aiHistory.push({ action, result: String(result).slice(0, 160) })
  if (st.aiHistory.length > 12) st.aiHistory.shift()
  st.log?.push({ t: Date.now(), type: 'event', text: `AI: ${action} -> ${String(result).slice(0, 120)}` })
}

// One AI step. Returns false when the AI can't be used right now (caller falls back to the routine).
export async function aiPlayStep(b, st, cfg, c, home) {
  const now = Date.now()
  st.aiThinks = (st.aiThinks || []).filter(t => now - t < 3600e3)
  if (st.aiThinks.length >= c.aiThinkMax) { st.aiPaused = 'hourly AI limit reached'; return false }
  if (now < (st.aiBackoff || 0)) return false
  st.aiPaused = ''
  st.task = 'AI: thinking…'
  let res
  try {
    st.aiThinks.push(now)
    res = await aiCall({ max_tokens: 600, system: SYSTEM, tools: TOOLS, tool_choice: { type: 'auto', disable_parallel_tool_use: true }, messages: [{ role: 'user', content: observe(b, st, cfg, home) }] })
  } catch (e) {
    st.aiBackoff = now + 60e3 // AI down or misconfigured: use the routine for a minute
    st.log?.push({ t: now, type: 'event', text: 'AI error: ' + (e.status ? e.status + ' ' : '') + String(e.message || e).slice(0, 140) })
    return false
  }
  st.count('aiThinks')
  const call = res.content.find(x => x.type === 'tool_use')
  if (!call || !ACTIONS[call.name]) { remember(st, 'no action', 'the AI did not pick a tool'); await wait(3000); return true }
  const input = call.input || {}
  if (input.plan) st.aiNotes = String(input.plan).slice(0, 200)
  const label = call.name + (Object.keys(input).filter(k => k !== 'plan').length ? ' ' + JSON.stringify(Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'plan'))) : '')
  st.task = 'AI: ' + label.slice(0, 80)
  if (!st.survMoves) { b.pathfinder.setMovements(survivalMoves(b, home)); st.survMoves = true } // may dig and pillar
  st.abort = false; st.aiRunning = true
  let timer
  try {
    const result = await Promise.race([
      ACTIONS[call.name](b, st, input, { cfg, c, home }),
      new Promise((_, no) => { timer = setTimeout(() => { st.abort = true; b.pathfinder.stop(); no(new Error('took too long, stopped')) }, ACTION_MS) }),
    ])
    remember(st, label, 'ok: ' + result)
  } catch (e) {
    remember(st, label, 'failed: ' + (st.abort && !/too long/.test(e.message) ? 'interrupted (danger nearby)' : e.message || e))
  } finally { clearTimeout(timer); st.aiRunning = false; st.abort = false }
  return true
}
