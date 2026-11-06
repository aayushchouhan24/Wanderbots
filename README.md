# Wanderbots

Minecraft bots that join a server and hang out like real players: they walk around, look at people nearby, jump, sneak, eat when hungry and go to the places you send them. You manage everything from a small web panel that needs a login key.

Built on [mineflayer](https://github.com/PrismarineJS/mineflayer). It uses little memory: about 85 MB with no bots, plus some for each bot.

## Features

- **Any username.** Add as many bots as you want and rename them from the panel.
- **Automatic version.** It pings the server and joins with the matching Minecraft version (1.8.8 to 26.1). You can also pick a version yourself.
- **Real-player behaviour.** Bots wander, glance around, watch nearby players, jump, sneak, swing and eat. They never break or place blocks.
- **Places.** Save spots like `farm` or `base`, by coordinates or from where a bot stands, and send bots there. A bot stays near its place and walks back after dying.
- **Live stats.** Health, food, position, world, ping, uptime and players online.
- **Everything editable in the panel.** Server, version, roam radius, stay radius, view distance, reconnect delay and behaviour toggles.
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

| Variable    | What it does                                                    | Default       |
|-------------|-----------------------------------------------------------------|---------------|
| `HOST`      | Minecraft server address                                        | `localhost`   |
| `PORT_MC`   | Minecraft server port                                           | `25565`       |
| `NAME`      | First bot to create if none are saved yet                       | –             |
| `MONGO_URI` | MongoDB connection string. Empty means a local `data.json` file | –             |
| `PASS`      | Login key used on the first start only                          | random        |
| `PORT`      | Web panel port                                                  | `3000`        |
| `DATA`      | Path of the JSON file when MongoDB isn't used                   | `./data.json` |

Once the app is running, the panel overrides `HOST`, `PORT_MC` and `PASS`. Those changes are saved in the database.

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
  bots.js      bot lifecycle: connect, reconnect, places, stats
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
| `POST`   | `/api/server`                | `{ host, port }`        |
| `POST`   | `/api/settings`              | any setting fields      |
| `POST`   | `/api/bots`                  | `{ name }`              |
| `DELETE` | `/api/bots/:name`            |                         |
| `POST`   | `/api/bots/:name/rename`     | `{ name }`              |
| `POST`   | `/api/bots/:name/send`       | `{ place }`             |
| `POST`   | `/api/bots/:name/roam`       |                         |
| `POST`   | `/api/bots/:name/restart`    |                         |
| `POST`   | `/api/bots/:name/here`       | `{ name }` (save spot)  |
| `POST`   | `/api/places`                | `{ name, x, y, z }`     |
| `DELETE` | `/api/places/:name`          |                         |

## Known limits

- Servers newer than 26.1 aren't supported directly yet. A server-side ViaVersion/ViaBackwards setup may let bots log in, but it can kick them for "invalid player movement". Run the server on 26.1, or wait for mineflayer to support the newer version.
- Use bots only on servers you own or have permission to use.

## License

MIT
