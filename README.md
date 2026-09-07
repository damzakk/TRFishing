# TR Fishing Bot

A Discord bot where chatting slowly builds up fishing progress. The bot handles catching fish, earning EXP, inventory, selling fish for gold, and buying better rods. Player saves and game data are stored in PlayFab. Uploaded manager images are stored in a Discord storage channel, and PlayFab stores the resulting image URLs.

## Setup

1. Install Node.js 18 or newer.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env`.
4. Add your Discord bot token and PlayFab settings:

   ```env
   DISCORD_TOKEN=your-discord-bot-token
   PREFIX=!
   PLAYFAB_TITLE_ID=your-playfab-title-id
   PLAYFAB_SECRET_KEY=your-playfab-secret-key
   MANAGER_PORT=3000
   CONFIG_REFRESH_MS=300000
   DISCORD_STORAGE_GUILD_NAME=TR Fishing Test Server
   DISCORD_STORAGE_CHANNEL_NAME=storage
   ```

   The bot needs `PLAYFAB_TITLE_ID`. The manager app needs both `PLAYFAB_TITLE_ID` and `PLAYFAB_SECRET_KEY` so it can save title data.
   By default, manager image uploads go to `#storage` in `TR Fishing Test Server`. You can set `DISCORD_STORAGE_CHANNEL_ID` instead if you want to pin uploads to one exact channel.

5. Enable the `Message Content Intent` for your bot in the Discord Developer Portal.
6. Start the bot:

   ```bash
   npm start
   ```

## Item Manager

Run the local manager app in a second terminal:

```bash
npm run start:manager
```

Open this in your browser:

```text
http://localhost:3000
```

From there you can add, edit, remove fish and rods, upload icons, save item data to PlayFab, and seed the default fish and rods.

Icons, event banners, and the custom rod store image are uploaded to the Discord storage channel when you save. PlayFab Title Data only stores the image URL plus the rest of the fish, rod, settings, admin, and event data. Existing older PlayFab CDN image keys can still be read, but new manager uploads use Discord storage.

The bot refreshes item data automatically every few minutes. Restart the bot if you want manager changes to apply immediately.

The manager also has:

- Admin Control: add admin Discord IDs or usernames for testing commands.
- Settings: split into General, FishComp, and FishRaid panels for command banners, competition banners, raid rewards, per-boss raid banners, boss quota data, raid controls, events, chat cooldown, EXP multipliers, and voice progress.
- Event: list deployed events, create server-scoped timed events with start time and duration, add multiple bonus types, and stop running events.
- Player Management: list and search players by Discord ID or username, edit player data, reset a player, delete a player from the PlayFab title, make a player admin, force one fishing catch, and reset or delete all loaded players.

## Commands

- `/fishprofile` - Show your level, gold, rod, total catches, heaviest fish, and fishing progress privately in the channel.
- `/fishshowoff` - Membuat banner publik dengan avatar Discord, ikan pameran, dan statistik utama.
- `/fishdaily` - Mengambil hadiah harian; reward adalah 35 gold dikali daily streak dan reset setiap jam 12:00.
- `/fishinventory` - Melihat daftar ikan yang kamu punya secara privat.
- `/fishstore` - Melihat toko pancingan secara privat.
- `/fishdex` - Melihat Fishdex ikan server secara privat; ikan yang belum tertangkap tetap tersembunyi.
- `/fishvoice` - Membuat bot join voice channel kamu dalam keadaan mute/deafen dan mengaktifkan voice progress server.
- `/fishsetpopupchannel channel:<channel>` - Admin command untuk membuat thread `Fishing!` dan mengirim semua popup fishing server ke thread itu.
- `/fishserver` - Menampilkan status server TRFishing.
- `/fishleaderboard` - Menampilkan leaderboard jumlah ikan, ikan terbesar, luck score ikan tersulit, dan level.
- `/sellfish` - Menjual semua ikan secara privat.
- `/sellfish fish:<fish name or id>` - Menjual satu jenis ikan secara privat.
- `/fishhelp` - Menampilkan panel bantuan secara privat.
- `/fishcomp regtime:<minutes> duration:<turns>` - Membuat kompetisi memancing publik dengan tombol Join. Default duration 15 turns.
- `/fishraid regtime:<minutes>` - Membuka boss raid harian 25 turn. Peserta menangkap ikan untuk memenuhi quota berat harian; result menampilkan ranking kontribusi sepanjang hari.
- `!fishtest` - Admin command untuk test popup fishing tanpa menyimpan ikan, EXP, atau progress.
- `!fishcompforcestart` - Admin command untuk memaksa kompetisi yang sedang registrasi agar mulai lebih cepat.
- `!fishraidforcestart` - Admin command untuk memaksa raid yang sedang registrasi agar mulai lebih cepat.

## How Fishing Works

Normal chat messages add fishing progress. Spamming does not help because each user has a chat cooldown, repeated messages are ignored, and very short messages do not count.

Each rod has:

- Speed: how many valid chat messages are needed before fishing triggers.
- Luck: improves the chance of catching rarer fish.
- Max Weight: the heaviest fish that rod can catch.
- Accuracy: chance to successfully catch a fish each competition turn.
- Description: flavor text shown in the store.

Each fish has:

- Chance Weight: the base roll weight used for catch odds.
- Min Kg and Max Kg: the random catch weight shown when the fish is caught.
- Luck Scale: how much rod luck changes that fish's catch odds.
- Rarity: Common, Uncommon, Rare, Epic, Legendary, or Secret.
- Description: flavor text shown when the fish is caught.

When fishing triggers, the user catches one fish, sees its rolled weight, gains EXP, and can later sell fish for gold.

Each catch also shows a Luck Score. The fish data still keeps its original decimal Luck Scale, but the display score uses `(1 - luckScale) * 5000`, so a fish with `luckScale: -0.45` appears as `7250` on catch popups and the fish luck leaderboard.

When a player's EXP reaches a new fishing level, the bot sends a level-up message with that member's Discord server avatar.

Voice progress starts after someone uses `/fishvoice` in a server voice channel. The bot stays in that channel muted/deafened, and non-bot members in non-AFK voice channels on that server gain fishing progress based on the manager setting. By default this is 1 progress every 15 minutes.

The editable starter balance sheet is in `GAME_DATA.txt`.

Admins are managed in the manager app under the Admin Control tab. You can enter a numeric Discord user ID or a username like `azaralea`. Admins are saved to PlayFab Title Data in `admin_config`.

During competitions, caught fish do not enter inventory and do not give normal fish EXP. The winner gets a small EXP reward when the competition ends.

Fish Raid uses the competition-style registration and turn flow, but all caught fish weight fills a shared daily boss quota. Only one raid can run at once in a server, raids have a 1 hour cooldown after each run, and the daily boss/quota resets at midnight. During a live raid, rankings show only that run; the result shows all participants and total contribution for the whole day.

FishRaid settings include a raid boss editor. Each boss can have its own registration, running, finish, quota fulfilled, and failed-at-midnight banners. The manager can also reset today's raid or force-clear today's quota for a server.
