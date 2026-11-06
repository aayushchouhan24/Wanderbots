// Fighting back against players who hurt the bot badly (half health or less).
// Legit technique only: precise aim, full-charge hits, jump crits, sprint knockback, best weapon + shield.
// No reach / damage hacks: the bot attacks within normal reach (3 blocks) like a real player.
import pf from 'mineflayer-pathfinder'

const { goals } = pf
const wait = ms => new Promise(r => setTimeout(r, ms))
const TIER = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite']
const score = n => (/_sword$/.test(n) ? 10 : /_axe$/.test(n) ? 9 : /trident|mace/.test(n) ? 20 : 0) + (TIER.findIndex(t => n.startsWith(t)) + 1) * 2
const REACH = 3.0

// attack cooldown (full charge) by weapon type
const cooldown = name => !name ? 300 : /_axe$/.test(name) ? (/^(wooden|stone)/.test(name) ? 1250 : 1000) : /_sword$/.test(name) ? 625 : /trident/.test(name) ? 910 : /mace/.test(name) ? 1670 : 300

async function gearUp(b) {
  const weapon = b.inventory.items().filter(i => score(i.name) > 0).sort((x, y) => score(y.name) - score(x.name))[0]
  if (weapon && b.heldItem?.name !== weapon.name) await b.equip(weapon, 'hand').catch(() => {})
  const shield = b.inventory.items().find(i => i.name === 'shield')
  if (shield && b.inventory.slots[45]?.name !== 'shield') await b.equip(shield, 'off-hand').catch(() => {})
}

// fight `name` until they die, run off, 90 s pass, or we get too hurt. Returns a short result.
export async function fightPlayer(b, name, shouldStop = () => false) {
  await gearUp(b)
  const start = Date.now()
  let lastHit = 0, following = false, killed = false
  const onDead = e => { if (e.username === name) killed = true }
  b.on('entityDead', onDead)
  try {
    while (!shouldStop()) {
      const t = b.players[name]?.entity
      if (killed) return `killed ${name}`
      if (!t || !t.isValid) return `${name} is gone`
      if (Date.now() - start > 90e3) return `gave up on ${name}`
      if (b.health <= 4) return 'too hurt to keep fighting'
      const aim = t.position.offset(0, t.height * 0.85, 0)
      const d = b.entity.position.offset(0, b.entity.height * 0.9, 0).distanceTo(aim)
      if (d > 32) return `${name} ran away`
      await b.lookAt(aim, true) // aim at the upper body
      if (d > REACH - 0.2) { // chase, sprinting
        if (!following) { b.pathfinder.setGoal(new goals.GoalFollow(t, 2), true); following = true }
        b.setControlState('sprint', true)
        await wait(50); continue
      }
      if (following) { b.pathfinder.setGoal(null); following = false }
      b.setControlState('forward', true); b.setControlState('sprint', true)
      if (Date.now() - lastHit >= cooldown(b.heldItem?.name)) {
        // jump crit: hit while falling
        if (b.entity.onGround) {
          b.setControlState('jump', true); await wait(60); b.setControlState('jump', false)
          for (let i = 0; i < 14 && !(b.entity.velocity.y < -0.08); i++) await wait(25)
        }
        const t2 = b.players[name]?.entity
        if (t2 && b.entity.position.distanceTo(t2.position) <= REACH + 0.5) {
          await b.lookAt(t2.position.offset(0, t2.height * 0.85, 0), true)
          b.attack(t2)
          lastHit = Date.now()
          // sprint reset so the next hit knocks back again
          b.setControlState('sprint', false); await wait(40); b.setControlState('sprint', true)
        }
      }
      await wait(40)
    }
    return 'stopped'
  } finally {
    b.removeListener('entityDead', onDead)
    b.clearControlStates()
    try { b.pathfinder.setGoal(null) } catch {}
  }
}

// Watch who hurts the bot. When a player has brought it to half health or less, call onRevenge(name).
export function watchAttackers(b, st, getSettings, onRevenge) {
  const hurtBy = {}
  b.on('entityHurt', (ent, src) => {
    if (ent !== b.entity || !src || src.type !== 'player' || src.username === b.username) return
    hurtBy[src.username] = Date.now()
  })
  b.on('health', () => {
    const c = getSettings()
    if (!c || c.retaliate === 'off' || b.health > 10 || st.revenge) return
    const owners = String(c.owners || '').toLowerCase().split(',').map(s => s.trim())
    const name = Object.entries(hurtBy).filter(([, t]) => Date.now() - t < 8000).sort((x, y) => y[1] - x[1])[0]?.[0]
    if (!name || (c.retaliate === 'others' && owners.includes(name.toLowerCase()))) return
    st.revenge = { name, t: Date.now() }
    onRevenge(name)
  })
}
