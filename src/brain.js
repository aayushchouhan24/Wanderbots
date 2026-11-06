// "Real player" behaviour. Called about once a second per bot.
import pf from 'mineflayer-pathfinder'
import { S } from './store.js'

const { goals } = pf
export const rnd = (a, b) => a + Math.random() * (b - a)
const chance = p => Math.random() < p

export async function think(b, st) {
  const e = b.entity, c = S.set
  if (!e) return

  // eat when hungry
  if (c.eat && b.food < 14 && !st.eating) {
    const food = b.inventory.items().find(i => b.registry.foodsByName[i.name])
    if (food) { st.eating = true; try { await b.equip(food, 'hand'); await b.consume() } catch {} st.eating = false }
  }

  // look at people nearby
  const p = c.lookPlayers && b.nearestEntity(x => x.type === 'player' && x.position.distanceTo(e.position) < 8)
  if (p && chance(0.6)) b.lookAt(p.position.offset(0, 1.6, 0))

  if (b.pathfinder.isMoving()) { if (c.fidget && chance(0.05)) b.swingArm(); return }
  if (st.task.startsWith('going')) st.task = st.home ? 'at ' + st.home.label : 'roaming'

  const r = Math.random()
  if (r < 0.25) { // walk somewhere nearby: around its place, or around itself when roaming
    const o = st.home || e.position, d = st.home ? c.homeR : c.roam
    if (d > 0) b.pathfinder.setGoal(new goals.GoalNear(o.x + rnd(-d, d), o.y, o.z + rnd(-d, d), 1))
  } else if (r < 0.45 && !p) b.look(e.yaw + rnd(-1.5, 1.5), rnd(-0.4, 0.3)) // glance around
  else if (!c.fidget) return
  else if (r < 0.5) hold(b, 'jump', 300)
  else if (r < 0.53) hold(b, 'sneak', rnd(400, 1500))
  else if (r < 0.56) b.swingArm()
  // otherwise: just stand there a moment
}

function hold(b, key, ms) { b.setControlState(key, true); setTimeout(() => b.setControlState(key, false), ms) }
