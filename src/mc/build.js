// Build houses from blueprints, block by block.
// Blueprints (blueprints/*.json), getTypeOfGeneric, blockSatisfied and rotateXZ adapted from Mindcraft
// (https://github.com/mindcraft-bots/mindcraft), src/agent/npc/build_goal.js, utils.js and construction/*.json.
// Copyright (c) 2024 Kolby Nottingham. MIT License, see src/mc/LICENSE-mindcraft.
// Changes for Wanderbots: never break utility blocks, optional furniture, safe rotations, progress + missing report.
import fs from 'node:fs'
import { Vec3 } from 'vec3'
import * as skills from './skills.js'
import * as world from './world.js'
import * as mc from './mcdata.js'

const load = n => JSON.parse(fs.readFileSync(new URL(`./blueprints/${n}.json`, import.meta.url)))
export const BLUEPRINTS = { wood: load('small_wood_house'), stone: load('small_stone_house'), dirt: load('dirt_shelter') }
const OPTIONAL = new Set(['chest', 'bed', 'torch', 'door']) // furniture: placed if we have it, not required to finish
const KEEP = /crafting_table|chest|furnace|_bed$|torch|_door$/ // never break these to make room

// ---- from Mindcraft npc/utils.js
export function getTypeOfGeneric(bot, block_name) {
  if (mc.MATCHING_WOOD_BLOCKS.includes(block_name)) {
    // most common wood type in inventory, else nearest logs, else oak
    const count = {}
    for (const [item, n] of Object.entries(world.getInventoryCounts(bot)))
      for (const wood of mc.WOOD_TYPES) if (item.startsWith(wood + '_')) count[wood] = (count[wood] || 0) + n
    const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0]
    if (best) return best[0] + '_' + block_name
    const logs = world.getNearestBlocks(bot, mc.WOOD_TYPES.map(w => w + '_log'), 16, 1)
    if (logs.length) return logs[0].name.replace(/_log$/, '') + '_' + block_name
    return 'oak_' + block_name
  }
  if (block_name === 'bed') {
    const count = {}
    for (const [item, n] of Object.entries(world.getInventoryCounts(bot))) for (const c of mc.WOOL_COLORS) if (item === c + '_wool' || item === c + '_bed') count[c] = (count[c] || 0) + n
    const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0]
    return (best ? best[0] : 'white') + '_bed'
  }
  return block_name
}
export function blockSatisfied(target, block) {
  if (target === 'dirt') return block.name === 'dirt' || block.name === 'grass_block'
  if (mc.MATCHING_WOOD_BLOCKS.includes(target)) return block.name.endsWith(target)
  if (target === 'bed') return block.name.endsWith('bed')
  if (target === 'torch') return block.name.includes('torch')
  if (target === 'air') return ['air', 'cave_air', 'void_air'].includes(block.name) || KEEP.test(block.name)
  return block.name === target
}
// Mindcraft's rotateXZ only works for square blueprints at 90/270 degrees; these are rectangular, so use 0 or 180
export const rotateXZ = (x, z, o, sx, sz) => o === 2 ? [sx - x - 1, sz - z - 1] : [x, z]

// where the house goes: its south-west corner, so that the base point ends up inside it
export function housePlan(bot, cfg, style, home) {
  if (cfg.house?.style === style) return cfg.house
  const bp = BLUEPRINTS[style], sx = bp.blocks[0][0].length, sz = bp.blocks[0].length
  const base = home || bot.entity.position.floored()
  return { style, x: base.x - Math.floor(sx / 2), y: base.y, z: base.z - Math.floor(sz / 2), o: 0 }
}

function cells(plan) {
  const bp = BLUEPRINTS[plan.style], sx = bp.blocks[0][0].length, sz = bp.blocks[0].length, sy = bp.blocks.length
  const out = []
  for (let y = bp.offset; y < sy + bp.offset; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const [rx, rz] = rotateXZ(x, z, plan.o, sx, sz)
    const name = bp.blocks[y - bp.offset][rz][rx]
    if (name) out.push({ name, pos: new Vec3(plan.x + x, plan.y + y, plan.z + z) })
  }
  return out
}

// what's still to do and which materials are missing (furniture is optional)
export function houseStatus(bot, plan) {
  const inv = world.getInventoryCounts(bot), need = {}, missing = {}
  let todo = 0, total = 0
  for (const c of cells(plan)) {
    if (c.name !== 'air' && !OPTIONAL.has(c.name)) total++
    const cur = bot.blockAt(c.pos)
    if (!cur || blockSatisfied(c.name, cur)) continue
    if (c.name === 'air' || OPTIONAL.has(c.name)) continue
    todo++
    const t = getTypeOfGeneric(bot, c.name); need[t] = (need[t] || 0) + 1
  }
  for (const [t, n] of Object.entries(need)) if ((inv[t] || 0) < n) missing[t] = n - (inv[t] || 0)
  return { todo, total, missing }
}

// place / clear up to `max` blocks of the house. Returns a short report for the AI.
export async function buildHouse(bot, plan, max = 40) {
  let placed = 0, cleared = 0, skipped = 0
  const inv = () => world.getInventoryCounts(bot)
  for (const c of cells(plan)) {
    if (bot.interrupt_code || placed + cleared >= max) break
    const cur = bot.blockAt(c.pos)
    if (!cur || blockSatisfied(c.name, cur)) continue
    if (!['air', 'cave_air', 'void_air'].includes(cur.name) && !KEEP.test(cur.name) ) {
      if (await skills.breakBlockAt(bot, c.pos.x, c.pos.y, c.pos.z)) cleared++
      await new Promise(r => setTimeout(r, 150))
    }
    if (c.name === 'air') continue
    const t = getTypeOfGeneric(bot, c.name)
    if (!(inv()[t] > 0)) { skipped++; continue }
    if (await skills.placeBlock(bot, t, c.pos.x, c.pos.y, c.pos.z)) placed++
  }
  const s = houseStatus(bot, plan)
  const miss = Object.entries(s.missing).map(([t, n]) => `${n} ${t}`).join(', ')
  return { placed, cleared, ...s, report: `${plan.style} house: placed ${placed}, cleared ${cleared}. ${s.todo ? `${s.todo} of ${s.total} blocks still to place.` : 'The house is complete!'}${miss ? ' Missing: ' + miss + '.' : ''}` }
}
