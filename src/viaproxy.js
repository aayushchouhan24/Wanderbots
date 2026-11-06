// ViaProxy lets bots join servers newer than mineflayer supports.
// One local ViaProxy serves every server: each bot puts its real target and version in the
// handshake ("internal wildcard domain" mode), so no per-server config is needed.
// It is started only when a bot needs it.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'

import { fileURLToPath } from 'node:url'
const DIR = fileURLToPath(new URL('../viaproxy', import.meta.url)) // <project>/viaproxy
const JAR = path.join(DIR, 'ViaProxy.jar')
export const VIA = { host: '127.0.0.1', port: 25568 }
let proc = null, ready = null

export const available = () => fs.existsSync(JAR)

const portOpen = () => waitPort(0).then(() => true, () => false)

// resolves when our ViaProxy is listening; starts it on first call and restarts it if it died
export async function ensure() {
  if (ready) {
    const ok = await ready.then(() => true, () => false)
    if (ok && proc && await portOpen()) return
    proc?.kill(); proc = null; ready = null // dead or hung: start a fresh one
  }
  if (!available()) throw new Error('ViaProxy.jar not found in ./viaproxy (see README)')
  // a ViaProxy left running (e.g. after a crash or restart) still works: reuse it instead of failing
  if (!ready && await portOpen()) { console.log(`[viaproxy] reusing the one already running on port ${VIA.port}`); ready = Promise.resolve(); proc = proc || { kill() {} }; return }
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    proc = spawn('java', ['-Xmx256m', '-jar', JAR, 'cli', '--bind-address', `${VIA.host}:${VIA.port}`,
      '--wildcard-domain-handling', 'INTERNAL', '--auth-method', 'NONE', '--log-ips', 'false'], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] })
    const fail = e => { ready = null; proc = null; reject(e) }
    const timer = setTimeout(() => fail(new Error('ViaProxy did not start in 60s')), 60e3)
    proc.on('error', e => { clearTimeout(timer); fail(new Error(e.code === 'ENOENT' ? 'Java is not installed (needed for ViaProxy)' : e.message)) })
    proc.on('exit', code => { clearTimeout(timer); console.log('[viaproxy] stopped, code', code); fail(new Error('ViaProxy stopped')) })
    proc.stdout.on('data', d => {
      const s = d.toString().replace(/\x1b\[[0-9;]*m/g, '')
      if (/ERROR|SERVER DISCONNECT/.test(s)) process.stdout.write('[viaproxy] ' + s)
      if (/Failed to bind|Address already in use|Exception in thread "main"/.test(s)) { clearTimeout(timer); proc?.kill(); fail(new Error('ViaProxy failed to start: ' + s.trim().slice(0, 120))) }
      if (s.includes('ViaProxy started successfully')) waitPort(40).then(() => { clearTimeout(timer); console.log('[viaproxy] ready on', VIA.port); resolve() }, fail)
    })
    proc.stderr.on('data', d => process.stderr.write('[viaproxy] ' + d))
  })
  ready.catch(() => {})
  return ready
}

// "started" is logged a moment before the port is bound, so wait until it accepts connections
function waitPort(tries) {
  return new Promise((resolve, reject) => {
    const s = net.connect(VIA.port, VIA.host, () => { s.destroy(); resolve() })
    s.on('error', () => tries > 0 ? setTimeout(() => waitPort(tries - 1).then(resolve, reject), 250) : reject(new Error('ViaProxy port never opened')))
  })
}

// handshake host that tells ViaProxy where to connect
export const route = (host, port, target) => `${host}\x07${host}:${port}\x07${target}`

process.on('exit', () => proc?.kill())
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { proc?.kill(); process.exit() })
