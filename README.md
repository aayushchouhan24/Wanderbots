# Wanderbots

Minecraft bots that join any servers and hang out like real players: they walk around, look at people nearby, jump, sneak, eat when hungry and go to the places you send them. You manage everything from a small web panel that needs a login key.

Built on [mineflayer](https://github.com/PrismarineJS/mineflayer). It uses little memory: about 85 MB with no bots, plus some for each bot.

## Features

- **Any username, any server.** Add as many bots as you want. Each one has its own username, server (paste `host:port`) and version, all set in the panel.
- **Any version.** Each bot pings its server and joins with the matching version. Versions 1.8.8 to 26.1 connect directly. Newer servers (26.2, 26.3, …) go through a built-in [ViaProxy](https://github.com/ViaVersion/ViaProxy), started automatically only when needed.
- **Modes per bot.**
  - **Roam:** wanders freely.
  - **Stay:** hangs around a place, a spot or exact x y z.
  - **Follow:** follows a player. If combat is set to fight, it also protects them from mobs.
  - **Guard:** stays at a spot and fights mobs there.
  - **Farm:** harvests and replants wheat, carrots, potatoes and beetroot around a place.
  - **Survival:** plays the early game (see below).
  - **Idle:** stands still (AFK).
- **Survival mode.** The bot chops trees and crafts planks, sticks and a crafting table. It makes a wooden pickaxe, then mines stone for a stone pickaxe, sword and axe. It places a chest and builds a 5×5 hut with a door and roof at its base, makes a bed from sheep wool and sets its respawn there, adds a torch if it finds coal, stores loot in the chest and hunts animals when hungry. It works step by step from its inventory, so it carries on after a restart. In this mode it digs and places blocks, and it never digs inside its own base.
- **Basic Minecraft sense.**
  - Remembers where it died, even across a restart, and goes back for its items before they despawn.
  - Uses the bed at its base as its respawn point.
  - Always backs away from creepers.
  - Stays home at night.
  - Rests when badly hurt.
  - Eats the best food it has and skips rotten flesh, raw chicken and spider eyes unless starving.
- **Per-bot settings.** Every behaviour setting can be changed for one bot only in its Settings tab. Other bots keep the defaults.
- **On-join commands and auto-message.** Commands to run after joining, such as `/login password` for login plugins, and a message to repeat every N minutes.
- **Lifetime stats.** Time online, joins, distance walked, kills, deaths, items picked up, blocks mined and placed, crops harvested and items crafted.
- **Real-player behaviour.** Bots wander, glance around, watch nearby players, jump, sneak and swim up in water. They also:
  - eat when hungry
  - fight or run from hostile mobs, depending on the setting
  - wear their best armor and hold their best weapon
  - pick up dropped items
  - sleep in a nearby bed at night

  Outside Farm and Survival modes they never break or place blocks.
- **Chat.** Bots reply when someone says their name and can greet players who join. Players listed as owners can command them in game chat (see below). Each bot keeps a log of chat and events in the panel.
- **Places.** Save spots like `farm` or `base` for a server, by coordinates or from where a bot stands, and send that server's bots there. A bot stays near its place and walks back after dying.
- **Buttons for all bots.** Roam, idle, rejoin, pause, resume, send all to a place, or say something as every bot.
- **Live stats.** Health, food, level, position, world, day or night, held item, ping and uptime. The details view adds online players, inventory and the log.
- **Everything editable in the panel.** Per bot: username, server, port and version. For all bots: mob handling, guard, roam and stay radius, view distance, reconnect delay, behaviour toggles and the owners list.
- **Login key.** The key is stored only as a hash. Sessions last 7 days. Too many wrong tries locks login for 15 minutes.
- **Storage.** MongoDB, or a local `data.json` file if MongoDB isn't set.

## Requirements

- Node.js 22 or newer, or Docker
- Java 17+ and `viaproxy/ViaProxy.jar`, only for servers newer than 26.1. The Docker image already includes both.
- A Minecraft server in **offline mode** (`online-mode=false`). Bots don't have Mojang accounts.

## Quick start

```bash
git clone https://github.com/aayushchouhan24/Wanderbots.git
cd Wanderbots
npm install
cp .env.example .env   # then edit .env
# optional, for servers newer than 26.1:
mkdir viaproxy && curl -L -o viaproxy/ViaProxy.jar https://github.com/ViaVersion/ViaProxy/releases/download/v3.4.14/ViaProxy-3.4.14.jar
npm start
```

Open `http://localhost:3000`. If you left `PASS` empty, the login key is printed in the console on first start.

## Configuration (`.env`)

Only three settings live in `.env`. Everything else (bots, servers, versions, places, behaviour) is set in the panel and saved in the database.

| Variable    | What it does                                                                   | Default  |
|-------------|--------------------------------------------------------------------------------|----------|
| `MONGO_URI` | MongoDB connection string. Empty means a local `data.json` file              | –        |
| `PASS`      | Login key used on the first start only. Change it later in the panel          | random   |
| `PORT`      | Web panel port                                                                 | `3000`   |

## Docker

```bash
docker build -t wanderbots .
docker run -d --env-file .env -p 3000:3000 --name wanderbots wanderbots
```

On a hosting platform, set the same variables in its environment settings. The image doesn't include `.env`.

## Project structure

```
src/
  index.js     start-up: load storage, login key, web panel, bots
  store.js     saved state (MongoDB or data.json) and default settings
  auth.js      login key, sessions, lockout
  version.js   server ping and version detection
  bots.js      bot lifecycle per server: connect, reconnect, places, stats
  brain.js     modes and "real player" behaviour, runs about once a second
  chat.js      chat log, replies, greetings, owner commands
  survival.js  survival play: gather, craft, store, build a base
  fixes.js     protocol fixes (tick_end)
  viaproxy.js  starts ViaProxy for servers newer than 26.1
  web.js       HTTP server and JSON API
public/
  index.html   control panel (single file, no build step)
```

## API

All routes except `login` need the `x-token` header returned by `POST /api/login`.

| Method   | Route                        | Body                    |
|----------|------------------------------|-------------------------|
| `POST`   | `/api/login`                 | `{ key }`               |
| `POST`   | `/api/logout`                |                         |
| `POST`   | `/api/key`                   | `{ key }` (8+ chars)    |
| `GET`    | `/api/state`                 |                         |
| `POST`   | `/api/settings`              | shared behaviour fields |
| `POST`   | `/api/bots`                  | `{ name, address, version }` (address like `play.x.net:25565`) |
| `DELETE` | `/api/bots/:id`              |                         |
| `POST`   | `/api/bots/:id/edit`         | `{ name, address, version }` (address like `play.x.net:25565`) |
| `POST`   | `/api/bots/:id/mode`         | `{ mode, place?, player?, here?, xyz? }` |
| `POST`   | `/api/bots/:id/settings`     | `{ key: value }`, `{ key: null }` for the default, `{ reset: true }` |
| `POST`   | `/api/bots/:id/extras`       | `{ onJoin, autoMsg: { text, mins } }` |
| `POST`   | `/api/bots/:id/inv`          | `{ action: hold | drop | dropall, slot }` |
| `POST`   | `/api/bots/:id/chat`         | `{ text }`              |
| `POST`   | `/api/bots/:id/pause`        |                         |
| `POST`   | `/api/bots/:id/resume`       |                         |
| `POST`   | `/api/bots/:id/restart`    |                         |
| `POST`   | `/api/bots/:id/here`       | `{ name }` (save spot)  |
| `POST`   | `/api/all/:action`           | `roam` `idle` `rejoin` `pause` `resume` `send {place}` `chat {text}` |
| `POST`   | `/api/places`                | `{ name, server, x, y, z }` |
| `DELETE` | `/api/places/:id`          |                         |

## Chat commands

Add player names to **Owners** in the panel. Those players can then type these in game chat:

| Command          | What the bot does                                  |
|------------------|----------------------------------------------------|
| `!come` / `!follow` | follows you                                    |
| `!stay`          | stays where you are standing                       |
| `!guard`         | guards where you are standing and fights mobs      |
| `!roam`          | wanders freely                                     |
| `!idle`          | stands still (AFK)                                 |
| `!goto <place>`  | walks to a saved place and stays there             |
| `!here <name>`   | saves where you stand as a place                   |
| `!status`        | replies with health, food, position and activity   |
| `!help`          | lists the commands                                 |

## How newer servers work

Mineflayer speaks up to 26.1. When a bot's server is newer, Wanderbots starts one local ViaProxy (`127.0.0.1:25568`, about 150–250 MB RAM) and the bot connects through it. The bot's handshake tells ViaProxy which server and version to use, so one ViaProxy serves every server.

Wanderbots also sends the `tick_end` packet that real 1.21.2+ clients send after every tick. Without it, newer servers kick bots with "Invalid move player packet".

## Known limits

- Use bots only on servers you own or have permission to use.

## License

MIT
