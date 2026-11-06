// "Real player" behaviour. think() runs about once a second per bot and picks the most
// important thing to do: survive, gear up, sleep, then whatever its mode says.
import pf from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { S, eff } from './store.js'
import { survive } from './survival.js'

const { goals } = pf
export const rnd = (a, b) => a + Math.random() * (b - a)
const chance = p => Math.random() < p
const near = (b, x, r) => x.position.distanceTo(b.entity.position) < r

// modes a bot can be in (stored per bot)
export const MODES = ['roam', 'stay', 'follow', 'guard', 'farm', 'survive', 'idle']

// ---- gear: best weapon and armor by material
const TIER = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite']
const tier = n => TIER.findIndex(t => n.startsWith(t)) + 1
const weaponScore = n => /_sword$/.test(n) ? 10 + tier(n) * 2 : /_axe$/.test(n) ? 9 + tier(n) * 2 : /trident|mace/.test(n) ? 22 : 0
const ARMOR = { head: /_helmet$/, torso: /_chestplate$/, legs: /_leggings$/, feet: /_boots$/ }
const ARMOR_SLOT = { head: 5, torso: 6, legs: 7, feet: 8 }
const armorScore = n => n.startsWith('leather') ? 1 : n.startsWith('chainmail') ? 3 : tier(n) + 1

async function gearUp(b) {
  const items = b.inventory.items()
  for (const [dest, re] of Object.entries(ARMOR)) {
    const worn = b.inventory.slots[ARMOR_SLOT[dest]], best = items.filter(i => re.test(i.name)).sort((x, y) => armorScore(y.name) - armorScore(x.name))[0]
    if (best && (!worn || armorScore(best.name) > armorScore(worn.name))) await b.equip(best, dest)
  }
}
async function holdWeapon(b) {
  const best = b.inventory.items().filter(i => weaponScore(i.name)).sort((x, y) => weaponScore(y.name) - weaponScore(x.name))[0]
  if (best && b.heldItem?.name !== best.name) await b.equip(best, 'hand')
}

// ---- farming: crop block -> { ripe age, seed item }
const CROPS = { wheat: [7, 'wheat_seeds'], carrots: [7, 'carrot'], potatoes: [7, 'potato'], beetroots: [3, 'beetroot_seeds'] }
const ripe = bl => CROPS[bl?.name] && bl.getProperties().age >= CROPS[bl.name][0]

async function harvest(b, st, crop) {
  const seed = CROPS[crop.name][1], soil = b.blockAt(crop.position.offset(0, -1, 0))
  await b.pathfinder.goto(new goals.GoalNear(crop.position.x, crop.position.y, crop.position.z, 2))
  await b.dig(b.blockAt(crop.position), true)
  st.count('harvested')
  await new Promise(r => setTimeout(r, 400))
  // walk over the drops, then replant
  const drop = b.nearestEntity(x => x.name === 'item' && x.position.distanceTo(crop.position) < 3)
  if (drop) await b.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)).catch(() => {})
  await plant(b, soil, seed)
}
async function plant(b, soil, seed) {
  const item = b.inventory.items().find(i => i.name === seed) || b.inventory.items().find(i => Object.values(CROPS).some(c => c[1] === i.name))
  if (!item || soil?.name !== 'farmland' || b.blockAt(soil.position.offset(0, 1, 0))?.name !== 'air') return
  await b.pathfinder.goto(new goals.GoalNear(soil.position.x, soil.position.y + 1, soil.position.z, 2)).catch(() => {})
  await b.equip(item, 'hand')
  await b.placeBlock(soil, new Vec3(0, 1, 0))
}

// where a bot hangs around: a saved place, or a spot set with !stay / "here" / x y z
export function homeOf(cfg) {
  const p = cfg.at && S.places.find(x => x.id === cfg.at)
  return p ? { x: p.x, y: p.y, z: p.z, label: p.name } : cfg.spot ? { ...cfg.spot, label: cfg.spot.label || `${cfg.spot.x} ${cfg.spot.y} ${cfg.spot.z}` } : null
}

function go(b, st, goal, task, dynamic = false) { st.task = task; b.pathfinder.setGoal(goal, dynamic) }
function hold(b, key, ms) { b.setControlState(key, true); setTimeout(() => b.setControlState(key, false), ms) }
const label = m => m.displayName || m.name

export async function think(b, st, cfg) {
  const e = b.entity, c = eff(cfg)
  if (!e || st.busy || b.isSleeping) return
  const mode = cfg.mode || 'roam', home = homeOf(cfg)
  const run = async (task, fn) => { st.busy = true; st.task = task; try { await fn() } catch {} st.busy = false }
  if (mode !== 'survive' && st.survMoves) { st.survMoves = false; st.moves?.() } // back to no-dig walking

  // distance walked (ignore teleports)
  if (st.last) { const d = e.position.distanceTo(st.last); if (d < 10) st.count('walked', d) }
  st.last = e.position.clone()

  if (e.isInWater) b.setControlState('jump', true) // swim up, don't drown
  else if (st.swim) b.setControlState('jump', false)
  st.swim = e.isInWater

  // 1. eat when hungry
  if (c.eat && b.food < 14) {
    const food = b.inventory.items().find(i => b.registry.foodsByName[i.name])
    if (food) return run('eating', async () => { await b.equip(food, 'hand'); await b.consume() })
  }

  // 2. hostile mobs: fight, flee or ignore. Guards always fight; followers also protect their player.
  const buddy = mode === 'follow' && cfg.follow && b.players[cfg.follow]?.entity
  const mob = b.nearestEntity(x => x.type === 'hostile' && (near(b, x, mode === 'guard' ? c.guardR : 10) || (buddy && c.combat === 'fight' && x.position.distanceTo(buddy.position) < 8)))
  const style = mode === 'guard' ? 'fight' : c.combat
  if (mob && style !== 'ignore') {
    if (style === 'fight' && b.health > 6) {
      if (st.target !== mob.id) { st.target = mob.id; if (c.gear) await holdWeapon(b).catch(() => {}) }
      if (near(b, mob, 3.2)) {
        b.pathfinder.stop(); await b.lookAt(mob.position.offset(0, mob.height * 0.8, 0), true)
        if (Date.now() - (st.hit || 0) > 650) { st.hit = Date.now(); b.attack(mob) }
        st.task = 'fighting ' + label(mob)
      } else go(b, st, new goals.GoalFollow(mob, 2), 'fighting ' + label(mob), true)
      return
    }
    if (st.fleeing !== mob.id) { st.fleeing = mob.id; go(b, st, new goals.GoalInvert(new goals.GoalFollow(mob, 16)), 'running from ' + label(mob), true) }
    return
  }
  if (st.fleeing || st.target) { st.fleeing = st.target = null; b.pathfinder.stop() }

  // 3. wear the best armor (checked every ~15s)
  if (c.gear && Date.now() - (st.geared || 0) > 15e3) { st.geared = Date.now(); await gearUp(b).catch(() => {}) }

  // 4. sleep at night if a bed is close (not while following someone)
  if (c.sleep && mode !== 'follow' && !b.time.isDay && Date.now() - (st.triedBed || 0) > 30e3) {
    const bed = b.findBlock({ matching: bl => b.isABed(bl), maxDistance: 24 })
    if (bed) {
      st.triedBed = Date.now()
      return run('going to bed', async () => {
        await b.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2))
        await b.sleep(bed); st.task = 'sleeping'
      })
    }
  }

  // 5. pick up dropped items nearby (not while following)
  if (c.pickup && mode !== 'follow' && !b.pathfinder.isMoving()) {
    const item = b.nearestEntity(x => x.name === 'item' && near(b, x, 8) && (!home || x.position.distanceTo(home) < c.homeR + 8))
    if (item && b.inventory.emptySlotCount() > 0) return go(b, st, new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.5), 'picking up an item')
  }

  // 6. mode
  const player = c.lookPlayers && b.nearestEntity(x => x.type === 'player' && near(b, x, 8))
  if (player && chance(0.6)) b.lookAt(player.position.offset(0, 1.6, 0))

  if (mode === 'follow') {
    if (!buddy) { st.task = 'looking for ' + (cfg.follow || '?'); return }
    if (st.following !== buddy.id || !b.pathfinder.goal) { st.following = buddy.id; go(b, st, new goals.GoalFollow(buddy, 2), 'following ' + cfg.follow, true) }
    else st.task = 'following ' + cfg.follow
    return
  }
  st.following = null

  if (mode === 'farm') {
    if (!home) { st.task = 'farm: no place set'; return }
    const center = new Vec3(home.x, home.y, home.z)
    const crop = b.findBlock({ point: center, matching: bl => !!CROPS[bl.name], useExtraInfo: ripe, maxDistance: c.farmR, count: 1 })
    if (crop) return run('harvesting ' + crop.name, () => harvest(b, st, crop))
    // replant empty farmland
    const soil = b.findBlock({ point: center, matching: bl => bl.name === 'farmland', useExtraInfo: bl => b.blockAt(bl.position.offset(0, 1, 0))?.name === 'air', maxDistance: c.farmR })
    const hasSeed = b.inventory.items().some(i => Object.values(CROPS).some(x => x[1] === i.name))
    if (soil && hasSeed) return run('planting', () => plant(b, soil, null))
  }

  if (mode === 'survive' && Date.now() > (st.survIdle || 0)) {
    st.busy = true; let r
    try { r = await survive(b, st, cfg, c, home); st.survErr = '' } catch (err) {
      const m = String(err.message || err).slice(0, 120); st.task = 'survival: ' + m
      if (m !== st.survErr) { st.survErr = m; st.log?.push({ t: Date.now(), type: 'event', text: 'survival: ' + m }) }
    }
    st.busy = false
    if (r === 'idle') st.survIdle = Date.now() + 60e3 // base finished: hang out a minute, then check again
    else return
  }

  if (b.pathfinder.isMoving()) { if (c.fidget && chance(0.05)) b.swingArm(); return }

  if (mode !== 'roam' && mode !== 'idle' && home && e.position.distanceTo(home) > (mode === 'farm' ? c.farmR : c.homeR) + 4)
    return go(b, st, new goals.GoalNear(home.x, home.y, home.z, 1), 'going → ' + home.label)

  st.task = mode === 'idle' ? 'idle (AFK)' : mode === 'guard' ? 'guarding ' + (home?.label || 'here') : mode === 'farm' ? 'farming ' + home.label + ' (waiting for crops)' : mode === 'survive' ? st.task
    : home && mode === 'stay' ? 'at ' + home.label : 'roaming'
  const r = Math.random()
  if (r < 0.25 && mode !== 'idle') { // walk somewhere nearby
    const o = (mode !== 'roam' && home) || e.position, d = mode !== 'roam' && home ? c.homeR : c.roam
    if (d > 0) b.pathfinder.setGoal(new goals.GoalNear(o.x + rnd(-d, d), o.y, o.z + rnd(-d, d), 1))
  } else if (r < 0.45 && !player) b.look(e.yaw + rnd(-1.5, 1.5), rnd(-0.4, 0.3)) // glance around
  else if (!c.fidget) return
  else if (r < 0.5) hold(b, 'jump', 300)
  else if (r < 0.53) hold(b, 'sneak', rnd(400, 1500))
  else if (r < 0.56) b.swingArm()
}
