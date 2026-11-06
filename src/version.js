// Ping a server and pick the Minecraft version a bot should join with.
import mineflayer from 'mineflayer'
import mc from 'minecraft-protocol'
import mcData from 'minecraft-data'
import { serverKey } from './store.js'

const num = v => v.split('.').map(Number)
const cmp = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0 }
export const SUPPORTED = [...new Set([...(mineflayer.testedVersions || []), ...mc.supportedVersions])].sort(cmp) // oldest -> newest
export const servers = new Map() // 'host:port' -> last ping result

// chat component (string / JSON / NBT) -> plain text
export const text = c => typeof c === 'string' ? c : !c ? '' : Array.isArray(c) ? c.map(text).join('') :
  (c.text ?? c.translate ?? '') + (c.with ? ' ' + text(c.with) : '') + text(c.extra) || (c.value ? text(c.value) : JSON.stringify(c))

// pref = 'auto' or a specific version
export async function detect(host, port, pref = 'auto') {
  const r = await mc.ping({ host, port })
  const proto = r.version?.protocol, name = r.version?.name || ''
  const byProto = (mcData.postNettyVersionsByProtocolVersion.pc[proto] || []).map(v => v.minecraftVersion)
  const auto = byProto.find(v => SUPPORTED.includes(v)) || SUPPORTED.find(v => name.includes(v)) || mineflayer.latestSupportedVersion
  const version = pref !== 'auto' && SUPPORTED.includes(pref) ? pref : auto
  servers.set(serverKey(host, port), { auto, server: name, protocol: proto, online: r.players?.online, max: r.players?.max, motd: text(r.description).slice(0, 80), at: Date.now() })
  return version
}
