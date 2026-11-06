// Social awareness: gifts (thrown items and /give), players walking up, nicknames.
const wait = ms => new Promise(r => setTimeout(r, ms))

// Is the bot being called? Full name, a 3+ letter start of any part of its name ("wand" for Wander_MC2),
// the name without digits/underscores, or a custom nickname.
export function isCalled(botName, message, nicknames = '') {
  const lower = message.toLowerCase(), name = botName.toLowerCase()
  if (lower.includes(name)) return true
  const pieces = [name.replace(/[^a-z]/g, ''), ...name.split(/[_\d]+/)].filter(p => p.length >= 3)
  const nicks = String(nicknames || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
  for (const w of lower.split(/[^a-z0-9_]+/).filter(Boolean)) {
    if (nicks.includes(w)) return true
    if (w.length >= 3 && pieces.some(p => p.startsWith(w))) return true
  }
  return nicks.some(n => n.includes(' ') && lower.includes(n))
}

// Gifts: items thrown by a player that the bot picks up, and items that appear in the inventory by command.
// `busy()` says whether the bot is doing something that adds items by itself (mining, crafting, chests...).
export function watchGifts(b, busy, onGift) {
  const thrown = new Map() // item entity id -> player name
  let lastCollect = 0, snap = null
  const counts = () => { const m = {}; for (const i of b.inventory.items()) m[i.name] = (m[i.name] || 0) + i.count; return m }
  b.on('entitySpawn', e => {
    if (e.name !== 'item') return
    const p = Object.values(b.players).map(x => x.entity).filter(x => x && x !== b.entity && x.position.distanceTo(e.position) < 3)
      .sort((x, y) => x.position.distanceTo(e.position) - y.position.distanceTo(e.position))[0]
    if (p) { thrown.set(e.id, p.username); setTimeout(() => thrown.delete(e.id), 5 * 60e3) }
  })
  b.on('playerCollect', (who, item) => {
    if (who !== b.entity) return
    lastCollect = Date.now()
    const from = thrown.get(item.id)
    if (!from) return
    thrown.delete(item.id)
    const it = item.getDroppedItem?.()
    setTimeout(() => { snap = counts() }, 300) // don't count it twice in the inventory diff
    if (it) onGift(from, it.name, it.count, 'threw')
  })
  const timer = setInterval(() => {
    if (!b.entity) return
    const now = counts()
    if (snap && !busy() && Date.now() - lastCollect > 2500) {
      for (const [n, c] of Object.entries(now)) if (c > (snap[n] || 0)) onGift(null, n, c - (snap[n] || 0), 'gave')
    }
    snap = now
  }, 2000)
  b.once('end', () => clearInterval(timer))
}

// Players walking up to the bot (within 4 blocks), at most once per player every 10 minutes.
export function watchApproach(b, onApproach) {
  const near = new Set(), last = {}
  const timer = setInterval(() => {
    if (!b.entity) return
    for (const p of Object.values(b.players)) {
      const e = p.entity
      if (!e || p.username === b.username) continue
      const d = e.position.distanceTo(b.entity.position)
      if (d < 4 && !near.has(p.username)) {
        near.add(p.username)
        if (Date.now() - (last[p.username] || 0) > 10 * 60e3) { last[p.username] = Date.now(); onApproach(p.username, Math.round(d)) }
      } else if (d > 8) near.delete(p.username)
    }
  }, 2000)
  b.once('end', () => clearInterval(timer))
}

export { wait }
