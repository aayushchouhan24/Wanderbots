# Wanderbots

Minecraft bots that join any servers and hang out like real players: they walk around, look at people nearby, jump, sneak, eat when hungry and go to the places you send them. You manage everything from a small web panel that needs a login key.

Built on [mineflayer](https://github.com/PrismarineJS/mineflayer). It uses little memory: about 85 MB with no bots, plus some for each bot.

## Features

- **Any username, any server.** Add as many bots as you want. Each one has its own username, server (paste `host:port`) and version, all set in the panel.
- **Automatic version.** Each bot pings its server and joins with the matching Minecraft version (1.8.8 to 26.1). You can also pick a version per bot.
- **Real-player behaviour.** Bots wander, glance around, watch nearby players, jump, sneak, swing and eat. They never break or place blocks.
- **Places.** Save spots like `farm` or `base` for a server, by coordinates or from where a bot stands, and send that server's bots there. A bot stays near its place and walks back after dying.
- **Live stats.** Health, food, position, world, ping, uptime and players online.
- **Everything editable in the panel.** Per bot: username, server, port and version. For all bots: roam radius, stay radius, view distance, reconnect delay and behaviour toggles.
- **Login key.** The key is stored only as a hash. Sessions last 7 days. Too many wrong tries locks login for 15 minutes.
- **Storage.** MongoDB, or a local `data.json` file if MongoDB isn't set.

## Requirements

- Node.js 22 or newer, or Docker
- A Minecraft server in **offline mode** (`online-mode=false`). Bots don't have Mojang accounts.

## Quick start

```bash
git clone https://github.com/aayushchouhan24/Wanderbots.git
cd Wanderbots
npm install
cp .env.example .env   # then edit .env
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
  brain.js     "real player" behaviour, runs about once a second
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
| `POST`   | `/api/bots/:id/send`       | `{ place }` (place id)  |
| `POST`   | `/api/bots/:id/roam`       |                         |
| `POST`   | `/api/bots/:id/restart`    |                         |
| `POST`   | `/api/bots/:id/here`       | `{ name }` (save spot)  |
| `POST`   | `/api/places`                | `{ name, server, x, y, z }` |
| `DELETE` | `/api/places/:id`          |                         |

## Known limits

- Servers newer than 26.1 aren't supported directly. The panel marks such bots as **unsupported** and won't keep retrying the login. A server with ViaVersion and ViaBackwards may accept bots, but can kick them for "invalid player movement". Otherwise run the server on 26.1 or wait for mineflayer to support the newer version.
- Use bots only on servers you own or have permission to use.

## License

MIT
