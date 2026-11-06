// "Real player" behaviour. think() runs about once a second per bot and picks the most
// important thing to do: survive, gear up, sleep, then whatever its mode says.
import pf from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { S, eff, save } from './store.js'
import { survive, goto } from './survival.js'
import { ensureAI, stopAI } from './aiplay.js'
import { fightPlayer } from './combat.js'
import { upgradeGear } from './gear.js'
import { runBuild } from './schemstore.js'

const { goals } = pf
export const rnd = (a, b) => a + Math.random() * (b - a)
const chance = p => Math.random() < p
const near = (b, x, r) => x.position.distanceTo(b.entity.position) < r

// modes a bot can be in (stored per bot)
export const MODES = ['ai', 'auto', 'roam', 'stay', 'follow', 'guard', 'farm', 'survive', 'idle']

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

// best food to eat now: most saturation, skipping bad food unless starving
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'suspicious_stew'])
function bestFood(b) {
  const foods = b.inventory.items().filter(i => b.registry.foodsByName[i.name] && (b.food < 6 || !BAD_FOOD.has(i.name)))
  return foods.sort((x, y) => (b.registry.foodsByName[y.name].saturation || 0) - (b.registry.foodsByName[x.name].saturation || 0))[0]
}

function go(b, st, goal, task, dynamic = false) { st.task = task; b.pathfinder.setGoal(goal, dynamic) }
function hold(b, key, ms) { b.setControlState(key, true); setTimeout(() => b.setControlState(key, false), ms) }
const label = m => m.displayName || m.name

// auto mode: weighted pick of what to do next, kept for 1-2.5 minutes or until it's finished
const ACT_LABEL = { survive: 'building up the base', farm: 'farming', social: 'hanging out', explore: 'exploring', roam: 'relaxing at base' }
function pickActivity(b, st, c, home) {
  const now = Date.now()
  if (st.auto && !st.auto.done && now < st.auto.until) return st.auto.act
  const options = []
  if (now > (st.baseDone || 0)) options.push(['survive', 5])
  const farmland = b.registry.blocksByName.farmland
  if (farmland && b.findBlock({ point: new Vec3(home.x, home.y, home.z), matching: farmland.id, maxDistance: c.farmR })) options.push(['farm', 3])
  const friend = b.nearestEntity(x => x.type === 'player' && x.username !== b.username && x.position.distanceTo(b.entity.position) < 48)
  if (friend) options.push(['social', 2])
  options.push(['explore', 1.5], ['roam', 1])
  let r = Math.random() * options.reduce((n, o) => n + o[1], 0), act = 'roam'
  for (const [a, w] of options) { if ((r -= w) <= 0) { act = a; break } }
  st.auto = { act, until: now + rnd(60e3, 150e3), friend: friend?.username }
  st.following = null; b.pathfinder.stop()
  st.log?.push({ t: now, type: 'event', text: 'auto: ' + ACT_LABEL[act] + (act === 'social' ? ' with ' + friend.username : '') })
  return act
}

const mobNear = b => !!b.nearestEntity(x => x.type === 'hostile' && x.position.distanceTo(b.entity.position) < 8)

export async function think(b, st, cfg) {
  const e = b.entity, c = eff(cfg)
  // while the AI's action runs, a mob right next to us interrupts it so the reflexes below can react
  if (e && st.busy && st.aiRunning && c.combat !== 'ignore') {
    const danger = b.nearestEntity(x => x.type === 'hostile' && x.position.distanceTo(e.position) < (x.name === 'creeper' ? 7 : 5))
    if (danger && !st.abort) { st.abort = true; b.pathfinder.stop(); try { b.stopDigging() } catch {} }
  }
  if (!e || st.busy || b.isSleeping) return
  if (cfg.build?.state === 'running' && !st.ai && !mobNear(b)) { // building a schematic
    st.busy = true; st.task = `building ${cfg.build.schem} (${cfg.build.placed || 0} placed)`
    b.interrupt_code = false // a leftover stop request from AI mode would skip every block
    try { const r = await runBuild(b, cfg, { max: 30 }); st.log?.push({ t: Date.now(), type: 'event', text: r }); if (cfg.build.state !== 'running') st.task = r } catch (e) { st.log?.push({ t: Date.now(), type: 'event', text: 'build error: ' + e.message }) }
    st.busy = false; return
  }
  if (st.gearUpgrade && !st.ai) { // got diamonds/iron: make and wear the best gear
    st.gearUpgrade = false; st.busy = true; st.task = 'upgrading gear'
    try { st.log?.push({ t: Date.now(), type: 'event', text: 'gear: ' + (await upgradeGear(b)).msg }) } catch {}
    st.busy = false; return
  }
  if (st.revenge && !st.ai) { // a player took us to half health: fight back (legit technique, see combat.js)
    const name = st.revenge.name
    st.busy = true; st.task = 'fighting ' + name
    try { st.log?.push({ t: Date.now(), type: 'event', text: 'fight with ' + name + ': ' + await fightPlayer(b, name) }) } catch {}
    st.busy = false; st.revenge = null; return
  }
  const mode = cfg.mode || 'roam', home = homeOf(cfg)
  const run = async (task, fn) => { st.busy = true; st.task = task; try { await fn() } catch {} st.busy = false }

  // distance walked (ignore teleports)
  if (st.last) { const d = e.position.distanceTo(st.last); if (d < 10) st.count('walked', d) }
  st.last = e.position.clone()

  // AI plays: Claude + Mindcraft's skills and modes take over completely
  if (mode === 'ai') { ensureAI(b, st, cfg, c, home); st.busy = false; return }
  if (st.ai) { stopAI(st); st.moves?.() }

  if (e.isInWater) b.setControlState('jump', true) // swim up, don't drown
  else if (st.swim) b.setControlState('jump', false)
  st.swim = e.isInWater

  // 1. eat when hungry, or when hurt and not full (food heals)
  if (c.eat && (b.food < 14 || (b.health < 14 && b.food < 18))) {
    const food = bestFood(b)
    if (food) return run('eating ' + (food.displayName || food.name), async () => { await b.equip(food, 'hand'); await b.consume() })
  }

  // 2. hostile mobs: fight, flee or ignore. Guards always fight; followers also protect their player.
  const buddy = mode === 'follow' && cfg.follow && b.players[cfg.follow]?.entity
  const mob = b.nearestEntity(x => x.type === 'hostile' && (near(b, x, mode === 'guard' ? c.guardR : 10) || (buddy && c.combat === 'fight' && x.position.distanceTo(buddy.position) < 8)))
  const creeper = mob?.name === 'creeper' && near(b, mob, 7)
  const style = creeper ? 'flee' : mode === 'guard' ? 'fight' : c.combat // never melee a creeper
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

  // 3. died recently: go back for the dropped items (they despawn after 5 minutes)
  const death = cfg.lastDeath
  if (death) {
    if (!c.recover || Date.now() - death.t > 270e3 || b.game.dimension !== death.dim) { delete cfg.lastDeath; save() }
    else if (!st.recovering) {
      st.recovering = true
      return run('getting my stuff back', async () => {
        try {
          const spot = new Vec3(death.x, death.y, death.z)
          await goto(b, new goals.GoalNear(death.x, death.y, death.z, 1), 90e3)
          for (let end = Date.now() + 20e3; Date.now() < end;) {
            const it = b.nearestEntity(x => x.name === 'item' && x.position.distanceTo(spot) < 10)
            if (!it) break
            await goto(b, new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.5), 8e3).catch(() => {})
          }
          st.log?.push({ t: Date.now(), type: 'event', text: 'went back to where it died and picked up its items' })
        } finally { delete cfg.lastDeath; save(); st.recovering = false }
      })
    }
  }

  // 4. badly hurt with nothing to eat: back off and let health come back
  if (b.health < 8 && mode !== 'follow' && !bestFood(b)) {
    if (home && e.position.distanceTo(home) > 3) return go(b, st, new goals.GoalNear(home.x, home.y, home.z, 1), 'hurt, going home')
    b.pathfinder.stop(); st.task = 'hurt, resting'; return
  }

  // 5. respawn point: use the bed at its base so it respawns at home
  if (c.setSpawn && home && Date.now() - (st.triedSpawn || 0) > 60e3) {
    const bed = b.findBlock({ point: new Vec3(home.x, home.y, home.z), matching: bl => b.isABed(bl), maxDistance: 8 })
    const key = bed && `${bed.position.x},${bed.position.y},${bed.position.z}`
    if (!bed && cfg.spawnBed) { delete cfg.spawnBed; save() }
    if (bed && cfg.spawnBed !== key) {
      st.triedSpawn = Date.now()
      return run('setting respawn point', async () => {
        await goto(b, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 30e3)
        await b.activateBlock(bed)
        await new Promise(r => setTimeout(r, 600))
        if (b.isSleeping) await b.wake().catch(() => {})
        cfg.spawnBed = key; save()
        st.log?.push({ t: Date.now(), type: 'event', text: 'respawn point set at bed ' + key })
      })
    }
  }

  // 6. night: stay at home instead of wandering in the dark
  if (c.nightHome && !b.time.isDay && home && (mode === 'roam' || mode === 'auto' || (mode === 'survive' && st.shelterDone))) {
    if (e.position.distanceTo(home) > 3) return go(b, st, new goals.GoalNear(home.x, home.y, home.z, 1), 'night, heading home')
    if (!b.pathfinder.isMoving()) { st.task = 'night, staying home'; if (chance(0.3)) b.look(e.yaw + rnd(-1, 1), 0); return }
  }

  // 7. wear the best armor (checked every ~15s)
  if (c.gear && Date.now() - (st.geared || 0) > 15e3) { st.geared = Date.now(); await gearUp(b).catch(() => {}) }

  // 8. sleep at night if a bed is close (not while following someone)
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

  // 9. pick up dropped items nearby (not while following)
  if (c.pickup && mode !== 'follow' && !b.pathfinder.isMoving()) {
    const item = b.nearestEntity(x => x.name === 'item' && near(b, x, 8) && (!home || x.position.distanceTo(home) < c.homeR + 8))
    if (item && b.inventory.emptySlotCount() > 0) return go(b, st, new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.5), 'picking up an item')
  }

  // 10. mode. In auto mode the bot picks its own activity like a player would.
  let m = mode
  if (mode === 'auto') {
    if (!home) { const p = e.position.floored(); cfg.spot = { x: p.x, y: p.y, z: p.z, label: 'base' }; save(); return }
    m = pickActivity(b, st, c, home)
  }
  if (m !== 'survive' && m !== 'ai' && st.survMoves) { st.survMoves = false; st.moves?.() } // back to no-dig walking
  const player = c.lookPlayers && b.nearestEntity(x => x.type === 'player' && near(b, x, 8))
  if (player && chance(0.6)) b.lookAt(player.position.offset(0, 1.6, 0))

  if (m === 'social') { // hang out near a player for a while
    const friend = b.players[st.auto.friend]?.entity
    if (!friend) { st.auto.done = true; return }
    if (st.following !== friend.id || !b.pathfinder.goal) { st.following = friend.id; go(b, st, new goals.GoalFollow(friend, 3), 'auto: hanging out with ' + st.auto.friend, true) }
    if (chance(0.5)) b.lookAt(friend.position.offset(0, 1.6, 0))
    return
  }
  if (m === 'explore') { // walk out somewhere new, then come back to other things
    if (b.pathfinder.isMoving()) { st.task = 'auto: exploring'; return }
    if (st.auto.went) { st.auto.done = true; return }
    const a = Math.random() * Math.PI * 2, d = rnd(30, 60)
    st.auto.went = true
    return go(b, st, new goals.GoalNearXZ(home.x + Math.cos(a) * d, home.z + Math.sin(a) * d, 3), 'auto: exploring')
  }
  if (m === 'follow') {
    if (!buddy) { st.task = 'looking for ' + (cfg.follow || '?'); return }
    if (st.following !== buddy.id || !b.pathfinder.goal) { st.following = buddy.id; go(b, st, new goals.GoalFollow(buddy, 2), 'following ' + cfg.follow, true) }
    else st.task = 'following ' + cfg.follow
    return
  }
  st.following = null

  if (m === 'farm') {
    if (!home) { st.task = 'farm: no place set'; return }
    const center = new Vec3(home.x, home.y, home.z)
    const crop = b.findBlock({ point: center, matching: bl => !!CROPS[bl.name], useExtraInfo: ripe, maxDistance: c.farmR, count: 1 })
    if (crop) return run('harvesting ' + crop.name, () => harvest(b, st, crop))
    // replant empty farmland
    const soil = b.findBlock({ point: center, matching: bl => bl.name === 'farmland', useExtraInfo: bl => b.blockAt(bl.position.offset(0, 1, 0))?.name === 'air', maxDistance: c.farmR })
    const hasSeed = b.inventory.items().some(i => Object.values(CROPS).some(x => x[1] === i.name))
    if (soil && hasSeed) return run('planting', () => plant(b, soil, null))
    if (mode === 'auto') st.auto.done = true // nothing to do on the farm right now
  }

  if (m === 'ai') { // Claude decides; if the AI is unavailable or at its hourly limit, keep playing with the routine
    st.busy = true; let ok = false
    try { ok = await aiPlayStep(b, st, cfg, c, home) } catch (err) { st.log?.push({ t: Date.now(), type: 'event', text: 'AI step error: ' + String(err.message || err).slice(0, 120) }) }
    st.busy = false
    if (ok) return
    m = 'survive'
  }

  if (m === 'survive' && Date.now() > (st.survIdle || 0)) {
    st.busy = true; let r
    try { r = await survive(b, st, cfg, c, home); st.survErr = '' } catch (err) {
      const m = String(err.message || err).slice(0, 120); st.task = 'survival: ' + m
      if (m !== st.survErr) { st.survErr = m; st.log?.push({ t: Date.now(), type: 'event', text: 'survival: ' + m }) }
    }
    st.busy = false
    if (r === 'idle') { st.survIdle = Date.now() + 60e3; st.baseDone = Date.now() + 10 * 60e3; if (st.auto) st.auto.done = true } // base finished
    else return
  }

  if (b.pathfinder.isMoving()) { if (c.fidget && chance(0.05)) b.swingArm(); return }

  if (m === 'roam' && mode === 'auto') m = 'stay' // auto 'relax': wander around the base
  if (m !== 'roam' && m !== 'idle' && home && e.position.distanceTo(home) > (m === 'farm' ? c.farmR : c.homeR) + 4)
    return go(b, st, new goals.GoalNear(home.x, home.y, home.z, 1), 'going → ' + home.label)

  st.task = mode === 'auto' ? 'auto: ' + (m === 'stay' ? 'relaxing at base' : m === 'farm' ? 'waiting for crops' : st.task.replace(/^auto: /, '')) : mode === 'idle' ? 'idle (AFK)' : mode === 'guard' ? 'guarding ' + (home?.label || 'here') : mode === 'farm' ? 'farming ' + home.label + ' (waiting for crops)' : mode === 'survive' ? st.task
    : home && mode === 'stay' ? 'at ' + home.label : 'roaming'
  const r = Math.random()
  if (r < 0.25 && m !== 'idle') { // walk somewhere nearby
    const o = (m !== 'roam' && home) || e.position, d = m !== 'roam' && home ? c.homeR : c.roam
    if (d > 0) b.pathfinder.setGoal(new goals.GoalNear(o.x + rnd(-d, d), o.y, o.z + rnd(-d, d), 1))
  } else if (r < 0.45 && !player) b.look(e.yaw + rnd(-1.5, 1.5), rnd(-0.4, 0.3)) // glance around
  else if (!c.fidget) return
  else if (r < 0.5) hold(b, 'jump', 300)
  else if (r < 0.53) hold(b, 'sneak', rnd(400, 1500))
  else if (r < 0.56) b.swingArm()
}
