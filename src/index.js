// Wanderbots — Minecraft bots that join servers and hang out like real players.
import { S, loadStore } from './store.js'
import { initKey } from './auth.js'
import { start } from './bots.js'
import { startWeb } from './web.js'

await loadStore()
initKey()
startWeb(+(process.env.PORT || 3000))
S.bots.forEach(b => start(b.id))
