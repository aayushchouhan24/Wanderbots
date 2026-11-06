// Login key + sessions. The key is only ever stored as a hash.
import crypto from 'node:crypto'
import { S, save } from './store.js'

const hash = k => crypto.createHash('sha256').update('wanderbots:' + k).digest('hex')
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
const sessions = new Map() // token -> expiry
const fails = new Map()    // ip | '*' -> { n, until }
const WEEK = 7 * 864e5, LOCK = 15 * 60e3

// First start: use PASS from .env, or generate a key and print it once.
export function initKey() {
  if (S.keyHash) return
  const k = process.env.PASS || crypto.randomBytes(9).toString('base64url')
  S.keyHash = hash(k); save()
  if (!process.env.PASS) console.log('\n  LOGIN KEY: ' + k + '   (change it in the panel)\n')
}

// 5 wrong keys per IP, or 30 overall (IP headers can be faked) -> locked for 15 min
export function login(ip, key) {
  const now = Date.now(), f = fails.get(ip) || { n: 0, until: 0 }, g = fails.get('*') || { n: 0, until: 0 }
  if (g.until > now || f.until > now) return { code: 429, error: 'too many tries, wait ' + Math.ceil((Math.max(f.until, g.until) - now) / 60e3) + ' min' }
  if (!same(hash(String(key || '')), S.keyHash)) {
    if (++f.n >= 5) { f.until = now + LOCK; f.n = 0 }
    if (++g.n >= 30) { g.until = now + LOCK; g.n = 0 }
    fails.set(ip, f); fails.set('*', g)
    return { code: 401, error: 'wrong key' }
  }
  fails.delete(ip)
  const token = crypto.randomBytes(24).toString('hex')
  sessions.set(token, now + WEEK)
  return { code: 200, token }
}

export function check(token) {
  const exp = sessions.get(token)
  if (exp && exp > Date.now()) return true
  sessions.delete(token); return false
}

export const logout = token => sessions.delete(token)

export function changeKey(key) {
  if (String(key || '').length < 8) return 'key must be 8+ characters'
  S.keyHash = hash(key); sessions.clear(); save()
}

setInterval(() => { const n = Date.now(); for (const [t, e] of sessions) if (e < n) sessions.delete(t) }, 3600e3).unref()
