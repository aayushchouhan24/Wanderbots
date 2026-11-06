// Ping the server and pick the Minecraft version the bots should join with.
import mineflayer from 'mineflayer'
import mc from 'minecraft-protocol'
import mcData from 'minecraft-data'
import { S } from './store.js'

const num = v => v.split('.').map(Number)
const cmp = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0 }
export const SUPPORTED = [...new Set([...(mineflayer.testedVersions || []), ...mc.supportedVersions])].sort(cmp) // oldest -> newest
export const server = { info: null } // last ping result

// chat component (string / JSON / NBT) -> plain text
export const text = c => typeof c === 'string' ? c : !c ? '' : Array.isArray(c) ? c.map(text).join('') :
  (c.text ?? c.translate ?? '') + (c.with ? ' ' + text(c.with) : '') + text(c.extra) || (c.value ? text(c.value) : JSON.stringify(c))

export async function detect() {
  const r = await mc.ping({ host: S.host, port: S.port })
  const proto = r.version?.protocol, name = r.version?.name || ''
  const byProto = (mcData.postNettyVersionsByProtocolVersion.pc[proto] || []).map(v => v.minecraftVersion)
  const auto = byProto.find(v => SUPPORTED.includes(v)) || SUPPORTED.find(v => name.includes(v)) || mineflayer.latestSupportedVersion
  const version = S.set.version !== 'auto' && SUPPORTED.includes(S.set.version) ? S.set.version : auto
  server.info = { version, server: name, protocol: proto, online: r.players?.online, max: r.players?.max, motd: text(r.description).slice(0, 80) }
  return version
}
