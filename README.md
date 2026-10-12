# Rep Rumble Arcade

A group fitness game app: Classic Shuffle and Mario Kart Style (Q sets up a game,
hands out a code, PAX join and play). This is a plain Node.js + Express web app —
no external database, no Claude dependency. It stores live game data in memory on
the server, which is all it needs since each workout is a fresh game.

## 1. Run it locally first (optional but recommended)

```bash
npm install
npm start
```

Then open `http://localhost:8080` in a browser. If you're on the same WiFi as
other people, they can open `http://YOUR-LAPTOP-IP:8080` on their phones too
(find your IP with `ipconfig` on Windows or `ifconfig`/`ip addr` on Mac/Linux).

## 2. Push it to GitHub

```bash
git init
git add .
git commit -m "Rep Rumble Arcade"
```

Then on github.com, create a new **empty** repository (no README/license), and run
the two commands it shows you, e.g.:

```bash
git remote add origin https://github.com/YOUR-USERNAME/rep-rumble-arcade.git
git branch -M main
git push -u origin main
```

## 3. Create the Azure Web App

In the Azure Portal:

1. Search **"App Services"** → **Create** → **Web App**.
2. **Resource Group**: create a new one (e.g. `rep-rumble-rg`).
3. **Name**: pick something unique, e.g. `rep-rumble-arcade` — your URL will be
   `https://rep-rumble-arcade.azurewebsites.net` (or whatever suffix Azure adds
   if that name's taken).
4. **Publish**: Code.
5. **Runtime stack**: Node 20 LTS.
6. **Operating System**: Linux.
7. **Region**: whichever is closest to you.
8. **Pricing plan**: **Basic B1** is recommended (a few dollars/month, always
   stays warm). The **Free F1** tier technically works too, but it has a daily
   compute-minutes cap and can go idle between requests, which risks losing an
   in-progress game if it naps mid-event.
9. Click **Review + create**, then **Create**. Wait a minute or two for it to deploy.

## 4. Connect it to your GitHub repo

1. Open your new Web App in the portal.
2. In the left sidebar, go to **Deployment** → **Deployment Center**.
3. **Source**: GitHub. Sign in and authorize Azure if prompted.
4. Pick your **Organization**, **Repository** (`rep-rumble-arcade`), and **Branch** (`main`).
5. Azure will auto-generate a GitHub Actions workflow and commit it to your repo
   for you — this is what builds and deploys the app every time you push.
6. Click **Save**. The first deployment kicks off automatically (check the
   **Logs** tab here, or the **Actions** tab on your GitHub repo, to watch it).

## 5. Turn on "Always On" (Basic tier or higher only)

1. In the Web App, go to **Settings** → **Configuration** → **General settings**.
2. Set **Always On** to **On**. Save.

This stops Azure from putting the app to sleep between uses, so a game in
progress won't get interrupted.

## 6. You're live

Visit `https://YOUR-APP-NAME.azurewebsites.net`. That's the link the Q and all
PAX use — no Claude, no downloads, just a normal website.

## How it stores data

Everything lives in a single in-memory store on the server (see `server.js`).
That means:

- **It resets whenever the server restarts** (a new deploy, a manual restart, or
  the Free tier napping). That's fine between events — every game starts clean
  anyway — but don't restart the app mid-game.
- **It's a single instance.** Don't scale this out to multiple instances/replicas
  without adding a real shared datastore (e.g. Azure Table Storage, Redis, or
  Cosmos DB) — otherwise different phones could land on different instances and
  see different data. For a single event with normal traffic this isn't a concern.

## Making changes later

Edit `public/index.html` (the whole app's UI and game logic) or `server.js` (the
small API), then:

```bash
git add .
git commit -m "describe your change"
git push
```

Azure will automatically rebuild and redeploy within a minute or two.

## Big-screen dashboard (the Q, computer only)

The Q screen is for a computer and a projector - phones and tablets are blocked from opening it
(they see "needs a computer"). Once the game starts it shows only what a crowd needs:

- a big countdown **timer**
- **the track** with every team's marker and lap count
- **Team Progress**: one card per team with bars for **laps**, **power meter** and **power-up points**
- any active power-ups ("who got hit")

The code, the player list and run orders are shown before the game starts.

## The end of the game

When the timer hits zero, every phone and the dashboard **flash red with a siren for 10 seconds**
("TIME'S UP!"), phones vibrate, and the Q's computer also sends a lock-screen alert to every
player (and their watch). Then everyone sees the **final standings** for both laps and power-up
points, with a champion for each. Laps and points freeze at the whistle, nothing counts after
it, and a phone opened afterwards goes straight to the standings with no flash.

The flash is a slow pulse (about once a second), not a rapid strobe. The siren needs the screen
to have been tapped/clicked at least once since the page loaded (a browser rule) - clicking
"Start Game Now" does that on the Q's computer.

## Customizing names (no code needed)

On the Q setup screen you can rename:

- every **exercise** (the name box at the top of each exercise card)
- every **team** (the "Team names" section; each team keeps its own color and icon)
- every **power-up**, and set how many burpees Banana / Green Shell / Red Shell cost
  (the "Power-up names" section)

To change the *built-in defaults* for good instead, edit the top of `public/index.html`:
`MASTER_EXERCISES`, `TEAM_PALETTE_INFO` and `POWERUP_TYPES`.

## Power-ups (Mario Grand Prix rules)

When a team's power meter hits 100% a power-up fires automatically, chosen from whatever
makes sense for where that team sits in the standings:

- **Banana** - team directly behind you does 2 burpees
- **Green Shell** - team directly ahead does 5 burpees
- **Red Shell** - team directly ahead does 7 burpees
- **Blue Shell** - the 1st place team's current runner detours to a spot the Q names in setup
  (default: the tennis courts)
- **Rocket** - the NEXT runner takes a half-lap shortcut on their lap (it is "loaded" when it
  fires and becomes active the moment the baton passes, by Lap Complete or a skipped turn)

The team in **1st place only ever gets Bananas**.

## Lock-screen and smartwatch alerts (Web Push)

Alerts arrive even when the phone is locked, and mirror to a paired watch.

- `public/sw.js` (service worker) shows the notification; `server.js` sends it using the
  `web-push` package. No setup is needed: the server creates its own keys at startup.
  (Optional: set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in Azure App Settings.)
- **Android (Chrome):** tap Allow when asked about notifications.
- **iPhone:** the page must be added to the Home Screen first (Share -> Add to Home Screen),
  opened from that icon, then tap Allow. iOS 16.4 or newer is required.
- Watches only mirror notifications from the phone, so the phone must be paired and the
  notifications for that app/site must be allowed on the watch.

## "Undo Typing" when you shake the phone (iPhone)

Right after a player joins the app reloads once (which clears the iPhone's typing history) and
drops them straight back into their game. A player or the Q who refreshes mid-game comes straight
back too. If the prompt ever still appears: Settings -> Accessibility -> Touch -> Shake to Undo -> Off.
