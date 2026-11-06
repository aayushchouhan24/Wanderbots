// Protocol fixes mineflayer doesn't do itself.
import mcData from 'minecraft-data'

const MOVE = new Set(['position', 'position_look', 'look', 'flying'])

// Since 1.21.2 a real client sends `tick_end` after every game tick. Mineflayer doesn't, and
// newer servers (26.2+) then kick for "Invalid move player packet". We send one right after
// each movement packet, so the server sees one move per tick.
export function tickEnd(bot, version) {
  if (!mcData(version)?.protocol?.play?.toServer?.types?.packet_tick_end) return
  const c = bot._client, write = c.write.bind(c)
  c.write = (name, data) => {
    const r = write(name, data)
    if (MOVE.has(name) && c.state === 'play') write('tick_end', {})
    return r
  }
}
