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
export const text = c => plain(c).replace(/§./g, '')
const plain = c => typeof c === 'string' ? c : !c ? '' : Array.isArray(c) ? c.map(plain).join('') :
  (c.text ?? c.translate ?? '') + (c.with ? ' ' + plain(c.with) : '') + plain(c.extra) || (c.value ? plain(c.value) : JSON.stringify(c))

// pref = 'auto' or a specific version
export async function detect(host, port, pref = 'auto') {
  const r = await mc.ping({ host, port })
  const proto = r.version?.protocol, name = r.version?.name || ''
  const byProto = (mcData.postNettyVersionsByProtocolVersion.pc[proto] || []).map(v => v.minecraftVersion)
  const match = byProto.find(v => SUPPORTED.includes(v)) || SUPPORTED.find(v => name.includes(v))
  const auto = match || SUPPORTED.at(-1)
  const version = pref !== 'auto' && SUPPORTED.includes(pref) ? pref : auto
  servers.set(serverKey(host, port), { auto, server: name, protocol: proto, online: r.players?.online, max: r.players?.max, motd: text(r.description).slice(0, 80), unsupported: !match, newest: SUPPORTED.at(-1),
    target: byProto[0] || name.match(/\d+\.\d+(\.\d+)?/)?.[0] || '', at: Date.now() }) // target = real server version, for ViaProxy
  return version
}
