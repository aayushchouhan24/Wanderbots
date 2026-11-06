// Break place/dig loops: the pathfinder sometimes places and breaks (or keeps re-placing) the same block forever,
// e.g. when pillaring up and the server doesn't confirm the placement. Watch every place/dig; when the same spot
// keeps coming back within 30 s, stop, walk without pillaring/digging for 2 minutes, and report it.
const WINDOW = 30e3, COOLDOWN = 120e3

export function watchLoops(b, st, onLoop) {
  if (b._loopWatch) return
  b._loopWatch = true
  const events = []
  const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`

  const check = (kind, pos) => {
    const now = Date.now()
    events.push({ t: now, k: key(pos), kind })
    while (events.length && now - events[0].t > WINDOW) events.shift()
    const k = key(pos), here = events.filter(e => e.k === k)
    const places = here.filter(e => e.kind === 'place').length, digs = here.length - places
    // placed AND broken twice each, or the same spot 5+ times: that's a loop, not normal work
    if ((places >= 2 && digs >= 2) || here.length >= 5) {
      if (now - (st.loopAt || 0) < 15e3) return
      st.loopAt = now
      st.noTowerUntil = now + COOLDOWN
      events.length = 0
      try { b.pathfinder.stop() } catch {}
      b.clearControlStates()
      const m = b.pathfinder.movements
      if (m) { m.allow1by1towers = false; m.scafoldingBlocks = []; m.canDig = false; try { b.pathfinder.setMovements(m) } catch {} }
      onLoop(k)
    }
  }

  const dig = b.dig.bind(b)
  b.dig = (block, ...rest) => { if (block?.position) check('dig', block.position); return dig(block, ...rest) }
  const place = b.placeBlock.bind(b)
  b.placeBlock = (ref, face, ...rest) => { if (ref?.position && face) check('place', ref.position.plus(face)); return place(ref, face, ...rest) }

  // while cooling down, every new path is walk-only (Mindcraft's skills create fresh movements each time)
  const setMov = b.pathfinder.setMovements.bind(b.pathfinder)
  b.pathfinder.setMovements = m => {
    if (m && Date.now() < (st.noTowerUntil || 0)) { m.allow1by1towers = false; m.scafoldingBlocks = []; m.canDig = false }
    return setMov(m)
  }
}
