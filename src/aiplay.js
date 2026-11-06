// "AI plays" mode, built on Mindcraft's skills, modes and command set.
// Claude talks to the bot like Mindcraft's agent: it sees a status report, calls one command (tool) at a time,
// gets the command's output back, and keeps going towards its goal (self-prompting). Mindcraft's modes
// (self-preservation, unstuck, self-defense, hunting, item collecting, torches, ...) run in the background
// and interrupt actions when needed; the AI is told when that happens.
// Commands, queries and prompts adapted from Mindcraft (https://github.com/mindcraft-bots/mindcraft),
// src/agent/commands/actions.js, queries.js and profiles/defaults/_default.json.
// Copyright (c) 2024 Kolby Nottingham. MIT License, see src/mc/LICENSE-mindcraft.
import { S, save, serverKey } from './store.js'
import { aiCall } from './ai.js'
import { say } from './chat.js'
import { survive } from './survival.js'
import * as skills from './mc/skills.js'
import * as world from './mc/world.js'
import * as mc from './mc/mcdata.js'
import { McAgent } from './mc/agent.js'
import { BLUEPRINTS, housePlan, buildHouse } from './mc/build.js'
import { upgradeGear, canUpgrade } from './gear.js'
import { listSchematics, startBuild, runBuild, placeOnGround } from './schemstore.js'
import { whereIs, storeValuables, tidyInventory, packIntoBundle, memorySummary, extraValuables, VALUABLE } from './storage.js'
const BUILDING = /^(cobblestone|stone|cobbled_deepslate|deepslate|w+_planks|w+_log|w+_wood|stone_bricks|bricks|w*sandstone|glass|w+_slab|w+_stairs|smooth_stone|blackstone|andesite|diorite|granite|tuff|mud_bricks|terracotta|w+_terracotta|w+_concrete|w+_wool|quartz_block|iron_ingot|coal|redstone|lapis_lazuli|copper_ingot)$/

const wait = ms => new Promise(r => setTimeout(r, ms))
const MAX_MSGS = 24           // conversation turns kept before older ones are folded into memory
const DEFAULT_GOAL = 'Play survival and progress: get wood and stone tools, build a base with a chest, bed and shelter, get food, then iron tools and armor, then diamonds.'

// ---------- queries: like Mindcraft's !stats, !inventory, !nearbyBlocks, !craftable, !entities ----------
function stats(b, agent) {
  const p = b.entity.position, t = b.time.timeOfDay
  let r = `STATS\n- Position: x: ${p.x.toFixed(1)}, y: ${p.y.toFixed(1)}, z: ${p.z.toFixed(1)}\n- Gamemode: ${b.game.gameMode}\n- Health: ${Math.round(b.health)} / 20\n- Hunger: ${Math.round(b.food)} / 20`
  r += `\n- Biome: ${world.getBiomeName(b)}\n- Weather: ${b.thunderState > 0 ? 'Thunderstorm' : b.rainState > 0 ? 'Rain' : 'Clear'}`
  r += `\n- Time: ${t < 6000 ? 'Morning' : t < 12000 ? 'Afternoon' : t < 13000 ? 'Sunset (night soon)' : 'Night'}`
  r += `\n- Current action: ${agent.isIdle() ? 'Idle' : agent.actions.currentActionLabel}`
  const players = world.getNearbyPlayerNames(b)
  r += `\n- Nearby players: ${players.length ? players.join(', ') : 'none'}`
  return r
}
function inventory(b) {
  const inv = world.getInventoryCounts(b)
  const r = 'INVENTORY' + (Object.keys(inv).length ? Object.entries(inv).filter(([, c]) => c > 0).map(([n, c]) => `\n- ${n}: ${c}`).join('') : ': Nothing')
  const wear = [['Head', 5], ['Torso', 6], ['Legs', 7], ['Feet', 8]].map(([k, s]) => b.inventory.slots[s] && `${k}: ${b.inventory.slots[s].name}`).filter(Boolean)
  return r + '\nWEARING: ' + (wear.join(', ') || 'Nothing')
}
function nearbyBlocks(b) {
  const names = [...new Set(world.getNearestBlocks(b).map(bl => bl.name))]
  if (!names.length) return 'NEARBY_BLOCKS: none'
  return 'NEARBY_BLOCKS\n- ' + names.join('\n- ') + '\n- ' + world.getSurroundingBlocks(b).join('\n- ') + `\n- First solid block above head: ${world.getFirstBlockAboveHead(b, null, 32)}`
}
function entities(b) {
  const counts = {}
  for (const e of world.getNearbyEntities(b)) if (e.type !== 'player' && e.name !== 'item') counts[e.name] = (counts[e.name] || 0) + 1
  const players = world.getNearbyPlayerNames(b)
  const lines = players.map(p => `\n- Player: ${p}`).join('') + Object.entries(counts).map(([n, c]) => `\n- ${n}: ${c}`).join('')
  return 'NEARBY_ENTITIES' + (lines || ': none')
}
function craftable(b) {
  const list = world.getCraftableItems(b)
  return 'CRAFTABLE_ITEMS' + (list.length ? list.map(i => `\n- ${i}`).join('') : ': none')
}

// ---------- commands (tools) ----------
// params: [name, type, description]; types: string | int | float | boolean
const P = (name, type, description) => ({ name, type, description })
const T = { string: 'string', int: 'integer', float: 'number', boolean: 'boolean' }
const OPTIONAL = /^(closeness|follow_dist|search_range|num|quantity|seconds|count|distance)$/

const COMMANDS = [
  // queries
  { name: 'stats', description: "Get your location, health, hunger, biome, weather, time of day and current action.", run: (b, a) => stats(b, a) },
  { name: 'inventory', description: "Get your inventory and what you are wearing.", run: b => inventory(b) },
  { name: 'nearbyBlocks', description: 'Get the blocks near you.', run: b => nearbyBlocks(b) },
  { name: 'craftable', description: "Get the items you can craft with your inventory right now.", run: b => craftable(b) },
  { name: 'entities', description: 'Get nearby players and entities.', run: b => entities(b) },
  { name: 'savedPlaces', description: 'List saved locations.', run: (b, a, x, ctx) => 'SAVED_PLACES: ' + (placesFor(ctx.cfg).map(p => `${p.name} (${p.x}, ${p.y}, ${p.z})`).join(', ') || 'none') },
  { name: 'getCraftingPlan', description: "Get a full crafting plan for an item: ingredients, quantities, and what is missing from your inventory.",
    params: [P('targetItem', 'string', 'The item to craft'), P('quantity', 'int', 'How many')],
    run: (b, a, { targetItem, quantity = 1 }) => mc.getDetailedCraftingPlan(targetItem, quantity, world.getInventoryCounts(b)) },
  { name: 'modes', description: 'List the automatic behaviour modes and whether they are on.', run: b => b.modes.getDocs() },

  // actions
  { name: 'stop', description: 'Stop the current action.', run: async (b, a) => { await a.actions.stop(); return 'Stopped.' } },
  { name: 'goToPlayer', description: 'Go to the given player.', params: [P('player_name', 'string', 'Player name'), P('closeness', 'float', 'How close to get')], act: (b, { player_name, closeness = 3 }) => skills.goToPlayer(b, player_name, closeness) },
  { name: 'followPlayer', description: 'Follow the given player (up to 2 minutes).', params: [P('player_name', 'string', 'Player to follow'), P('follow_dist', 'float', 'Distance to follow from')], timeout: 2, act: (b, { player_name, follow_dist = 4 }) => skills.followPlayer(b, player_name, follow_dist) },
  { name: 'goToCoordinates', description: 'Go to the given x, y, z location.', params: [P('x', 'float', 'x'), P('y', 'float', 'y'), P('z', 'float', 'z'), P('closeness', 'float', 'How close to get')], act: (b, { x, y, z, closeness = 2 }) => skills.goToPosition(b, x, y, z, closeness) },
  { name: 'searchForBlock', description: 'Find and go to the nearest block of a given type within a range (min 32).', params: [P('type', 'string', 'Block type, e.g. oak_log, iron_ore'), P('search_range', 'float', 'Search range, 32-512')], act: (b, { type, search_range = 64 }) => skills.goToNearestBlock(b, type, 4, Math.max(32, search_range)) },
  { name: 'searchForEntity', description: 'Find and go to the nearest entity of a given type within a range.', params: [P('type', 'string', 'Entity type, e.g. cow, sheep, villager'), P('search_range', 'float', 'Search range, 32-512')], act: (b, { type, search_range = 64 }) => skills.goToNearestEntity(b, type, 4, Math.max(32, search_range)) },
  { name: 'moveAway', description: 'Move away from the current location in any direction by a given distance.', params: [P('distance', 'float', 'Distance')], act: (b, { distance = 10 }) => skills.moveAway(b, distance) },
  { name: 'rememberHere', description: 'Save the current location with a name.', params: [P('name', 'string', 'Name for the place')], run: (b, a, { name }, ctx) => rememberPlace(b, ctx.cfg, name) },
  { name: 'goToRememberedPlace', description: 'Go to a saved location.', params: [P('name', 'string', 'Saved place name')], act: (b, { name }, ctx) => { const p = placesFor(ctx.cfg).find(x => x.name.toLowerCase() === String(name).toLowerCase()); if (!p) { skills.log(b, `No location named "${name}" saved.`); return } return skills.goToPosition(b, p.x, p.y, p.z, 1) } },
  { name: 'givePlayer', description: 'Give an item to a player.', params: [P('player_name', 'string', 'Player'), P('item_name', 'string', 'Item'), P('num', 'int', 'How many')], act: (b, { player_name, item_name, num = 1 }) => skills.giveToPlayer(b, item_name, player_name, num) },
  { name: 'consume', description: 'Eat or drink the given item.', params: [P('item_name', 'string', 'Item to eat/drink')], act: (b, { item_name }) => skills.consume(b, item_name) },
  { name: 'equip', description: 'Equip the given item (tool, weapon or armor).', params: [P('item_name', 'string', 'Item')], act: (b, { item_name }) => skills.equip(b, item_name) },
  { name: 'putInChest', description: 'Put an item in the nearest chest.', params: [P('item_name', 'string', 'Item'), P('num', 'int', 'How many (-1 for all)')], act: (b, { item_name, num = -1 }) => skills.putInChest(b, item_name, num) },
  { name: 'takeFromChest', description: 'Take an item from the nearest chest.', params: [P('item_name', 'string', 'Item'), P('num', 'int', 'How many (-1 for all)')], act: (b, { item_name, num = -1 }) => skills.takeFromChest(b, item_name, num) },
  { name: 'viewChest', description: 'View the items in the nearest chest.', act: b => skills.viewChest(b) },
  { name: 'discard', description: 'Drop JUNK from the inventory (dirt, gravel, seeds, rotten flesh...). Useful materials are stored instead, valuables/gear/food are never thrown.', params: [P('item_name', 'string', 'Item'), P('num', 'int', 'How many')],
    act: async (b, { item_name, num = -1 }, ctx) => {
      const name = String(item_name || '').toLowerCase().replace(/\s+/g, '_')
      const have = b.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
      if (!have) { skills.log(b, `You have no ${name}.`); return }
      if (VALUABLE.test(name) || /_(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots)$|^(shield|bow|crossbow|totem_of_undying|elytra|bundle|\w*shulker_box)$/.test(name) || b.registry.foodsByName[name]) {
        skills.log(b, `Not throwing away ${name}: it's valuable, gear or food. Store it with storeValuables or putInChest instead.`); return
      }
      // building materials are worth keeping: store them; drop only if there's really no room and no storage, and keep a stack
      if (BUILDING.test(name)) {
        const r = await tidyInventory(b, ctx.cfg, ctx.home)
        if (b.inventory.emptySlotCount() > 3) { skills.log(b, `Kept the ${name} (useful for building). ${r}`); return }
        num = Math.max(0, Math.min(num < 0 ? have : num, have - 64))
        if (!num) { skills.log(b, `Kept the ${name}: keeping at least a stack of building blocks.`); return }
      }
      const s = b.entity.position.clone(); await skills.moveAway(b, 5); await skills.discard(b, name, num); await skills.goToPosition(b, s.x, s.y, s.z, 0)
    } },
  { name: 'collectBlocks', description: 'Collect (mine/chop) the nearest blocks of a type, picking the right tool. E.g. oak_log, stone, coal_ore, iron_ore, sand.', params: [P('type', 'string', 'Block type'), P('num', 'int', 'How many')], timeout: 10, act: (b, { type, num = 1 }) => skills.collectBlock(b, type, num) },
  { name: 'craftRecipe', description: 'Craft a recipe a number of times (NOT the number of items: one oak_planks craft makes 4). Places a crafting table from the inventory if one is needed.', params: [P('recipe_name', 'string', 'Output item'), P('num', 'int', 'Times to craft')], act: (b, { recipe_name, num = 1 }) => skills.craftRecipe(b, recipe_name, num) },
  { name: 'smeltItem', description: 'Smelt an item in a furnace a number of times (uses a nearby furnace or places one from the inventory; uses coal/charcoal/wood as fuel).', params: [P('item_name', 'string', 'Input item, e.g. raw_iron, beef'), P('num', 'int', 'Times to smelt')], timeout: 5, act: (b, { item_name, num = 1 }) => skills.smeltItem(b, item_name, num) },
  { name: 'clearFurnace', description: 'Take all items out of the nearest furnace.', act: b => skills.clearNearestFurnace(b) },
  { name: 'placeHere', description: 'Place a single block or torch where you stand. Not for building structures.', params: [P('type', 'string', 'Block/item to place')], act: (b, { type }) => { const p = b.entity.position; return skills.placeBlock(b, type, p.x, p.y, p.z) } },
  { name: 'attack', description: 'Attack and kill the nearest entity of a type (mob or animal).', params: [P('type', 'string', 'Entity type, e.g. zombie, cow')], act: (b, { type }) => skills.attackNearest(b, type, true) },
  { name: 'goToBed', description: 'Go to the nearest bed and sleep.', act: b => skills.goToBed(b) },
  { name: 'stay', description: 'Stay in place for some seconds (pauses modes).', params: [P('seconds', 'int', 'Seconds (max 120)')], act: (b, { seconds = 30 }) => skills.stay(b, Math.min(120, Math.max(1, seconds))) },
  { name: 'setMode', description: 'Turn an automatic behaviour mode on or off (self_preservation, unstuck, cowardice, self_defense, hunting, item_collecting, torch_placing, elbow_room, idle_staring).', params: [P('mode_name', 'string', 'Mode'), P('on', 'boolean', 'On or off')],
    run: (b, a, { mode_name, on }) => { if (!b.modes.exists(mode_name) || mode_name === 'cheat') return `Mode ${mode_name} does not exist.`; b.modes.setOn(mode_name, !!on); return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.` } },
  { name: 'digDown', description: 'Dig straight down a distance. Stops at lava, water or a fall of 4+ blocks.', params: [P('distance', 'int', 'Blocks')], act: (b, { distance = 5 }) => skills.digDown(b, distance) },
  { name: 'goToSurface', description: 'Move to the highest block above you (usually the surface).', act: b => skills.goToSurface(b) },
  { name: 'useOn', description: 'Use (right click) a tool on the nearest target: e.g. hoe on dirt, bucket on water, shears on sheep, bone_meal on a crop.', params: [P('tool_name', 'string', 'Tool name or "hand"'), P('target', 'string', 'Entity or block type, or "nothing"')], act: (b, { tool_name, target }) => skills.useToolOn(b, tool_name, target) },
  { name: 'showVillagerTrades', description: 'Show the trades of a villager (ids are in entities).', params: [P('id', 'int', 'Villager id')], act: (b, { id }) => skills.showVillagerTrades(b, id) },
  { name: 'tradeWithVillager', description: 'Trade with a villager.', params: [P('id', 'int', 'Villager id'), P('index', 'int', 'Trade number (1-based)'), P('count', 'int', 'Times')], act: (b, { id, index, count = 1 }) => skills.tradeWithVillager(b, id, index, count) },
  // Wanderbots extras
  { name: 'buildHouse', description: 'Build, or keep building, a proper small house at your base from a blueprint. style: wood (planks walls/floor/roof + log corners), stone (cobblestone walls) or dirt (quick shelter). Places a door, bed, chest and torches if you carry them. Call again until it says complete; it reports missing materials.', params: [P('style', 'string', 'wood, stone or dirt')], timeout: 6,
    act: async (b, { style = 'wood' }, ctx) => {
      if (!ctx.home) { const p = b.entity.position.floored(); ctx.cfg.spot = { x: p.x, y: p.y, z: p.z, label: 'base' }; ctx.home = ctx.cfg.spot; save() }
      const plan = housePlan(b, ctx.cfg, BLUEPRINTS[style] ? style : 'wood', ctx.home)
      if (!ctx.cfg.house || ctx.cfg.house.style !== plan.style) { ctx.cfg.house = plan; save() }
      const r = await buildHouse(b, plan, 60); ctx.st.count('placed', r.placed); skills.log(b, r.report)
    } },
  { name: 'workOnBase', description: 'Let the built-in routine do the next steps of setting up your base: crafting table, stone tools, chest, a small hut with a roof, bed, torch, storing loot.', timeout: 4,
    act: async (b, x, ctx) => { for (let i = 0; i < 3 && !b.interrupt_code; i++) { if (await survive(b, ctx.st, ctx.cfg, ctx.c, ctx.home) === 'idle') { skills.log(b, 'The base is finished.'); return } } skills.log(b, ctx.st.task.replace(/^survival: /, 'Base routine: ')) } },
  { name: 'setBase', description: 'Make where you stand your base (home for sleeping, storage, building).', run: (b, a, x, ctx) => { const p = b.entity.position.floored(); ctx.cfg.spot = { x: p.x, y: p.y, z: p.z, label: 'base' }; delete ctx.cfg.at; save(); return `Base set at ${p.x} ${p.y} ${p.z}.` } },
  { name: 'whereIs', description: 'Find where an item is: your inventory, chests/barrels/shulkers you have opened before, or your ender chest.', params: [P('item', 'string', 'Item name, e.g. diamond, iron_ingot, oak_log')], run: (b, a, { item }, ctx) => whereIs(b, ctx.cfg, item) },
  { name: 'storeValuables', description: 'Put valuables you are carrying (diamonds, gold, storage blocks, enchanted books, golden apples...) into your ender chest or the chest at your base, keeping a few you need.', timeout: 3, act: async (b, x, ctx) => skills.log(b, await storeValuables(b, ctx.cfg, ctx.home)) },
  { name: 'tidyInventory', description: 'Free up inventory space: store or drop junk, pack small stacks into a bundle and bulk into a shulker box if you have them.', timeout: 3, act: async (b, x, ctx) => skills.log(b, await tidyInventory(b, ctx.cfg, ctx.home)) },
  { name: 'packBundle', description: 'Put small odd stacks into a bundle you carry to free slots.', act: async (b, x, ctx) => skills.log(b, await packIntoBundle(b, ctx.st)) },
  { name: 'listSchematics', description: 'List the building schematics (saved designs) you can build, with sizes and materials.', run: () => 'SCHEMATICS: ' + (listSchematics().map(s => `${s.name} (${s.size.x}x${s.size.y}x${s.size.z}, ${s.blocks} blocks; needs ${Object.entries(s.materials).slice(0, 6).map(([k, v]) => v + ' ' + k).join(', ')})`).join('; ') || 'none uploaded yet') },
  { name: 'buildSchematic', description: 'Start building a saved schematic (design). where: base, here, or "x y z". rot: 0-3 quarter turns. Uses /setblock if you are op, otherwise places blocks from your inventory. Then call continueBuild until finished.', params: [P('name', 'string', 'Schematic name'), P('where', 'string', 'base, here, or x y z'), P('rot', 'int', 'Quarter turns 0-3')], timeout: 6,
    act: async (b, { name, where = 'base', rot = 0 }, ctx) => {
      const s = listSchematics().find(x => x.name.toLowerCase() === String(name).toLowerCase()); if (!s) { skills.log(b, `No schematic named "${name}". Use listSchematics.`); return }
      let origin = where === 'here' ? b.entity.position : where === 'base' ? ctx.home : null
      if (!origin && /^-?\d+\s+-?\d+\s+-?\d+$/.test(String(where).trim())) { const [x, y, z] = String(where).trim().split(/\s+/).map(Number); origin = { x, y, z } }
      if (!origin) origin = b.entity.position
      if (where === 'here' || where === 'base') origin = await placeOnGround(b, s.name, origin)
      startBuild(ctx.cfg, s.name, origin, { rot })
      skills.log(b, await runBuild(b, ctx.cfg, { max: 60, shouldStop: () => b.interrupt_code }))
    } },
  { name: 'continueBuild', description: 'Keep building the current schematic (places the next blocks; reports missing materials).', timeout: 6,
    act: async (b, x, ctx) => { if (!ctx.cfg.build || ctx.cfg.build.state === 'done') { skills.log(b, 'No build in progress.'); return } ctx.cfg.build.state = 'running'; skills.log(b, await runBuild(b, ctx.cfg, { max: 60, shouldStop: () => b.interrupt_code })) } },
  { name: 'upgradeGear', description: 'Turn your diamonds / iron (also diamond_block and iron_block, and what is in the nearby chest) into the best tools (sword, pickaxe, axe, shovel) and armor (helmet, chestplate, leggings, boots), and wear them. Use this whenever you get diamonds or iron.', timeout: 5,
    act: async (b, x, ctx) => { ctx.st.gearRunning = true; ctx.st.gearAt = Date.now(); try { await upgradeGear(b) } finally { ctx.st.gearRunning = false } } },
  { name: 'pickupItems', description: 'Walk to dropped items lying nearby and pick them up.', timeout: 2,
    act: async b => { const it = b.nearestEntity(e => e.name === 'item' && e.position.distanceTo(b.entity.position) < 32); if (!it) { skills.log(b, 'No dropped items nearby.'); return } if (it.position.distanceTo(b.entity.position) > 6) await skills.goToPosition(b, it.position.x, it.position.y, it.position.z, 1); await skills.pickupNearbyItems(b) } },
  { name: 'remember', description: 'Remember a fact for the long term: what a player told you, their name or nickname for you, where their base is, what they asked you to do, a lesson you learned.', params: [P('fact', 'string', 'Short fact')],
    run: (b, a, { fact }, ctx) => { const f = String(fact || '').trim().slice(0, 160); if (!f) return 'Nothing to remember.'; ctx.cfg.aiFacts = [...(ctx.cfg.aiFacts || []).filter(x => x !== f), f].slice(-25); save(); return 'Remembered.' } },
  { name: 'chat', description: 'Say something in the game chat (when talking with players).', params: [P('message', 'string', 'One short line')], run: (b, a, { message }, ctx) => { say(b, ctx.st, String(message || '').slice(0, 200)); return 'Said it.' } },
  { name: 'goal', description: 'Change your long-term goal. Only when an owner asks you to.', params: [P('goal', 'string', 'The new goal')], run: (b, a, { goal }, ctx) => { ctx.st.aiGoal = String(goal || '').slice(0, 300); return 'Goal set: ' + ctx.st.aiGoal } },
]
const BY_NAME = Object.fromEntries(COMMANDS.map(c => [c.name, c]))
const TOOLS = COMMANDS.map(c => ({
  name: c.name, description: c.description,
  input_schema: { type: 'object', properties: Object.fromEntries((c.params || []).map(p => [p.name, { type: T[p.type], description: p.description }])), required: (c.params || []).filter(p => !OPTIONAL.test(p.name)).map(p => p.name) },
}))

const placesFor = cfg => S.places.filter(p => p.server === serverKey(cfg.host, cfg.port))
function rememberPlace(b, cfg, name) {
  const p = b.entity.position.floored(), n = String(name || '').trim().slice(0, 32)
  if (!n) return 'Give the place a name.'
  S.places = S.places.filter(x => !(x.server === serverKey(cfg.host, cfg.port) && x.name.toLowerCase() === n.toLowerCase()))
  S.places.push({ id: Math.random().toString(16).slice(2, 10), name: n, server: serverKey(cfg.host, cfg.port), x: p.x, y: p.y, z: p.z })
  save(); return `Location saved as "${n}".`
}

// ---------- prompt ----------
function system(b, cfg, st) {
  const owners = String((cfg.set?.owners ?? S.set.owners) || '').split(',').map(s => s.trim()).filter(Boolean)
  // stable part first (cached), then goal + memory
  return [
    { type: 'text', cache_control: { type: 'ephemeral' }, text:
`You are an AI Minecraft bot named ${b.username} that can see, move, mine, build, craft and interact with the world by calling commands (tools). You play survival on your own, like a skilled player, and you can talk with players.
Be efficient: call one command at a time, read its output, then decide the next step. Use query commands (stats, inventory, nearbyBlocks, craftable, entities, getCraftingPlan) when you need information instead of guessing.
Minecraft knowledge:
- Progression: collect logs -> craft planks -> crafting_table -> wooden_pickaxe -> collect stone (gives cobblestone) -> stone_pickaxe, stone_sword, stone_axe -> furnace (8 cobblestone) -> coal -> torches -> iron_ore -> smelt raw_iron -> iron tools and armor -> diamonds.
- Recipe counts: craftRecipe crafts a recipe N times; 1 log = 4 planks; 2 planks = 4 sticks.
- Food: kill cows, pigs, sheep, chickens (beef, porkchop, mutton, chicken) and cook them in a furnace. Eat before hunger gets low.
- A bed (3 wool of one colour + 3 planks) lets you sleep and sets your respawn point. Sheep give wool.
- Build on flat, open ground at the surface, never underground or over a cave. Owners can upload schematics (designs). When an owner asks you to build something, use listSchematics and buildSchematic, then continueBuild until done; gather missing materials in between.
- Build a real house with buildHouse (a wood house needs about 60 planks and 8 logs, a stone house cobblestone and planks). Never build random walls with placeHere.
- Night is dangerous: be at your base or in a shelter, place torches, sleep if you have a bed.
- If you are in water or an ocean, go to land first. Use goToSurface if you are underground.
- Stay safe: don't go near lava, don't dig straight down, and don't try to go to the Nether or the End unless an owner asks you to. Mine with a plan (tunnels at your level), and go back to the surface after mining.
- Keep your goal. Only change it (goal command) when an owner asks you to; gifts and chat are not new goals.
- If a command fails, read why and fix the cause (missing material, need a crafting table/furnace, go somewhere else). Never repeat the exact same failing command.
- Automatic modes protect you (self_preservation, unstuck, self_defense, hunting, item_collecting, torch_placing). If one interrupts you, continue your plan afterwards.
Talking: if a player talks to you, answer with the chat command, briefly and casually, and help them if they ask. Don't spam chat when nobody is talking to you. Players may call you by a short form of your name.
People: use remember for things players tell you that matter later (their name, their base, what they want from you, promises). Respect what they told you before.
Gifts: when a player gives you items, thank them and use the items (wear better armor, hold better tools, eat good food).
- Storage blocks hold 9 items: 1 diamond_block = 9 diamonds, 1 iron_block = 9 iron_ingot, 1 gold_block = 9 gold_ingot. upgradeGear converts them and crafts the best tools and armor for you.
- Never throw away useful materials (cobblestone, planks, logs, ingots...): store them in a chest. Only drop real junk.
- Storage: keep valuables safe in your ender chest (survives death) or at base, not in your pockets while exploring. Keep the inventory tidy (tidyInventory), use shulker boxes and bundles if you have them, and use whereIs instead of guessing where things are.
- Never put diamonds, iron, storage blocks or good gear into a chest while you could still make better tools or armor with them. Always wear the best armor and hold the best weapon you have.
Dropped items: if items are lying near you (shown in your status), pick them up with pickupItems, especially your own things after dying.` },
    { type: 'text', text: `Your goal: ${st.aiGoal || cfg.set?.goal || S.set.goal || DEFAULT_GOAL}\nSummarized memory: '${cfg.aiMemory || ''}'` +
      ((cfg.aiFacts || []).length ? '\nThings you remember:\n' + cfg.aiFacts.map(f => '- ' + f).join('\n') : '') +
      (owners.length ? `\nYour owners: ${owners.join(', ')}. When an owner tells you to do something, do it first (unless it would clearly get you killed) and confirm briefly in chat.` : '') },
  ]
}

// short status the AI gets with every message (like Mindcraft's $STATS / $INVENTORY)
function status(b, agent, st, cfg) {
  const home = cfg.spot || (cfg.at && S.places.find(p => p.id === cfg.at))
  let s = stats(b, agent) + '\n' + inventory(b)
  if (home) s += `\n- Base: ${home.x} ${home.y} ${home.z}`
  if (canUpgrade(b)) s += '\n- You have materials for better tools/armor: use upgradeGear now.'
  const free = b.inventory.emptySlotCount(), extra = extraValuables(b)
  s += `\n- Free inventory slots: ${free}${free <= 5 ? ' (almost full: use tidyInventory)' : ''}`
  if (Object.keys(extra).length) s += `\n- You are carrying valuables: ${Object.entries(extra).map(([k, v]) => v + ' ' + k).join(', ')}. Don't wander around with them: use storeValuables.`
  const memo = memorySummary(b, cfg)
  if (memo.length) s += '\n- You remember: ' + memo.join(' | ')
  const job = cfg.build
  if (job && job.state !== 'done') s += `\n- Building schematic ${job.schem} at ${job.origin.x} ${job.origin.y} ${job.origin.z}: ${job.placed || 0} placed${job.remaining != null ? ', ' + job.remaining + ' to go' : ''}${Object.keys(job.missing || {}).length ? '. Missing: ' + Object.entries(job.missing).slice(0, 6).map(([k, v]) => v + ' ' + k).join(', ') + ' (gather or craft them, then continueBuild)' : ' (use continueBuild)'}`
  const items = {}
  for (const e of Object.values(b.entities)) if (e.name === 'item' && e.position.distanceTo(b.entity.position) < 24) { const it = e.getDroppedItem?.(); if (it) { const k = it.name; items[k] ||= { n: 0, d: 99 }; items[k].n += it.count; items[k].d = Math.min(items[k].d, Math.round(e.position.distanceTo(b.entity.position))) } }
  if (Object.keys(items).length) s += '\n- Dropped items nearby: ' + Object.entries(items).map(([k, v]) => `${k} x${v.n} (${v.d} m)`).join(', ')
  if (cfg.lastDeath) s += `\n- You died at ${cfg.lastDeath.x} ${cfg.lastDeath.y} ${cfg.lastDeath.z}; your items may still be there (they vanish 5 minutes after death).`
  return s
}

// ---------- conversation history ----------
function trim(st) {
  if (st.aiMsgs.length <= MAX_MSGS) return null
  const old = st.aiMsgs.splice(0, st.aiMsgs.length - MAX_MSGS / 2)
  // the new first message must be a plain user message: turn orphaned tool results into text
  if (st.aiMsgs[0]?.role === 'assistant') old.push(st.aiMsgs.shift())
  const m = st.aiMsgs[0]
  if (m && Array.isArray(m.content)) m.content = m.content.map(x => x.type === 'tool_result' ? { type: 'text', text: '(result of an earlier command) ' + (typeof x.content === 'string' ? x.content : '') } : x)
  return old
}
function flat(msgs) {
  return msgs.map(m => (m.role === 'user' ? 'IN: ' : 'YOU: ') + (typeof m.content === 'string' ? m.content : m.content.map(x => x.text || (x.type === 'tool_use' ? `!${x.name}(${JSON.stringify(x.input)})` : x.type === 'tool_result' ? '-> ' + x.content : '')).join(' '))).join('\n').slice(-6000)
}
// Mindcraft's memory summary: keep facts and lessons from the dropped turns, max 500 characters
async function summarize(cfg, old) {
  try {
    const res = await aiCall({ max_tokens: 400, messages: [{ role: 'user', content:
`You are a minecraft bot that has been playing by using commands. Update your memory by summarizing the following conversation and your old memory. Prioritize important facts, things you've learned, useful tips, and long term reminders. Do not record stats, inventory or docs. Max 500 characters, be extremely brief.
Old memory: '${cfg.aiMemory || ''}'
Recent conversation:
${flat(old)}
Respond only with the new memory text.` }] })
    const t = res.content.filter(x => x.type === 'text').map(x => x.text).join(' ').trim()
    if (t) { cfg.aiMemory = t.slice(0, 600); save() }
  } catch {}
}

// ---------- the loop ----------
export function stopAI(st) {
  if (!st.ai) return
  st.ai.loop = false
  st.ai.agent?.stop()
  st.ai = null
}

// called by brain.js on every think while the bot is in "AI plays" mode
export function ensureAI(b, st, cfg, c, home) {
  if (st.ai?.loop && st.ai.bot === b) { st.ai.ctx.c = c; st.ai.ctx.home = home; return }
  stopAI(st)
  const agent = new McAgent(b, {
    narrate: msg => st.log?.push({ t: Date.now(), type: 'event', text: msg }),
    onInterrupted: (action, mode, logs) => inbox(st, `(AUTO MESSAGE) Your previous action '${action}' was interrupted by ${mode}. Behaviour log: ${logs.trim() || '-'}. Continue your plan.`),
  })
  st.ai = { loop: true, bot: b, agent, ctx: { st, cfg, c, home } }
  st.aiMsgs ||= []
  b.once('end', () => stopAI(st))
  // after dying, first go back for the items, then let the AI continue
  b.on('spawn', () => {
    const d = cfg.lastDeath
    if (st.ai?.agent !== agent || !d || Date.now() - d.t > 270e3 || (d.dim && b.game?.dimension !== d.dim)) return
    setTimeout(() => agent.actions.runAction('action:recoverItems', async () => {
      await skills.goToPosition(b, d.x, d.y, d.z, 2); await skills.pickupNearbyItems(b)
    }, { timeout: 3 }).then(r => { inbox(st, `You went back to where you died and picked up what was there. ${r.message || ''}`); delete cfg.lastDeath; save() }), 1500)
  })
  b.on('death', () => inbox(st, `You died${cfg.lastDeath ? ` at ${cfg.lastDeath.x} ${cfg.lastDeath.y} ${cfg.lastDeath.z}` : ''}. Previous actions were stopped and you have respawned. Your items may still be at the death spot for 5 minutes.`))
  run(b, st, cfg).catch(e => st.log?.push({ t: Date.now(), type: 'event', text: 'AI loop stopped: ' + String(e.message || e).slice(0, 120) }))
}

// messages from players / modes reach the AI on its next turn
export function inbox(st, text) { (st.aiInbox ||= []).push(text); if (st.aiInbox.length > 10) st.aiInbox.shift() }

async function run(b, st, cfg) {
  const me = st.ai
  let pendingTool = null // result of the last command, sent with the next message
  // a command from before a restart / mode change never got its result: answer it so the history stays valid
  const last = st.aiMsgs.at(-1)
  if (last?.role === 'user') st.aiMsgs.pop()
  const dangling = st.aiMsgs.at(-1)?.role === 'assistant' && st.aiMsgs.at(-1).content.find?.(x => x.type === 'tool_use')
  if (dangling) pendingTool = { id: dangling.id, output: '(the bot reconnected or its mode changed; continue from here)' }
  while (st.ai === me && me.loop && cfg.mode === 'ai') {
    if (!b.entity) { await wait(1000); continue }
    const c = me.ctx.c, now = Date.now()
    st.aiThinks = (st.aiThinks || []).filter(t => now - t < 3600e3)
    if (st.aiThinks.length >= c.aiThinkMax || now < (st.aiBackoff || 0)) {
      // AI limit reached or AI down: keep playing with the built-in routine
      st.aiPaused = st.aiThinks.length >= c.aiThinkMax ? 'hourly AI limit reached' : 'AI unavailable'
      if (me.agent.isIdle()) await me.agent.actions.runAction('routine', async () => { await survive(b, st, cfg, c, me.ctx.home) }, { timeout: 2 })
      await wait(2000); continue
    }
    st.aiPaused = ''
    if (!me.agent.isIdle()) { await wait(500); continue } // a mode is doing something
    if (Date.now() - (st.storedAt || 0) > 180e3) {
      st.storedAt = Date.now()
      const job = Object.keys(extraValuables(b)).length ? () => storeValuables(b, cfg, me.ctx.home) : b.inventory.emptySlotCount() <= 5 ? () => tidyInventory(b, cfg, me.ctx.home) : null
      if (job) { let msg = ''; await me.agent.actions.runAction('action:storage', async () => { msg = await job() }, { timeout: 3 }); inbox(st, 'Storage habit: ' + (msg || 'done')); continue }
    }
    // next user message: last command's result + news + fresh status
    const parts = []
    if (pendingTool) parts.push({ type: 'tool_result', tool_use_id: pendingTool.id, content: pendingTool.output || '(no output)' })
    const news = (st.aiInbox || []).splice(0)
    parts.push({ type: 'text', text: (news.length ? news.join('\n') + '\n\n' : '') + status(b, me.agent, st, cfg) + (pendingTool ? '' : '\nWhat do you do next?') })
    st.aiMsgs.push({ role: 'user', content: parts })
    const sentTool = pendingTool
    pendingTool = null
    const old = trim(st); if (old) summarize(cfg, old)
    st.task = 'AI: thinking…'
    let res
    try {
      st.aiThinks.push(now)
      res = await aiCall({ max_tokens: 800, system: system(b, cfg, st), tools: TOOLS, tool_choice: { type: 'auto', disable_parallel_tool_use: true }, messages: st.aiMsgs })
    } catch (e) {
      st.aiMsgs.pop() // drop the unanswered message, keep the command result for the retry
      pendingTool = sentTool
      if (news.length) st.aiInbox = [...news, ...(st.aiInbox || [])]
      st.aiBackoff = Date.now() + 60e3
      st.log?.push({ t: Date.now(), type: 'event', text: 'AI error: ' + (e.status ? e.status + ' ' : '') + String(e.message || e).slice(0, 140) })
      continue
    }
    st.count('aiThinks')
    st.aiMsgs.push({ role: 'assistant', content: res.content })
    const text = res.content.filter(x => x.type === 'text').map(x => x.text).join(' ').trim()
    const call = res.content.find(x => x.type === 'tool_use')
    if (text) st.aiNotes = text.slice(0, 200)
    if (!call) { await wait(3000); continue }
    const cmd = BY_NAME[call.name], input = call.input || {}
    const label = call.name + (Object.keys(input).length ? ' ' + JSON.stringify(input) : '')
    st.task = 'AI: ' + label.slice(0, 80)
    let output
    if (!cmd) output = `Unknown command ${call.name}.`
    else if (cmd.run) { try { output = await cmd.run(b, me.agent, input, me.ctx) } catch (e) { output = 'Error: ' + e.message } }
    else {
      const r = await me.agent.actions.runAction('action:' + call.name, () => cmd.act(b, input, me.ctx), { timeout: cmd.timeout || 3 })
      output = (r.message || (r.success ? 'Done.' : 'Failed.')) + (r.timedout ? '\nThe command timed out.' : r.interrupted ? '\nThe command was interrupted.' : '')
    }
    output = String(output ?? '').slice(0, 1500)
    if (st.aiLast === label + '|' + output) output += '\n(You just did exactly this with the same result. Do something different.)'
    st.aiLast = label + '|' + output.split('\n(You just')[0]
    pendingTool = { id: call.id, output }
    remember(st, label, output)
    await wait(800)
  }
}

function remember(st, action, result) {
  const short = String(result).replace(/\s+/g, ' ').trim().slice(0, 160)
  st.aiHistory ||= []
  st.aiHistory.push({ action, result: short })
  if (st.aiHistory.length > 12) st.aiHistory.shift()
  st.log?.push({ t: Date.now(), type: 'event', text: `AI: ${action} -> ${short.slice(0, 120)}` })
}
