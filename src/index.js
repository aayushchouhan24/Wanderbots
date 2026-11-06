// Wanderbots — Minecraft bots that join a server and hang out like real players.
import { S, loadStore } from './store.js'
import { initKey } from './auth.js'
import { detect } from './version.js'
import { start } from './bots.js'
import { startWeb } from './web.js'

await loadStore()
initKey()
startWeb(+(process.env.PORT || 3000))

detect().catch(() => {})
setInterval(() => detect().catch(() => {}), 60e3)
S.bots.forEach(b => start(b.name))
