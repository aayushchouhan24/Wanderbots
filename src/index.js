// Wanderbots — Minecraft bots that join servers and hang out like real players.
import { S, loadStore } from './store.js'
import { initKey } from './auth.js'
import { start } from './bots.js'
import { startWeb } from './web.js'
import { loadSchematics } from './schemstore.js'

await loadStore()
await loadSchematics()
initKey()
startWeb(+(process.env.PORT || 3000))
S.bots.forEach(b => start(b.id))
