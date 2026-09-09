require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { defaultFish, defaultRods, defaultFishBags } = require("./defaultData");
const defaultFishCompEvents = require("../fishCompEvents.json");
const defaultFishRaidEvents = require("../fishRaidEvents.json");
const defaultFishDuelEvents = require("../fishDuelEvents.json");
const { getDiscordImageUrl, uploadDiscordImageFromUrl, uploadDiscordImageWithRef } = require("./discordStorage");

const titleId = process.env.PLAYFAB_TITLE_ID;
const secretKey = process.env.PLAYFAB_SECRET_KEY;
const legacyPlayersPath = path.join(__dirname, "..", "data", "players.json");

const titleDataKeys = {
  fish: "fish_config",
  rods: "rod_config",
  fishBags: "fish_bag_config",
  config: "admin_config",
  admins: "admin_access_config",
  settings: "game_settings_config",
  events: "event_config",
  routines: "routine_config",
  routineState: "routine_runtime_state",
  legacyConfigBackup: "admin_config_backup_before_split",
  playerIndex: "player_index"
};

const defaultSettings = {
  rodStoreImageBase64: "",
  rodStoreImageUrl: "",
  fishCompBannerBase64: "",
  fishCompBannerUrl: "",
  fishCompRegistrationBannerBase64: "",
  fishCompRegistrationBannerUrl: "",
  fishCompRunningBannerBase64: "",
  fishCompRunningBannerUrl: "",
  fishCompResultBannerBase64: "",
  fishCompResultBannerUrl: "",
  fishRaidBannerBase64: "",
  fishRaidBannerUrl: "",
  fishRaidRegistrationBannerBase64: "",
  fishRaidRegistrationBannerUrl: "",
  fishRaidRunningBannerBase64: "",
  fishRaidRunningBannerUrl: "",
  fishRaidResultBannerBase64: "",
  fishRaidResultBannerUrl: "",
  fishDuelRegistrationBannerBase64: "",
  fishDuelRegistrationBannerUrl: "",
  fishDuelRunningBannerBase64: "",
  fishDuelRunningBannerUrl: "",
  fishDuelResultBannerBase64: "",
  fishDuelResultBannerUrl: "",
  fishDuelEvents: defaultFishDuelEvents,
  fishDuelExpReward: 40,
  fishDuelLogIntervalMs: 2500,
  fishGuideBannerBase64: "",
  fishGuideBannerUrl: "",
  fishHelpBannerBase64: "",
  fishHelpBannerUrl: "",
  sellFishBannerBase64: "",
  sellFishBannerUrl: "",
  fishCompEvents: defaultFishCompEvents,
  fishRaidEvents: defaultFishRaidEvents,
  fishRaidBosses: [
    {
      id: "mbg_boss",
      name: "MBG Boss",
      quotaKg: 250,
      description: "Bos SPPG yang minta stok ikan untuk menu MBG hari ini, sambil mengeluh spreadsheet dapur lebih ganas daripada boss raid.",
      registrationBannerBase64: "",
      registrationBannerUrl: "",
      runningBannerBase64: "",
      runningBannerUrl: "",
      resultBannerBase64: "",
      resultBannerUrl: "",
      fulfilledBannerBase64: "",
      fulfilledBannerUrl: "",
      failedBannerBase64: "",
      failedBannerUrl: ""
    }
  ],
  fishCompLogIntervalMs: 2500,
  fishCompHistoryLogHours: 24,
  fishCompExpReward: 50,
  fishCompGoldReward: 0,
  fishRaidLogIntervalMs: 2500,
  fishRaidCooldownMinutes: 60,
  fishRaidParticipantExpReward: 25,
  fishRaidParticipantGoldReward: 0,
  fishRaidMvpExpReward: 75,
  fishRaidMvpGoldReward: 0,
  fishRaidClearParticipantExpReward: 50,
  fishRaidClearParticipantGoldReward: 0,
  fishRaidClearMvpExpReward: 150,
  fishRaidClearMvpGoldReward: 0,
  allowActivity: true,
  chatCooldownMs: 20_000,
  expMultiplier: 1,
  levelExpMultiplier: 1,
  voiceExpAmount: 1,
  voiceExpIntervalMinutes: 15
};
const titleDataChunkSize = 8_000;
const maxStoredImageLength = 500_000;
const externalRequestTimeoutMs = 30_000;
const sessionTicketTtlMs = 45 * 60_000;
const sessionTickets = new Map();
const indexedDiscordUsers = new Set();

function requireTitleId() {
  if (!titleId) {
    throw new Error("Missing PLAYFAB_TITLE_ID in .env.");
  }
}

function requireSecretKey() {
  if (!secretKey) {
    throw new Error("Missing PLAYFAB_SECRET_KEY in .env.");
  }
}

function isPlayFabThrottle(payload, response) {
  const message = String(payload?.errorMessage || response?.statusText || "").toLowerCase();
  return response?.status === 429 || message.includes("throttled") || message.includes("maximum api request rate");
}

function getRetryAfterMs(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.("retry-after") || 0);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.ceil(retryAfter * 1000);
  }
  return 500 * attempt;
}

async function callPlayFab(section, method, body, useSecretKey = false) {
  requireTitleId();

  if (useSecretKey) {
    requireSecretKey();
  }

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), externalRequestTimeoutMs);
    let response;
    try {
      response = await fetch(`https://${titleId}.playfabapi.com/${section}/${method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(useSecretKey ? { "X-SecretKey": secretKey } : {})
        },
        body: JSON.stringify(body || {}),
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`${section}/${method} timed out.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const payload = await response.json().catch(() => ({}));
    if ((!response.ok || payload.code !== 200) && isPlayFabThrottle(payload, response) && attempt < maxAttempts) {
      await sleep(getRetryAfterMs(response, attempt));
      continue;
    }
    if (!response.ok || payload.code !== 200) {
      const detail = payload.errorMessage || response.statusText || "Unknown PlayFab error";
      throw new Error(`${section}/${method} failed: ${detail}`);
    }

    return payload.data || {};
  }

  throw new Error(`${section}/${method} failed after retrying.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlayFabConflict(error) {
  return error?.message?.includes("conflict occurred trying to make multiple edits");
}

async function setTitleData(key, value) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await callPlayFab("Admin", "SetTitleData", {
        Key: key,
        Value: value
      }, true);
    } catch (error) {
      if (!isPlayFabConflict(error) || attempt === maxAttempts) {
        throw error;
      }

      await sleep(350 * attempt);
    }
  }
}

async function loginDiscordUser(discordUserId) {
  const cacheKey = String(discordUserId || "");
  const cached = sessionTickets.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.sessionTicket;
  }

  const result = await callPlayFab("Client", "LoginWithCustomID", {
    TitleId: titleId,
    CustomId: `discord:${discordUserId}`,
    CreateAccount: true
  });

  if (result.SessionTicket) {
    sessionTickets.set(cacheKey, {
      sessionTicket: result.SessionTicket,
      expiresAt: Date.now() + sessionTicketTtlMs
    });
  }
  return result.SessionTicket;
}

async function lookupDiscordUserLogin(discordUserId) {
  try {
    return await callPlayFab("Client", "LoginWithCustomID", {
      TitleId: titleId,
      CustomId: `discord:${discordUserId}`,
      CreateAccount: false
    });
  } catch (error) {
    if (error.message?.includes("Account not found") || error.message?.includes("AccountNotFound")) {
      return null;
    }
    throw error;
  }
}

async function callClientWithSession(method, sessionTicket, body) {
  requireTitleId();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), externalRequestTimeoutMs);
  let response;
  try {
    response = await fetch(`https://${titleId}.playfabapi.com/Client/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Authorization": sessionTicket
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Client/${method} timed out.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 200) {
    const detail = payload.errorMessage || response.statusText || "Unknown PlayFab error";
    throw new Error(`Client/${method} failed: ${detail}`);
  }

  return payload.data || {};
}

function makeDefaultPlayer() {
  const starterRodId = defaultRods[0]?.id || "twig";
  return {
    gold: 0,
    exp: 0,
    rodId: starterRodId,
    ownedRods: [starterRodId],
    fishBagId: "",
    ownedFishBags: [],
    inventory: {},
    fishDex: {},
    showcasedFishId: "",
    fishEntotLastUsedAt: 0,
    dailyLastClaimedAt: 0,
    dailyStreak: 0,
    totalFishCaught: 0,
    fishCompWins: 0,
    heaviestFish: null,
    luckiestFish: null,
    progress: 0,
    lastCountedAt: 0,
    lastMessage: "",
    lastFishingGuildId: "",
    lastFishingChannelId: "",
    voiceTotalMs: 0,
    voiceExpRemainderMs: 0
  };
}

function normalizePlayer(rawPlayer) {
  const starterRodId = defaultRods[0]?.id || "twig";
  const ownedRods = Array.isArray(rawPlayer?.ownedRods) && rawPlayer.ownedRods.length ? rawPlayer.ownedRods : [starterRodId];
  const ownedFishBags = Array.isArray(rawPlayer?.ownedFishBags) ? rawPlayer.ownedFishBags : [];
  const inventory = rawPlayer?.inventory && typeof rawPlayer.inventory === "object" ? rawPlayer.inventory : {};
  const rawFishDex = rawPlayer?.fishDex && typeof rawPlayer.fishDex === "object" ? rawPlayer.fishDex : {};
  const fishDex = {};
  for (const [fishId, entry] of Object.entries(rawFishDex)) {
    const source = entry && typeof entry === "object" ? entry : {};
    const count = Math.max(0, Math.floor(cleanNumber(source.count, Number(entry || 0))));
    const heaviestWeight = Math.max(0, cleanNumber(source.heaviestWeight, 0));
    if (count > 0 || heaviestWeight > 0) {
      fishDex[fishId] = { count, heaviestWeight };
    }
  }
  for (const [fishId, quantity] of Object.entries(inventory)) {
    const count = Math.max(0, Math.floor(cleanNumber(quantity, 0)));
    if (count <= 0) {
      continue;
    }
    fishDex[fishId] = {
      count: Math.max(count, Math.floor(cleanNumber(fishDex[fishId]?.count, 0))),
      heaviestWeight: Math.max(0, cleanNumber(fishDex[fishId]?.heaviestWeight, 0))
    };
  }
  const totalFromInventory = Object.values(inventory).reduce((sum, quantity) => sum + Math.max(0, Number(quantity || 0)), 0);
  const heaviestFish = rawPlayer?.heaviestFish && typeof rawPlayer.heaviestFish === "object"
    ? rawPlayer.heaviestFish
    : null;
  if (heaviestFish?.fishId) {
    const fishId = String(heaviestFish.fishId);
    fishDex[fishId] = {
      count: Math.max(1, Math.floor(cleanNumber(fishDex[fishId]?.count, 0))),
      heaviestWeight: Math.max(cleanNumber(fishDex[fishId]?.heaviestWeight, 0), cleanNumber(heaviestFish.weight, 0))
    };
  }
  const luckiestFish = rawPlayer?.luckiestFish && typeof rawPlayer.luckiestFish === "object"
    ? rawPlayer.luckiestFish
    : null;
  return {
    ...makeDefaultPlayer(),
    ...(rawPlayer && typeof rawPlayer === "object" ? rawPlayer : {}),
    inventory,
    fishDex,
    showcasedFishId: String(rawPlayer?.showcasedFishId || "").trim(),
    fishEntotLastUsedAt: Math.max(0, cleanNumber(rawPlayer?.fishEntotLastUsedAt, 0)),
    dailyLastClaimedAt: Math.max(0, cleanNumber(rawPlayer?.dailyLastClaimedAt, 0)),
    dailyStreak: Math.max(0, Math.floor(cleanNumber(rawPlayer?.dailyStreak, 0))),
    dailyReminderMessageId: undefined,
    dailyReminderChannelId: undefined,
    dailyReminderAvailableAt: undefined,
    totalFishCaught: Math.max(0, Number(rawPlayer?.totalFishCaught ?? totalFromInventory)),
    fishCompWins: Math.max(0, Math.floor(cleanNumber(rawPlayer?.fishCompWins, 0))),
    heaviestFish,
    luckiestFish,
    voiceTotalMs: Math.max(0, Number(rawPlayer?.voiceTotalMs || 0)),
    voiceExpRemainderMs: Math.max(0, Number(rawPlayer?.voiceExpRemainderMs || 0)),
    rodId: rawPlayer?.rodId === "twig" ? starterRodId : rawPlayer?.rodId || starterRodId,
    ownedRods: ownedRods.map((rodId) => (rodId === "twig" ? starterRodId : rodId)),
    fishBagId: String(rawPlayer?.fishBagId || "").trim(),
    ownedFishBags: ownedFishBags.map((bagId) => String(bagId || "").trim()).filter(Boolean)
  };
}

function applyPlayerIdentity(player, identity = {}) {
  const discordUserId = String(identity.discordUserId || identity.id || "").trim();
  const discordUsername = String(identity.username || "").trim();
  const discordGlobalName = String(identity.globalName || "").trim();
  const discordDisplayName = String(identity.displayName || "").trim();
  const discordAvatarUrl = String(identity.avatarUrl || "").trim();

  if (discordUserId) player.discordUserId = discordUserId;
  if (discordUsername) player.discordUsername = discordUsername;
  if (discordGlobalName) player.discordGlobalName = discordGlobalName;
  if (discordDisplayName) player.discordDisplayName = discordDisplayName;
  if (discordAvatarUrl) player.discordAvatarUrl = discordAvatarUrl;
  return player;
}

async function getPlayer(discordUserId, identity = {}) {
  const sessionTicket = await loginDiscordUser(discordUserId);
  const result = await callClientWithSession("GetUserData", sessionTicket, {
    Keys: ["player"]
  });

  const value = result.Data?.player?.Value;
  if (!value) {
    return { sessionTicket, player: applyPlayerIdentity(makeDefaultPlayer(), { ...identity, discordUserId }) };
  }

  try {
    return { sessionTicket, player: applyPlayerIdentity(normalizePlayer(JSON.parse(value)), { ...identity, discordUserId }) };
  } catch {
    return { sessionTicket, player: applyPlayerIdentity(makeDefaultPlayer(), { ...identity, discordUserId }) };
  }
}

async function savePlayer(sessionTicket, player) {
  const normalizedPlayer = normalizePlayer(player);
  await callClientWithSession("UpdateUserData", sessionTicket, {
    Data: {
      player: JSON.stringify(normalizedPlayer)
    }
  });
  rememberPlayerForAdminList(normalizedPlayer).catch((error) => console.error("Could not update player index:", error));
}

async function adminGetPlayerRecord(playFabId) {
  const [accountInfo, userData] = await Promise.all([
    callPlayFab("Admin", "GetUserAccountInfo", { PlayFabId: playFabId }, true).catch(() => ({})),
    callPlayFab("Admin", "GetUserData", { PlayFabId: playFabId, Keys: ["player"] }, true).catch(() => ({ Data: {} }))
  ]);
  const userInfo = accountInfo.UserInfo || {};
  let player = makeDefaultPlayer();
  if (userData.Data?.player?.Value) {
    try {
      player = normalizePlayer(JSON.parse(userData.Data.player.Value));
    } catch {
      player = makeDefaultPlayer();
    }
  }
  const customId = userInfo.CustomIdInfo?.CustomId || "";
  const discordUserId = String(player.discordUserId || (customId.startsWith("discord:") ? customId.slice("discord:".length) : "")).trim();
  applyPlayerIdentity(player, { discordUserId });

  return {
    playFabId,
    discordUserId,
    username: player.discordUsername || userInfo.TitleInfo?.DisplayName || userInfo.Username || "",
    displayName: player.discordDisplayName || player.discordGlobalName || player.discordUsername || userInfo.TitleInfo?.DisplayName || "",
    created: userInfo.Created || "",
    lastLogin: userInfo.TitleInfo?.LastLogin || "",
    player
  };
}

async function adminGetPlayerByDiscordId(discordUserId) {
  const login = await lookupDiscordUserLogin(discordUserId);
  if (!login?.PlayFabId) {
    return null;
  }
  return adminGetPlayerRecord(login.PlayFabId);
}

async function adminGetAllPlayersSegmentId() {
  const result = await callPlayFab("Admin", "GetAllSegments", {}, true);
  const segments = Array.isArray(result.Segments) ? result.Segments : [];
  const allPlayers = segments.find((segment) => String(segment.Name || "").toLowerCase() === "all players")
    || segments.find((segment) => String(segment.Name || "").toLowerCase().includes("all"));
  if (!allPlayers?.Id) {
    throw new Error('Could not find the PlayFab "All Players" segment.');
  }
  return allPlayers.Id;
}

async function adminListPlayerProfiles(limit = 250) {
  try {
    const segmentId = await adminGetAllPlayersSegmentId();
    const profiles = [];
    let continuationToken = "";
    do {
      const result = await callPlayFab("Admin", "GetPlayersInSegment", {
        SegmentId: segmentId,
        ContinuationToken: continuationToken || undefined,
        MaxBatchSize: Math.min(100, Math.max(1, limit - profiles.length)),
        SecondsToLive: 300
      }, true);
      profiles.push(...(Array.isArray(result.PlayerProfiles) ? result.PlayerProfiles : []));
      continuationToken = result.ContinuationToken || "";
    } while (continuationToken && profiles.length < limit);
    return profiles;
  } catch (error) {
    console.warn(`Could not list PlayFab players from segment: ${error.message}`);
    return [];
  }
}

async function loadPlayerIndex() {
  const records = parseList(await loadTitleAsset(titleDataKeys.playerIndex, true).catch(() => ""), []);
  return records
    .filter((record) => record && typeof record === "object")
    .map((record) => ({
      playFabId: String(record.playFabId || "").trim(),
      discordUserId: String(record.discordUserId || "").trim()
    }))
    .filter((record) => record.playFabId);
}

async function savePlayerIndex(records) {
  const unique = new Map();
  for (const record of records || []) {
    const playFabId = String(record?.playFabId || "").trim();
    if (playFabId) {
      unique.set(playFabId, {
        playFabId,
        discordUserId: String(record?.discordUserId || "").trim()
      });
    }
  }
  await saveTitleAsset(titleDataKeys.playerIndex, JSON.stringify([...unique.values()]));
}

async function rememberPlayerForAdminList(player) {
  const discordUserId = String(player?.discordUserId || "").trim();
  if (!discordUserId) {
    return;
  }
  if (indexedDiscordUsers.has(discordUserId)) {
    return;
  }
  const login = await lookupDiscordUserLogin(discordUserId);
  if (!login?.PlayFabId) {
    return;
  }
  const records = await loadPlayerIndex();
  const existing = records.filter((record) => record.playFabId !== login.PlayFabId);
  existing.push({ playFabId: login.PlayFabId, discordUserId });
  await savePlayerIndex(existing);
  indexedDiscordUsers.add(discordUserId);
}

async function removePlayerFromAdminList(playFabId) {
  const selectedPlayFabId = String(playFabId || "").trim();
  if (!selectedPlayFabId) {
    return;
  }
  const records = await loadPlayerIndex();
  await savePlayerIndex(records.filter((record) => record.playFabId !== selectedPlayFabId));
}

function loadLegacyDiscordPlayerIds() {
  if (!fs.existsSync(legacyPlayersPath)) {
    return [];
  }
  try {
    const players = JSON.parse(fs.readFileSync(legacyPlayersPath, "utf8"));
    return Object.keys(players || {}).filter((id) => /^\d{12,}$/.test(id));
  } catch {
    return [];
  }
}

async function adminListPlayers(search = "", options = {}) {
  const query = String(search || "").trim().toLowerCase();
  const preferIndex = options?.preferIndex === true;
  const directDiscordId = /^\d{12,}$/.test(query) ? await adminGetPlayerByDiscordId(query) : null;
  let profiles = [];
  let indexedPlayers = [];
  if (preferIndex) {
    indexedPlayers = await loadPlayerIndex();
  }
  if (!indexedPlayers.length) {
    try {
      profiles = await adminListPlayerProfiles();
    } catch (error) {
      console.warn(`PlayFab player segment listing unavailable | time=${new Date().toISOString()} | message=Admin/GetPlayersInSegment could not list the All Players segment. Using saved player index fallback instead. Detail: ${error.message}`);
    }
  }
  if (!profiles.length && !indexedPlayers.length) {
    indexedPlayers = await loadPlayerIndex();
  }
  const legacyPlayers = profiles.length || indexedPlayers.length ? [] : await Promise.all(loadLegacyDiscordPlayerIds().map(async (discordUserId) => {
    const login = await lookupDiscordUserLogin(discordUserId).catch(() => null);
    return login?.PlayFabId ? { playFabId: login.PlayFabId, discordUserId } : null;
  }));
  const playFabIds = [...new Set([
    directDiscordId?.playFabId,
    ...profiles.map((profile) => profile.PlayerId || profile.PlayFabId || profile.playFabId),
    ...indexedPlayers.map((record) => record.playFabId),
    ...legacyPlayers.filter(Boolean).map((record) => record.playFabId)
  ].filter(Boolean))];
  const records = [];
  let attempted = 0;
  for (const playFabId of playFabIds) {
    try {
      records.push(await adminGetPlayerRecord(playFabId));
    } catch (error) {
      console.error(`Could not load player ${playFabId}:`, error);
    }
    attempted += 1;
    if (typeof options?.onProgress === "function") {
      options.onProgress({ current: attempted, loaded: records.length, total: playFabIds.length, playFabId });
    }
  }
  return records
    .filter((record) => {
      if (!query) return true;
      return [
        record.playFabId,
        record.discordUserId,
        record.username,
        record.displayName,
        record.player.discordUsername,
        record.player.discordGlobalName,
        record.player.discordDisplayName
      ].some((value) => String(value || "").toLowerCase().includes(query));
    })
    .sort((a, b) => (b.player.totalFishCaught || 0) - (a.player.totalFishCaught || 0) || String(a.username || "").localeCompare(String(b.username || "")));
}

async function adminSavePlayerData(playFabId, player, options = {}) {
  const normalizedPlayer = normalizePlayer(player);
  await callPlayFab("Admin", "UpdateUserData", {
    PlayFabId: playFabId,
    Data: {
      player: JSON.stringify(normalizedPlayer)
    }
  }, true);
  if (options?.refetch === false) {
    if (options?.remember !== false) {
      rememberPlayerForAdminList(normalizedPlayer).catch((error) => console.error("Could not update player index:", error));
    }
    return {
      playFabId,
      discordUserId: String(normalizedPlayer.discordUserId || "").trim(),
      username: normalizedPlayer.discordUsername || "",
      displayName: normalizedPlayer.discordDisplayName || normalizedPlayer.discordGlobalName || normalizedPlayer.discordUsername || "",
      created: "",
      lastLogin: "",
      player: normalizedPlayer
    };
  }
  const record = await adminGetPlayerRecord(playFabId);
  await rememberPlayerForAdminList(record.player).catch((error) => console.error("Could not update player index:", error));
  return record;
}

async function adminResetPlayerData(playFabId) {
  const record = await adminGetPlayerRecord(playFabId);
  const player = applyPlayerIdentity(makeDefaultPlayer(), {
    discordUserId: record.discordUserId,
    username: record.player.discordUsername,
    globalName: record.player.discordGlobalName,
    displayName: record.player.discordDisplayName,
    avatarUrl: record.player.discordAvatarUrl
  });
  return adminSavePlayerData(playFabId, player);
}

async function adminDeletePlayer(playFabId) {
  await callPlayFab("Server", "DeletePlayer", { PlayFabId: playFabId }, true);
  await removePlayerFromAdminList(playFabId).catch((error) => console.error("Could not update player index:", error));
  sessionTickets.clear();
  return { ok: true, playFabId };
}

function parseList(value, fallback, options = {}) {
  if (!value) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return fallback;
    }
    return options.fallbackWhenEmpty && parsed.length === 0 ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function parseConfig(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function cleanAdminDiscordIds(adminDiscordIds) {
  return [...new Set((Array.isArray(adminDiscordIds) ? adminDiscordIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean))];
}

function cleanNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function imageNeedsRehost(source, key) {
  return source?.[`${key}NeedsRehost`] === true;
}

function cleanSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const rodStoreImageUrl = String(source.rodStoreImageUrl || "").trim();
  const fishCompBannerUrl = String(source.fishCompBannerUrl || "").trim();
  const fishCompRegistrationBannerUrl = String(source.fishCompRegistrationBannerUrl || "").trim();
  const fishCompRunningBannerUrl = String(source.fishCompRunningBannerUrl || "").trim();
  const fishCompResultBannerUrl = String(source.fishCompResultBannerUrl || "").trim();
  const fishRaidBannerUrl = String(source.fishRaidBannerUrl || "").trim();
  const fishRaidRegistrationBannerUrl = String(source.fishRaidRegistrationBannerUrl || "").trim();
  const fishRaidRunningBannerUrl = String(source.fishRaidRunningBannerUrl || "").trim();
  const fishRaidResultBannerUrl = String(source.fishRaidResultBannerUrl || "").trim();
  const fishDuelRegistrationBannerUrl = String(source.fishDuelRegistrationBannerUrl || "").trim();
  const fishDuelRunningBannerUrl = String(source.fishDuelRunningBannerUrl || "").trim();
  const fishDuelResultBannerUrl = String(source.fishDuelResultBannerUrl || "").trim();
  const fishGuideBannerUrl = String(source.fishGuideBannerUrl || "").trim();
  const fishHelpBannerUrl = String(source.fishHelpBannerUrl || "").trim();
  const sellFishBannerUrl = String(source.sellFishBannerUrl || "").trim();
  return {
    rodStoreImageBase64: String(source.rodStoreImageBase64 || ""),
    rodStoreImageUrl,
    rodStoreImageContentKey: String(source.rodStoreImageContentKey || "").trim(),
    rodStoreImageRef: source.rodStoreImageRef && typeof source.rodStoreImageRef === "object" ? source.rodStoreImageRef : null,
    rodStoreImageUrlNeedsRehost: imageNeedsRehost(source, "rodStoreImageUrl"),
    fishCompBannerBase64: String(source.fishCompBannerBase64 || ""),
    fishCompBannerUrl,
    fishCompBannerContentKey: String(source.fishCompBannerContentKey || "").trim(),
    fishCompBannerRef: source.fishCompBannerRef && typeof source.fishCompBannerRef === "object" ? source.fishCompBannerRef : null,
    fishCompBannerUrlNeedsRehost: imageNeedsRehost(source, "fishCompBannerUrl"),
    fishCompRegistrationBannerBase64: String(source.fishCompRegistrationBannerBase64 || ""),
    fishCompRegistrationBannerUrl,
    fishCompRegistrationBannerRef: source.fishCompRegistrationBannerRef && typeof source.fishCompRegistrationBannerRef === "object" ? source.fishCompRegistrationBannerRef : null,
    fishCompRegistrationBannerUrlNeedsRehost: imageNeedsRehost(source, "fishCompRegistrationBannerUrl"),
    fishCompRunningBannerBase64: String(source.fishCompRunningBannerBase64 || ""),
    fishCompRunningBannerUrl,
    fishCompRunningBannerRef: source.fishCompRunningBannerRef && typeof source.fishCompRunningBannerRef === "object" ? source.fishCompRunningBannerRef : null,
    fishCompRunningBannerUrlNeedsRehost: imageNeedsRehost(source, "fishCompRunningBannerUrl"),
    fishCompResultBannerBase64: String(source.fishCompResultBannerBase64 || ""),
    fishCompResultBannerUrl,
    fishCompResultBannerRef: source.fishCompResultBannerRef && typeof source.fishCompResultBannerRef === "object" ? source.fishCompResultBannerRef : null,
    fishCompResultBannerUrlNeedsRehost: imageNeedsRehost(source, "fishCompResultBannerUrl"),
    fishRaidBannerBase64: String(source.fishRaidBannerBase64 || ""),
    fishRaidBannerUrl,
    fishRaidBannerRef: source.fishRaidBannerRef && typeof source.fishRaidBannerRef === "object" ? source.fishRaidBannerRef : null,
    fishRaidBannerUrlNeedsRehost: imageNeedsRehost(source, "fishRaidBannerUrl"),
    fishRaidRegistrationBannerBase64: String(source.fishRaidRegistrationBannerBase64 || ""),
    fishRaidRegistrationBannerUrl,
    fishRaidRegistrationBannerRef: source.fishRaidRegistrationBannerRef && typeof source.fishRaidRegistrationBannerRef === "object" ? source.fishRaidRegistrationBannerRef : null,
    fishRaidRegistrationBannerUrlNeedsRehost: imageNeedsRehost(source, "fishRaidRegistrationBannerUrl"),
    fishRaidRunningBannerBase64: String(source.fishRaidRunningBannerBase64 || ""),
    fishRaidRunningBannerUrl,
    fishRaidRunningBannerRef: source.fishRaidRunningBannerRef && typeof source.fishRaidRunningBannerRef === "object" ? source.fishRaidRunningBannerRef : null,
    fishRaidRunningBannerUrlNeedsRehost: imageNeedsRehost(source, "fishRaidRunningBannerUrl"),
    fishRaidResultBannerBase64: String(source.fishRaidResultBannerBase64 || ""),
    fishRaidResultBannerUrl,
    fishRaidResultBannerRef: source.fishRaidResultBannerRef && typeof source.fishRaidResultBannerRef === "object" ? source.fishRaidResultBannerRef : null,
    fishRaidResultBannerUrlNeedsRehost: imageNeedsRehost(source, "fishRaidResultBannerUrl"),
    fishDuelRegistrationBannerBase64: String(source.fishDuelRegistrationBannerBase64 || ""),
    fishDuelRegistrationBannerUrl,
    fishDuelRegistrationBannerRef: source.fishDuelRegistrationBannerRef && typeof source.fishDuelRegistrationBannerRef === "object" ? source.fishDuelRegistrationBannerRef : null,
    fishDuelRegistrationBannerUrlNeedsRehost: imageNeedsRehost(source, "fishDuelRegistrationBannerUrl"),
    fishDuelRunningBannerBase64: String(source.fishDuelRunningBannerBase64 || ""),
    fishDuelRunningBannerUrl,
    fishDuelRunningBannerRef: source.fishDuelRunningBannerRef && typeof source.fishDuelRunningBannerRef === "object" ? source.fishDuelRunningBannerRef : null,
    fishDuelRunningBannerUrlNeedsRehost: imageNeedsRehost(source, "fishDuelRunningBannerUrl"),
    fishDuelResultBannerBase64: String(source.fishDuelResultBannerBase64 || ""),
    fishDuelResultBannerUrl,
    fishDuelResultBannerRef: source.fishDuelResultBannerRef && typeof source.fishDuelResultBannerRef === "object" ? source.fishDuelResultBannerRef : null,
    fishDuelResultBannerUrlNeedsRehost: imageNeedsRehost(source, "fishDuelResultBannerUrl"),
    fishGuideBannerBase64: String(source.fishGuideBannerBase64 || ""),
    fishGuideBannerUrl,
    fishGuideBannerRef: source.fishGuideBannerRef && typeof source.fishGuideBannerRef === "object" ? source.fishGuideBannerRef : null,
    fishGuideBannerUrlNeedsRehost: imageNeedsRehost(source, "fishGuideBannerUrl"),
    fishHelpBannerBase64: String(source.fishHelpBannerBase64 || ""),
    fishHelpBannerUrl,
    fishHelpBannerRef: source.fishHelpBannerRef && typeof source.fishHelpBannerRef === "object" ? source.fishHelpBannerRef : null,
    fishHelpBannerUrlNeedsRehost: imageNeedsRehost(source, "fishHelpBannerUrl"),
    sellFishBannerBase64: String(source.sellFishBannerBase64 || ""),
    sellFishBannerUrl,
    sellFishBannerRef: source.sellFishBannerRef && typeof source.sellFishBannerRef === "object" ? source.sellFishBannerRef : null,
    sellFishBannerUrlNeedsRehost: imageNeedsRehost(source, "sellFishBannerUrl"),
    fishCompEvents: cleanFishCompEvents(source.fishCompEvents),
    fishRaidEvents: cleanFishCompEvents(source.fishRaidEvents, defaultSettings.fishRaidEvents),
    fishDuelEvents: cleanFishCompEvents(source.fishDuelEvents, defaultSettings.fishDuelEvents),
    fishRaidBosses: cleanFishRaidBosses(source.fishRaidBosses),
    fishCompLogIntervalMs: Math.max(0, cleanNumber(source.fishCompLogIntervalMs ?? defaultSettings.fishCompLogIntervalMs, defaultSettings.fishCompLogIntervalMs)),
    fishCompHistoryLogHours: Math.max(0, cleanNumber(source.fishCompHistoryLogHours ?? defaultSettings.fishCompHistoryLogHours, defaultSettings.fishCompHistoryLogHours)),
    fishCompExpReward: Math.max(0, cleanNumber(source.fishCompExpReward ?? defaultSettings.fishCompExpReward, defaultSettings.fishCompExpReward)),
    fishCompGoldReward: Math.max(0, cleanNumber(source.fishCompGoldReward ?? defaultSettings.fishCompGoldReward, defaultSettings.fishCompGoldReward)),
    fishDuelExpReward: Math.max(0, cleanNumber(source.fishDuelExpReward ?? defaultSettings.fishDuelExpReward, defaultSettings.fishDuelExpReward)),
    fishDuelLogIntervalMs: Math.max(0, cleanNumber(source.fishDuelLogIntervalMs ?? defaultSettings.fishDuelLogIntervalMs, defaultSettings.fishDuelLogIntervalMs)),
    fishRaidLogIntervalMs: Math.max(0, cleanNumber(source.fishRaidLogIntervalMs ?? defaultSettings.fishRaidLogIntervalMs, defaultSettings.fishRaidLogIntervalMs)),
    fishRaidCooldownMinutes: Math.max(0, cleanNumber(source.fishRaidCooldownMinutes ?? defaultSettings.fishRaidCooldownMinutes, defaultSettings.fishRaidCooldownMinutes)),
    fishRaidParticipantExpReward: Math.max(0, cleanNumber(source.fishRaidParticipantExpReward ?? defaultSettings.fishRaidParticipantExpReward, defaultSettings.fishRaidParticipantExpReward)),
    fishRaidParticipantGoldReward: Math.max(0, cleanNumber(source.fishRaidParticipantGoldReward ?? defaultSettings.fishRaidParticipantGoldReward, defaultSettings.fishRaidParticipantGoldReward)),
    fishRaidMvpExpReward: Math.max(0, cleanNumber(source.fishRaidMvpExpReward ?? defaultSettings.fishRaidMvpExpReward, defaultSettings.fishRaidMvpExpReward)),
    fishRaidMvpGoldReward: Math.max(0, cleanNumber(source.fishRaidMvpGoldReward ?? defaultSettings.fishRaidMvpGoldReward, defaultSettings.fishRaidMvpGoldReward)),
    fishRaidClearParticipantExpReward: Math.max(0, cleanNumber(source.fishRaidClearParticipantExpReward ?? defaultSettings.fishRaidClearParticipantExpReward, defaultSettings.fishRaidClearParticipantExpReward)),
    fishRaidClearParticipantGoldReward: Math.max(0, cleanNumber(source.fishRaidClearParticipantGoldReward ?? defaultSettings.fishRaidClearParticipantGoldReward, defaultSettings.fishRaidClearParticipantGoldReward)),
    fishRaidClearMvpExpReward: Math.max(0, cleanNumber(source.fishRaidClearMvpExpReward ?? defaultSettings.fishRaidClearMvpExpReward, defaultSettings.fishRaidClearMvpExpReward)),
    fishRaidClearMvpGoldReward: Math.max(0, cleanNumber(source.fishRaidClearMvpGoldReward ?? defaultSettings.fishRaidClearMvpGoldReward, defaultSettings.fishRaidClearMvpGoldReward)),
    allowActivity: source.allowActivity !== false,
    chatCooldownMs: Math.max(0, Number(source.chatCooldownMs ?? defaultSettings.chatCooldownMs) || defaultSettings.chatCooldownMs),
    expMultiplier: Math.max(0, Number(source.expMultiplier ?? defaultSettings.expMultiplier) || defaultSettings.expMultiplier),
    levelExpMultiplier: Math.max(0.01, Number(source.levelExpMultiplier ?? defaultSettings.levelExpMultiplier) || defaultSettings.levelExpMultiplier),
    voiceExpAmount: Math.max(0, cleanNumber(source.voiceExpAmount ?? defaultSettings.voiceExpAmount, defaultSettings.voiceExpAmount)),
    voiceExpIntervalMinutes: Math.max(1, cleanNumber(source.voiceExpIntervalMinutes ?? defaultSettings.voiceExpIntervalMinutes, defaultSettings.voiceExpIntervalMinutes))
  };
}

function cleanFishCompEvents(events, fallbackEvents = defaultSettings.fishCompEvents) {
  return (Array.isArray(events) ? events : fallbackEvents).map((event, index) => {
    const source = event && typeof event === "object" ? event : {};
    return {
      id: String(source.id || `event_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"),
      name: String(source.name || source.id || `Event ${index + 1}`).trim(),
      chance: Math.max(0, cleanNumber(source.chance, 0)),
      type: String(source.type || "empty").trim(),
      durationTurns: Math.max(1, Math.floor(cleanNumber(source.durationTurns, 1))),
      luckModifier: cleanNumber(source.luckModifier, 0),
      canFishOnStart: source.canFishOnStart !== false,
      canFishWhileActive: source.canFishWhileActive !== false,
      canFishOnEnd: source.canFishOnEnd !== false,
      affectOther: source.affectOther === true,
      affectOtherChance: Math.max(0, cleanNumber(source.affectOtherChance, 100)),
      otherType: String(source.otherType || source.type || "empty").trim(),
      otherDurationTurns: Math.max(1, Math.floor(cleanNumber(source.otherDurationTurns, source.durationTurns || 1))),
      otherLuckModifier: cleanNumber(source.otherLuckModifier, source.luckModifier || 0),
      startText: String(source.startText || "").trim(),
      activeText: String(source.activeText || "").trim(),
      endText: String(source.endText || "").trim(),
      otherStartText: String(source.otherStartText || "").trim(),
      otherActiveText: String(source.otherActiveText || "").trim(),
      otherEndText: String(source.otherEndText || "").trim()
    };
  }).filter((event) => event.id && event.chance > 0 && event.startText);
}

function cleanFishRaidBosses(bosses) {
  return (Array.isArray(bosses) && bosses.length ? bosses : defaultSettings.fishRaidBosses).map((boss, index) => {
    const source = boss && typeof boss === "object" ? boss : {};
    const id = String(source.id || `raid_boss_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    return {
      id,
      name: String(source.name || source.title || id || `Raid Boss ${index + 1}`).trim(),
      quotaKg: Math.max(1, cleanNumber(source.quotaKg ?? source.quota ?? 100, 100)),
      description: String(source.description || "").trim(),
      registrationBannerBase64: String(source.registrationBannerBase64 || ""),
      registrationBannerUrl: String(source.registrationBannerUrl || "").trim(),
      registrationBannerRef: source.registrationBannerRef && typeof source.registrationBannerRef === "object" ? source.registrationBannerRef : null,
      registrationBannerUrlNeedsRehost: imageNeedsRehost(source, "registrationBannerUrl"),
      runningBannerBase64: String(source.runningBannerBase64 || ""),
      runningBannerUrl: String(source.runningBannerUrl || "").trim(),
      runningBannerRef: source.runningBannerRef && typeof source.runningBannerRef === "object" ? source.runningBannerRef : null,
      runningBannerUrlNeedsRehost: imageNeedsRehost(source, "runningBannerUrl"),
      resultBannerBase64: String(source.resultBannerBase64 || ""),
      resultBannerUrl: String(source.resultBannerUrl || "").trim(),
      resultBannerRef: source.resultBannerRef && typeof source.resultBannerRef === "object" ? source.resultBannerRef : null,
      resultBannerUrlNeedsRehost: imageNeedsRehost(source, "resultBannerUrl"),
      fulfilledBannerBase64: String(source.fulfilledBannerBase64 || ""),
      fulfilledBannerUrl: String(source.fulfilledBannerUrl || "").trim(),
      fulfilledBannerRef: source.fulfilledBannerRef && typeof source.fulfilledBannerRef === "object" ? source.fulfilledBannerRef : null,
      fulfilledBannerUrlNeedsRehost: imageNeedsRehost(source, "fulfilledBannerUrl"),
      failedBannerBase64: String(source.failedBannerBase64 || ""),
      failedBannerUrl: String(source.failedBannerUrl || "").trim(),
      failedBannerRef: source.failedBannerRef && typeof source.failedBannerRef === "object" ? source.failedBannerRef : null,
      failedBannerUrlNeedsRehost: imageNeedsRehost(source, "failedBannerUrl")
    };
  }).filter((boss) => boss.id && boss.name);
}

function cleanEventBonus(bonus) {
  const source = bonus && typeof bonus === "object" ? bonus : {};
  return {
    type: String(source.type || "gold_multiplier").trim(),
    value: Math.max(0, Number(source.value || 1)),
    fishId: String(source.fishId || "").trim()
  };
}

function cleanEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const bannerUrl = String(event.bannerUrl || "").trim();
  const startAt = String(event.startAt || event.deployedAt || "").trim();
  const durationMinutes = Math.max(1, Number(event.durationMinutes || 60));
  const endsAt = String(event.endsAt || (startAt ? new Date(Date.parse(startAt) + durationMinutes * 60_000).toISOString() : "")).trim();
  const bonuses = (Array.isArray(event.bonuses) && event.bonuses.length
    ? event.bonuses
    : [{ type: event.type, value: event.value, fishId: event.fishId }]).map(cleanEventBonus);
  return {
    id: String(event.id || Date.now()),
    title: String(event.title || "").trim(),
    description: String(event.description || "").trim(),
    bannerBase64: String(event.bannerBase64 || ""),
    bannerUrl,
    bannerContentKey: String(event.bannerContentKey || "").trim(),
    bannerRef: event.bannerRef && typeof event.bannerRef === "object" ? event.bannerRef : null,
    bannerUrlNeedsRehost: imageNeedsRehost(event, "bannerUrl"),
    startAt,
    durationMinutes,
    endsAt,
    bonuses,
    type: bonuses[0]?.type || "gold_multiplier",
    value: bonuses[0]?.value ?? 1,
    fishId: bonuses[0]?.fishId || "",
    announcementChannelId: String(event.announcementChannelId || "").trim(),
    guildId: String(event.guildId || "").trim(),
    isAnnounced: event.isAnnounced === true,
    stoppedAt: String(event.stoppedAt || "").trim(),
    deployedAt: String(event.deployedAt || "").trim()
  };
}

function cleanEvents(events, activeEvent) {
  const sourceEvents = Array.isArray(events) ? events : [];
  const mergedEvents = [...sourceEvents];
  if (activeEvent && !mergedEvents.some((event) => String(event?.id || "") === String(activeEvent.id || ""))) {
    mergedEvents.push(activeEvent);
  }
  return mergedEvents.map(cleanEvent).filter(Boolean);
}

function cleanRoutineButton(button) {
  const source = button && typeof button === "object" ? button : {};
  const action = String(source.action || "fishcomp").trim();
  return {
    id: String(source.id || `${action}_${Date.now()}`).trim().toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 80),
    label: String(source.label || action).trim().slice(0, 80),
    action,
    style: String(source.style || "Primary").trim(),
    regtimeMinutes: Math.max(1, Math.floor(cleanNumber(source.regtimeMinutes, 5))),
    durationTurns: Math.max(1, Math.floor(cleanNumber(source.durationTurns, 15)))
  };
}

function cleanRoutineMessageVariants(routine) {
  const variants = Array.isArray(routine.messageVariants) ? routine.messageVariants : [];
  return variants.map((variant) => {
    if (typeof variant === "string") {
      return { title: "", description: variant.trim() };
    }
    const source = variant && typeof variant === "object" ? variant : {};
    return {
      title: String(source.title || "").trim(),
      description: String(source.description || source.message || "").trim()
    };
  }).filter((variant) => variant.title || variant.description).slice(0, 100);
}

function cleanRoutineMessage(routine) {
  if (!routine || typeof routine !== "object") {
    return null;
  }

  const condition = routine.condition && typeof routine.condition === "object" ? routine.condition : {};
  const type = String(condition.type || routine.conditionType || "daily_time").trim();
  return {
    id: String(routine.id || Date.now()).trim(),
    name: String(routine.name || routine.title || "Routine Message").trim(),
    title: String(routine.title || routine.name || "Routine Message").trim(),
    description: String(routine.description || "").trim(),
    messageVariants: cleanRoutineMessageVariants(routine),
    color: String(routine.color || "#36c28a").trim(),
    bannerBase64: String(routine.bannerBase64 || ""),
    bannerUrl: String(routine.bannerUrl || "").trim(),
    bannerContentKey: String(routine.bannerContentKey || "").trim(),
    bannerRef: routine.bannerRef && typeof routine.bannerRef === "object" ? routine.bannerRef : null,
    bannerUrlNeedsRehost: imageNeedsRehost(routine, "bannerUrl"),
    enabled: routine.enabled !== false,
    deleteAfterButtonClick: routine.deleteAfterButtonClick === true,
    guildId: String(routine.guildId || "").trim(),
    channelId: String(routine.channelId || "").trim(),
    lastSentAt: String(routine.lastSentAt || "").trim(),
    lastTriggerKey: String(routine.lastTriggerKey || "").trim(),
    lastSentByGuild: routine.lastSentByGuild && typeof routine.lastSentByGuild === "object" && !Array.isArray(routine.lastSentByGuild) ? routine.lastSentByGuild : {},
    condition: {
      type,
      time: String(condition.time || "00:00").trim(),
      intervalMinutes: Math.max(1, Math.floor(cleanNumber(condition.intervalMinutes, 60))),
      idleMinutes: Math.max(1, Math.floor(cleanNumber(condition.idleMinutes, 120))),
      dateTime: String(condition.dateTime || "").trim()
    },
    buttons: (Array.isArray(routine.buttons) ? routine.buttons : []).map(cleanRoutineButton).filter((button) => button.id && button.label && button.action).slice(0, 25)
  };
}

function cleanRoutineMessages(routineMessages) {
  return (Array.isArray(routineMessages) ? routineMessages : []).map(cleanRoutineMessage).filter(Boolean);
}

function assertUniqueItemIds(items, type) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new Error(`Duplicate ${type} ID "${item.id}". Each ${type} needs a unique ID before saving images.`);
    }
    seen.add(item.id);
  }
}

function iconContentKeyFor(type, id, extension = "png") {
  return `images/${type}/${id}.${extension}`;
}

function storeContentKeyFor(extension = "png") {
  return `images/store/rod-store.${extension}`;
}

function fishCompBannerContentKeyFor(extension = "png") {
  return `images/competition/fish-comp-banner.${extension}`;
}

function settingsImageContentKeyFor(name, extension = "png") {
  return `images/settings/${name}.${extension}`;
}

function eventContentKeyFor(eventId, extension = "png") {
  return `images/events/${eventId || "active"}.${extension}`;
}

function fishRaidBossContentKeyFor(bossId, bannerName, extension = "png") {
  const safeBossId = String(bossId || "boss").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_") || "boss";
  const safeBannerName = String(bannerName || "banner").trim().toLowerCase().replace(/[^a-z0-9_]/g, "-") || "banner";
  return `images/fish-raid-bosses/${safeBossId}-${safeBannerName}.${extension}`;
}

function chunkKeyFor(key, index) {
  return `${key}_chunk_${index}`;
}

function parseAssetManifest(value) {
  if (!value) {
    return null;
  }

  if (value.startsWith("data:")) {
    return { type: "inline", value };
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && parsed.storage === "title_data_chunks" && parsed.key && Number.isInteger(parsed.chunks)
      ? parsed
      : { type: "inline", value };
  } catch {
    return { type: "inline", value };
  }
}

async function saveTitleAsset(key, value) {
  const assetValue = String(value || "");
  if (!assetValue) {
    await clearTitleAsset(key);
    return null;
  }

  if (assetValue.length > maxStoredImageLength) {
    throw new Error(`Image for ${key} is too large for PlayFab Title Data. Use an image URL instead, or upload an image under ${Math.round(maxStoredImageLength / 1024)} KB.`);
  }

  const previousResult = await callPlayFab("Server", "GetTitleData", { Keys: [key] }, true).catch(() => ({ Data: {} }));
  const previousManifest = parseAssetManifest(previousResult.Data?.[key] || "");
  const revisionKey = `${key}_rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const chunks = [];
  for (let index = 0; index < assetValue.length; index += titleDataChunkSize) {
    chunks.push(assetValue.slice(index, index + titleDataChunkSize));
  }

  for (const [index, chunk] of chunks.entries()) {
    await setTitleData(chunkKeyFor(revisionKey, index), chunk);
  }

  const manifest = {
    storage: "title_data_chunks",
    key: revisionKey,
    chunks: chunks.length
  };

  await setTitleData(key, JSON.stringify(manifest));

  // The manifest is switched only after every new chunk exists, so readers can
  // never observe a half-written JSON document. Old chunks are best-effort cleanup.
  if (previousManifest?.storage === "title_data_chunks" && previousManifest.key !== revisionKey) {
    for (let index = 0; index < previousManifest.chunks; index += 1) {
      await setTitleData(chunkKeyFor(previousManifest.key, index), "").catch(() => {});
    }
  }

  return manifest;
}

async function clearTitleAsset(key) {
  const result = await callPlayFab("Server", "GetTitleData", { Keys: [key] }, true).catch(() => ({ Data: {} }));
  const manifest = parseAssetManifest(result.Data?.[key] || "");

  if (manifest?.storage === "title_data_chunks") {
    for (let index = 0; index < manifest.chunks; index += 1) {
      await setTitleData(chunkKeyFor(manifest.key, index), "");
    }
  }

  await setTitleData(key, "");
}

function parseDataImageSource(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    return null;
  }

  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    return null;
  }

  const extension = match[1].split("/")[1].replace("jpeg", "jpg");
  return {
    buffer: Buffer.from(match[2], "base64"),
    contentType: match[1],
    extension
  };
}

function extensionFromContentType(contentType) {
  return {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp"
  }[String(contentType || "").split(";")[0].toLowerCase()] || "png";
}

function isDiscordHostedImageUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    return false;
  }
  return /(^|\.)discord(?:app)?\.(?:com|net)$/i.test(parsed.hostname)
    || /(^|\.)discordapp\.(?:com|net)$/i.test(parsed.hostname)
    || /(^|\.)discordapp\.net$/i.test(parsed.hostname);
}

async function imageSourceToBuffer({ dataUrl, sourceUrl }) {
  const dataImage = parseDataImageSource(dataUrl);
  if (dataImage) {
    return dataImage;
  }

  const url = String(sourceUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), externalRequestTimeoutMs);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Could not download image URL: request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Could not download image URL: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type")?.split(";")[0].toLowerCase() || "";
  if (!["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"].includes(contentType)) {
    throw new Error("Image URL must point directly to a PNG, JPG, GIF, or WebP image.");
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType,
    extension: extensionFromContentType(contentType)
  };
}

async function uploadContentBuffer(contentKey, image) {
  return uploadDiscordImageWithRef({
    buffer: image.buffer,
    contentType: image.contentType,
    fileName: contentKey.split("/").pop() || `image.${image.extension}`
  });
}

function imageContextLabel(context) {
  if (!context) {
    return "saved manager image";
  }
  if (typeof context === "string") {
    return context;
  }
  return [context.type, context.name || context.id].filter(Boolean).join(" ") || "saved manager image";
}

function imageContextCaller(context) {
  return context && typeof context === "object" && context.caller ? String(context.caller) : "";
}

async function getStoredImageUrl(ref, fallbackUrl = "", legacyContentKey = "", context = "") {
  const directUrl = String(fallbackUrl || "").trim();
  if (ref?.storage === "discord_attachment") {
    return await getDiscordImageUrl(ref).catch((error) => {
      console.warn(formatDiscordImageRefreshError(error, ref, legacyContentKey, context, Boolean(error?.staleUrl || directUrl)));
      return error?.staleUrl || directUrl;
    });
  }
  if (directUrl) {
    return directUrl;
  }
  return legacyContentKey ? getContentDownloadUrl(legacyContentKey) : "";
}

function formatDiscordImageRefreshError(error, ref, legacyContentKey = "", context = "", hasFallback = false) {
  const fileName = ref?.fileName || String(legacyContentKey || "").split("/").pop() || "image.png";
  const usage = imageContextLabel(context);
  const caller = imageContextCaller(context);
  const source = String(legacyContentKey || ref?.messageId || "Discord storage").trim();
  const fallbackText = hasFallback ? " Continuing with cached/saved image URL." : " Continuing without blocking the bot.";
  const message = String(error?.message || error || "");
  if (message.toLowerCase().includes("rate limited")) {
    return `Discord image URL refresh limited | time=${new Date().toISOString()} | image=${fileName} | use=${usage} | calledBy=${caller || "unknown"} | source=${source} | message=Your Discord API call failed because you are rate limited.${fallbackText}`;
  }
  return `Discord image URL refresh failed | time=${new Date().toISOString()} | image=${fileName} | use=${usage} | calledBy=${caller || "unknown"} | source=${source} | message=${message || "Unknown Discord error"}.${fallbackText}`;
}

async function getContentDownloadUrl(contentKey) {
  if (!contentKey) {
    return "";
  }
  if (/^https?:\/\//i.test(contentKey)) {
    return contentKey;
  }

  const sessionTicket = await loginDiscordUser("content-reader");
  const result = await callClientWithSession("GetContentDownloadUrl", sessionTicket, {
    Key: contentKey,
    ThruCDN: true
  });
  return result.URL || "";
}

async function saveContentImage({ currentUrl, currentRef, legacyContentKey, dataUrl, sourceUrl, keyForExtension, forceRehost = false }) {
  const url = String(sourceUrl || currentUrl || "").trim();
  if (!dataUrl && /^https?:\/\//i.test(url)) {
    if (forceRehost || (!currentRef && isDiscordHostedImageUrl(url))) {
      const contentKey = keyForExtension(extensionFromContentType(""));
      const fileName = contentKey.split("/").pop() || "image.png";
      const uploaded = await uploadDiscordImageFromUrl(url, fileName).catch((error) => {
        console.warn(`Could not rehost image URL; keeping existing URL. | time=${new Date().toISOString()} | image=${fileName} | message=${error.message}`);
        return null;
      });
      if (uploaded?.url) {
        return uploaded;
      }
    }
    return { url, ref: currentRef || null };
  }
  if (!dataUrl && legacyContentKey) {
    return { url: await getContentDownloadUrl(legacyContentKey), ref: currentRef || null };
  }

  const image = await imageSourceToBuffer({ dataUrl, sourceUrl: url });
  if (!image) {
    return { url: "", ref: null };
  }

  const contentKey = keyForExtension(image.extension);
  return uploadContentBuffer(contentKey, image);
}

async function saveFishRaidBossImages(bosses) {
  const bannerKeys = ["registration", "running", "result", "fulfilled", "failed"];
  const savedBosses = [];
  for (const boss of bosses) {
    const savedBoss = { ...boss };
    for (const bannerKey of bannerKeys) {
      const baseKey = `${bannerKey}Banner`;
      const banner = await saveContentImage({
        currentUrl: boss[`${baseKey}Url`],
        currentRef: boss[`${baseKey}Ref`],
        dataUrl: boss[`${baseKey}Base64`],
        sourceUrl: boss[`${baseKey}Url`],
        keyForExtension: (extension) => fishRaidBossContentKeyFor(boss.id, baseKey, extension),
        forceRehost: boss[`${baseKey}UrlNeedsRehost`] === true
      });
      savedBoss[`${baseKey}Url`] = banner.url;
      savedBoss[`${baseKey}Ref`] = banner.ref;
      savedBoss[`${baseKey}Base64`] = "";
    }
    savedBosses.push(savedBoss);
  }
  return savedBosses;
}

async function loadTitleAsset(key, useSecretKey = false) {
  const result = await callPlayFab(useSecretKey ? "Server" : "Client", "GetTitleData", { Keys: [key] }, useSecretKey);
  const manifest = parseAssetManifest(result.Data?.[key] || "");
  if (!manifest) {
    return "";
  }

  if (manifest.type === "inline") {
    return manifest.value;
  }

  const chunkKeys = Array.from({ length: manifest.chunks }, (_, index) => chunkKeyFor(manifest.key, index));
  const chunkResult = await callPlayFab(useSecretKey ? "Server" : "Client", "GetTitleData", { Keys: chunkKeys }, useSecretKey);
  return chunkKeys.map((chunkKey) => chunkResult.Data?.[chunkKey] || "").join("");
}

async function loadAssetRef(ref, fallbackKey, useSecretKey = false) {
  if (ref && ref.storage === "title_data_chunks" && ref.key) {
    return loadTitleAsset(ref.key, useSecretKey);
  }

  return fallbackKey ? loadTitleAsset(fallbackKey, useSecretKey) : "";
}

function stripImageRehostFlags(value) {
  if (Array.isArray(value)) {
    return value.map(stripImageRehostFlags);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "iconNeedsRehost" && !key.endsWith("NeedsRehost"))
    .map(([key, entry]) => [key, stripImageRehostFlags(entry)]));
}

function preferDiscordMessageReferences(value) {
  if (Array.isArray(value)) {
    return value.map(preferDiscordMessageReferences);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = preferDiscordMessageReferences(child);
  }
  for (const [key, child] of Object.entries(result)) {
    if (!key.endsWith("Ref") || !child?.messageUrl) {
      continue;
    }
    const baseKey = key.slice(0, -3);
    result[`${baseKey}MessageUrl`] = String(child.messageUrl);
    if (`${baseKey}Url` in result) {
      result[`${baseKey}Url`] = "";
    }
  }
  return result;
}

function withoutConfigAssets(config) {
  const settings = cleanSettings(config.settings);
  const activeEvent = cleanEvent(config.activeEvent);
  const events = cleanEvents(config.events, activeEvent);
  const routineMessages = cleanRoutineMessages(config.routineMessages);

  return stripImageRehostFlags({
    adminDiscordIds: cleanAdminDiscordIds(config.adminDiscordIds),
    settings: {
      ...settings,
      rodStoreImageBase64: "",
      rodStoreImageContentKey: "",
      fishCompBannerBase64: "",
      fishCompBannerContentKey: "",
      fishCompRegistrationBannerBase64: "",
      fishCompRunningBannerBase64: "",
      fishCompResultBannerBase64: "",
      fishRaidBannerBase64: "",
      fishRaidRegistrationBannerBase64: "",
      fishRaidRunningBannerBase64: "",
      fishRaidResultBannerBase64: "",
      fishDuelRegistrationBannerBase64: "",
      fishDuelRunningBannerBase64: "",
      fishDuelResultBannerBase64: "",
      fishGuideBannerBase64: "",
      fishHelpBannerBase64: "",
      sellFishBannerBase64: "",
      fishRaidBosses: settings.fishRaidBosses.map((boss) => ({
        ...boss,
        registrationBannerBase64: "",
        runningBannerBase64: "",
        resultBannerBase64: "",
        fulfilledBannerBase64: "",
        failedBannerBase64: ""
      }))
    },
    activeEvent: activeEvent
      ? {
        ...activeEvent,
        bannerBase64: "",
        bannerContentKey: ""
      }
      : null,
    events: events.map((event) => ({
      ...event,
      bannerBase64: "",
      bannerContentKey: ""
    })),
    routineMessages: routineMessages.map((routine) => ({
      ...routine,
      bannerBase64: "",
      bannerContentKey: ""
    }))
  });
}

function withImageCaller(context, caller) {
  return typeof context === "string" ? { type: context, caller } : { ...(context || {}), caller };
}

async function attachConfigAssets(config, useSecretKey = false, caller = "") {
  const settings = cleanSettings(config.settings);
  const activeEvent = cleanEvent(config.activeEvent);
  const events = cleanEvents(config.events, activeEvent);
  const routineMessages = cleanRoutineMessages(config.routineMessages);
  const fishRaidBosses = await Promise.all(settings.fishRaidBosses.map(async (boss) => ({
    ...boss,
    registrationBannerBase64: "",
    registrationBannerUrl: await getStoredImageUrl(boss.registrationBannerRef, boss.registrationBannerUrl, "", withImageCaller({ type: "fish raid boss registration banner", name: boss.name || boss.id }, caller)),
    runningBannerBase64: "",
    runningBannerUrl: await getStoredImageUrl(boss.runningBannerRef, boss.runningBannerUrl, "", withImageCaller({ type: "fish raid boss running banner", name: boss.name || boss.id }, caller)),
    resultBannerBase64: "",
    resultBannerUrl: await getStoredImageUrl(boss.resultBannerRef, boss.resultBannerUrl, "", withImageCaller({ type: "fish raid boss result banner", name: boss.name || boss.id }, caller)),
    fulfilledBannerBase64: "",
    fulfilledBannerUrl: await getStoredImageUrl(boss.fulfilledBannerRef, boss.fulfilledBannerUrl, "", withImageCaller({ type: "fish raid boss fulfilled banner", name: boss.name || boss.id }, caller)),
    failedBannerBase64: "",
    failedBannerUrl: await getStoredImageUrl(boss.failedBannerRef, boss.failedBannerUrl, "", withImageCaller({ type: "fish raid boss failed banner", name: boss.name || boss.id }, caller))
  })));

  return {
    adminDiscordIds: cleanAdminDiscordIds(config.adminDiscordIds),
    settings: {
      ...settings,
      rodStoreImageBase64: "",
      rodStoreImageUrl: await getStoredImageUrl(settings.rodStoreImageRef, settings.rodStoreImageUrl, settings.rodStoreImageContentKey, withImageCaller("rod store image", caller)),
      fishCompBannerBase64: "",
      fishCompBannerUrl: await getStoredImageUrl(settings.fishCompBannerRef, settings.fishCompBannerUrl, settings.fishCompBannerContentKey, withImageCaller("fish comp banner", caller)),
      fishCompRegistrationBannerBase64: "",
      fishCompRegistrationBannerUrl: await getStoredImageUrl(settings.fishCompRegistrationBannerRef, settings.fishCompRegistrationBannerUrl, "", withImageCaller("fish comp registration banner", caller)),
      fishCompRunningBannerBase64: "",
      fishCompRunningBannerUrl: await getStoredImageUrl(settings.fishCompRunningBannerRef, settings.fishCompRunningBannerUrl, "", withImageCaller("fish comp running banner", caller)),
      fishCompResultBannerBase64: "",
      fishCompResultBannerUrl: await getStoredImageUrl(settings.fishCompResultBannerRef, settings.fishCompResultBannerUrl, "", withImageCaller("fish comp result banner", caller)),
      fishRaidBannerBase64: "",
      fishRaidBannerUrl: await getStoredImageUrl(settings.fishRaidBannerRef, settings.fishRaidBannerUrl, "", withImageCaller("fish raid banner", caller)),
      fishRaidRegistrationBannerBase64: "",
      fishRaidRegistrationBannerUrl: await getStoredImageUrl(settings.fishRaidRegistrationBannerRef, settings.fishRaidRegistrationBannerUrl, "", withImageCaller("fish raid registration banner", caller)),
      fishRaidRunningBannerBase64: "",
      fishRaidRunningBannerUrl: await getStoredImageUrl(settings.fishRaidRunningBannerRef, settings.fishRaidRunningBannerUrl, "", withImageCaller("fish raid running banner", caller)),
      fishRaidResultBannerBase64: "",
      fishRaidResultBannerUrl: await getStoredImageUrl(settings.fishRaidResultBannerRef, settings.fishRaidResultBannerUrl, "", withImageCaller("fish raid result banner", caller)),
      fishDuelRegistrationBannerBase64: "",
      fishDuelRegistrationBannerUrl: await getStoredImageUrl(settings.fishDuelRegistrationBannerRef, settings.fishDuelRegistrationBannerUrl, "", withImageCaller("fish duel registration banner", caller)),
      fishDuelRunningBannerBase64: "",
      fishDuelRunningBannerUrl: await getStoredImageUrl(settings.fishDuelRunningBannerRef, settings.fishDuelRunningBannerUrl, "", withImageCaller("fish duel running banner", caller)),
      fishDuelResultBannerBase64: "",
      fishDuelResultBannerUrl: await getStoredImageUrl(settings.fishDuelResultBannerRef, settings.fishDuelResultBannerUrl, "", withImageCaller("fish duel result banner", caller)),
      fishGuideBannerBase64: "",
      fishGuideBannerUrl: await getStoredImageUrl(settings.fishGuideBannerRef, settings.fishGuideBannerUrl, "", withImageCaller("fish guide banner", caller)),
      fishHelpBannerBase64: "",
      fishHelpBannerUrl: await getStoredImageUrl(settings.fishHelpBannerRef, settings.fishHelpBannerUrl, "", withImageCaller("fish help banner", caller)),
      sellFishBannerBase64: "",
      sellFishBannerUrl: await getStoredImageUrl(settings.sellFishBannerRef, settings.sellFishBannerUrl, "", withImageCaller("sell fish banner", caller)),
      fishRaidBosses
    },
    activeEvent: activeEvent
      ? {
        ...activeEvent,
        bannerBase64: "",
        bannerUrl: await getStoredImageUrl(activeEvent.bannerRef, activeEvent.bannerUrl, activeEvent.bannerContentKey, withImageCaller({ type: "active event banner", name: activeEvent.title || activeEvent.id }, caller))
      }
      : null,
    events: await Promise.all(events.map(async (event) => ({
      ...event,
      bannerBase64: "",
      bannerUrl: await getStoredImageUrl(event.bannerRef, event.bannerUrl, event.bannerContentKey, withImageCaller({ type: "event banner", name: event.title || event.id }, caller))
    }))),
    routineMessages: await Promise.all(routineMessages.map(async (routine) => ({
      ...routine,
      bannerBase64: "",
      bannerUrl: await getStoredImageUrl(routine.bannerRef, routine.bannerUrl, routine.bannerContentKey, withImageCaller({ type: "routine message banner", name: routine.name || routine.title || routine.id }, caller))
    })))
  };
}

function withoutIcons(items, type) {
  return items.map((item) => {
    const { iconBase64, iconContentKey, iconKey, iconNeedsRehost, ...rest } = item;
    return stripImageRehostFlags(rest);
  });
}

async function attachIcons(items, type, useSecretKey = false, caller = "") {
  return Promise.all(items.map(async (item) => {
    const iconContentKey = item.iconContentKey || "";
    const iconUrl = String(item.iconUrl || "").trim();
    return {
      ...item,
      iconBase64: "",
      iconUrl: await getStoredImageUrl(item.iconRef, iconUrl, iconContentKey, withImageCaller({ type: `${type} icon`, name: item.name || item.id }, caller))
    };
  }));
}

async function loadJsonAsset(key, fallback, useSecretKey = true) {
  const value = await loadTitleAsset(key, useSecretKey);
  if (!value) {
    return { exists: false, value: fallback };
  }
  try {
    return { exists: true, value: JSON.parse(value) };
  } catch (error) {
    throw new Error(`PlayFab data ${key} is not valid JSON; refusing to replace it: ${error.message}`);
  }
}

async function loadLegacyConfig(useSecretKey = true) {
  const loaded = await loadJsonAsset(titleDataKeys.config, {}, useSecretKey);
  return loaded.value && typeof loaded.value === "object" && !Array.isArray(loaded.value) ? loaded.value : {};
}

async function loadConfigSections(useSecretKey = true, requestedSections = ["admins", "settings", "events", "routines", "routineState"]) {
  const legacy = await loadLegacyConfig(useSecretKey);
  const requested = new Set(requestedSections);
  const result = {
    adminDiscordIds: legacy.adminDiscordIds || [],
    settings: legacy.settings || {},
    activeEvent: legacy.activeEvent || null,
    events: legacy.events || [],
    routineMessages: legacy.routineMessages || [],
    routineState: {}
  };

  if (requested.has("admins")) {
    const loaded = await loadJsonAsset(titleDataKeys.admins, result.adminDiscordIds, useSecretKey);
    if (loaded.exists) result.adminDiscordIds = Array.isArray(loaded.value) ? loaded.value : [];
  }
  if (requested.has("settings")) {
    const loaded = await loadJsonAsset(titleDataKeys.settings, result.settings, useSecretKey);
    if (loaded.exists) result.settings = loaded.value && typeof loaded.value === "object" && !Array.isArray(loaded.value) ? loaded.value : {};
  }
  if (requested.has("events")) {
    const loaded = await loadJsonAsset(titleDataKeys.events, null, useSecretKey);
    if (loaded.exists) {
      result.activeEvent = loaded.value?.activeEvent || null;
      result.events = Array.isArray(loaded.value?.events) ? loaded.value.events : [];
    }
  }
  if (requested.has("routines")) {
    const loaded = await loadJsonAsset(titleDataKeys.routines, null, useSecretKey);
    if (loaded.exists) {
      result.routineMessages = Array.isArray(loaded.value?.routineMessages)
        ? loaded.value.routineMessages
        : Array.isArray(loaded.value) ? loaded.value : [];
    }
  }
  if (requested.has("routineState")) {
    const loaded = await loadJsonAsset(titleDataKeys.routineState, {}, useSecretKey);
    if (loaded.exists && loaded.value && typeof loaded.value === "object" && !Array.isArray(loaded.value)) {
      result.routineState = loaded.value;
    }
  }
  return result;
}

function applyRoutineRuntimeState(routines, runtimeState) {
  return cleanRoutineMessages(routines).map((routine) => {
    const saved = runtimeState?.[routine.id];
    return saved && typeof saved === "object" ? {
      ...routine,
      lastSentAt: String(saved.lastSentAt || routine.lastSentAt || ""),
      lastTriggerKey: String(saved.lastTriggerKey || routine.lastTriggerKey || ""),
      lastSentByGuild: saved.lastSentByGuild && typeof saved.lastSentByGuild === "object"
        ? saved.lastSentByGuild
        : routine.lastSentByGuild
    } : routine;
  });
}

async function ensureLegacyConfigBackup() {
  const existing = await loadTitleAsset(titleDataKeys.legacyConfigBackup, true);
  if (existing) return;
  const legacy = await loadTitleAsset(titleDataKeys.config, true);
  if (legacy) await saveTitleAsset(titleDataKeys.legacyConfigBackup, legacy);
}

function logGameDataLoad(caller, result) {
  const source = String(caller || "unknown process").trim();
  console.log(`Loaded ${result.fish.length} fish, ${result.rods.length} rods, ${result.fishBags.length} fish bags, and ${result.adminDiscordIds.length} admin IDs from PlayFab. | time=${new Date().toISOString()} | requestedBy=${source}`);
}

async function getGameData(options = {}) {
  const fish = parseList(await loadTitleAsset(titleDataKeys.fish, true), defaultFish);
  const rods = parseList(await loadTitleAsset(titleDataKeys.rods, true), defaultRods);
  const fishBags = parseList(await loadTitleAsset(titleDataKeys.fishBags, true), defaultFishBags, { fallbackWhenEmpty: true });
  const config = await loadConfigSections(true);
  config.routineMessages = applyRoutineRuntimeState(config.routineMessages, config.routineState);
  const caller = options.caller || "bot runtime";
  const configWithAssets = await attachConfigAssets(config, true, caller);

  const gameData = {
    fish: await attachIcons(fish, "fish", true, caller),
    rods: await attachIcons(rods, "rod", true, caller),
    fishBags: await attachIcons(fishBags, "fish-bag", true, caller),
    adminDiscordIds: configWithAssets.adminDiscordIds,
    settings: configWithAssets.settings,
    activeEvent: configWithAssets.activeEvent,
    events: configWithAssets.events,
    routineMessages: configWithAssets.routineMessages
  };
  logGameDataLoad(caller, gameData);
  return gameData;
}

async function adminGetGameData(options = {}) {
  const fish = parseList(await loadTitleAsset(titleDataKeys.fish, true), defaultFish);
  const rods = parseList(await loadTitleAsset(titleDataKeys.rods, true), defaultRods);
  const fishBags = parseList(await loadTitleAsset(titleDataKeys.fishBags, true), defaultFishBags, { fallbackWhenEmpty: true });
  const config = await loadConfigSections(true);
  const caller = options.caller || "manager api";
  const configWithAssets = await attachConfigAssets(config, true, caller);
  const gameData = {
    fish: await attachIcons(fish, "fish", true, caller),
    rods: await attachIcons(rods, "rod", true, caller),
    fishBags: await attachIcons(fishBags, "fish-bag", true, caller),
    adminDiscordIds: configWithAssets.adminDiscordIds,
    settings: configWithAssets.settings,
    activeEvent: configWithAssets.activeEvent,
    events: configWithAssets.events,
    routineMessages: configWithAssets.routineMessages
  };
  logGameDataLoad(caller, gameData);
  return gameData;
}

async function adminSaveGameData({ fish, rods, fishBags, adminDiscordIds, settings, activeEvent, events, routineMessages }) {
  const cleanFish = fish || [];
  const cleanRods = rods || [];
  const cleanFishBags = fishBags || [];
  assertUniqueItemIds(cleanFish, "fish");
  assertUniqueItemIds(cleanRods, "rod");
  assertUniqueItemIds(cleanFishBags, "fish bag");
  const cleanSettingsValue = cleanSettings(settings);
  const cleanEventValue = cleanEvent(activeEvent);
  const cleanEventsValue = cleanEvents(events, cleanEventValue);
  const cleanRoutineMessagesValue = cleanRoutineMessages(routineMessages);
  const rodStoreImage = await saveContentImage({
    currentUrl: cleanSettingsValue.rodStoreImageUrl,
    currentRef: cleanSettingsValue.rodStoreImageRef,
    legacyContentKey: cleanSettingsValue.rodStoreImageContentKey,
    dataUrl: cleanSettingsValue.rodStoreImageBase64,
    sourceUrl: cleanSettingsValue.rodStoreImageUrl,
    keyForExtension: storeContentKeyFor,
    forceRehost: cleanSettingsValue.rodStoreImageUrlNeedsRehost
  });
  const fishCompBanner = await saveContentImage({
    currentUrl: cleanSettingsValue.fishCompBannerUrl,
    currentRef: cleanSettingsValue.fishCompBannerRef,
    legacyContentKey: cleanSettingsValue.fishCompBannerContentKey,
    dataUrl: cleanSettingsValue.fishCompBannerBase64,
    sourceUrl: cleanSettingsValue.fishCompBannerUrl,
    keyForExtension: fishCompBannerContentKeyFor,
    forceRehost: cleanSettingsValue.fishCompBannerUrlNeedsRehost
  });
  const fishCompRegistrationBanner = await saveContentImage({
    currentUrl: cleanSettingsValue.fishCompRegistrationBannerUrl,
    currentRef: cleanSettingsValue.fishCompRegistrationBannerRef,
    dataUrl: cleanSettingsValue.fishCompRegistrationBannerBase64,
    sourceUrl: cleanSettingsValue.fishCompRegistrationBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-comp-registration-banner", extension),
    forceRehost: cleanSettingsValue.fishCompRegistrationBannerUrlNeedsRehost
  });
  const fishCompRunningBanner = await saveContentImage({
    currentUrl: cleanSettingsValue.fishCompRunningBannerUrl,
    currentRef: cleanSettingsValue.fishCompRunningBannerRef,
    dataUrl: cleanSettingsValue.fishCompRunningBannerBase64,
    sourceUrl: cleanSettingsValue.fishCompRunningBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-comp-running-banner", extension),
    forceRehost: cleanSettingsValue.fishCompRunningBannerUrlNeedsRehost
  });
  const fishCompResultBanner = await saveContentImage({
    currentUrl: cleanSettingsValue.fishCompResultBannerUrl,
    currentRef: cleanSettingsValue.fishCompResultBannerRef,
    dataUrl: cleanSettingsValue.fishCompResultBannerBase64,
    sourceUrl: cleanSettingsValue.fishCompResultBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-comp-result-banner", extension),
    forceRehost: cleanSettingsValue.fishCompResultBannerUrlNeedsRehost
  });
  const fishRaidBanner = await saveContentImage({
    currentUrl: cleanSettingsValue.fishRaidBannerUrl,
    currentRef: cleanSettingsValue.fishRaidBannerRef,
    dataUrl: cleanSettingsValue.fishRaidBannerBase64,
    sourceUrl: cleanSettingsValue.fishRaidBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-raid-banner", extension),
    forceRehost: cleanSettingsValue.fishRaidBannerUrlNeedsRehost
  });
  const fishRaidRegistrationBanner = await saveContentImage({
    currentUrl: cleanSettingsValue.fishRaidRegistrationBannerUrl,
    currentRef: cleanSettingsValue.fishRaidRegistrationBannerRef,
    dataUrl: cleanSettingsValue.fishRaidRegistrationBannerBase64,
    sourceUrl: cleanSettingsValue.fishRaidRegistrationBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-raid-registration-banner", extension),
    forceRehost: cleanSettingsValue.fishRaidRegistrationBannerUrlNeedsRehost
  });
  const fishRaidRunningBanner = await saveContentImage({
    currentUrl: cleanSettingsValue.fishRaidRunningBannerUrl,
    currentRef: cleanSettingsValue.fishRaidRunningBannerRef,
    dataUrl: cleanSettingsValue.fishRaidRunningBannerBase64,
    sourceUrl: cleanSettingsValue.fishRaidRunningBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-raid-running-banner", extension),
    forceRehost: cleanSettingsValue.fishRaidRunningBannerUrlNeedsRehost
  });
  const fishRaidResultBanner = await saveContentImage({
    currentUrl: cleanSettingsValue.fishRaidResultBannerUrl,
    currentRef: cleanSettingsValue.fishRaidResultBannerRef,
    dataUrl: cleanSettingsValue.fishRaidResultBannerBase64,
    sourceUrl: cleanSettingsValue.fishRaidResultBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-raid-result-banner", extension),
    forceRehost: cleanSettingsValue.fishRaidResultBannerUrlNeedsRehost
  });
  const fishDuelRegistrationBanner = await saveContentImage({
    currentUrl: cleanSettingsValue.fishDuelRegistrationBannerUrl,
    currentRef: cleanSettingsValue.fishDuelRegistrationBannerRef,
    dataUrl: cleanSettingsValue.fishDuelRegistrationBannerBase64,
    sourceUrl: cleanSettingsValue.fishDuelRegistrationBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-duel-registration-banner", extension),
    forceRehost: cleanSettingsValue.fishDuelRegistrationBannerUrlNeedsRehost
  });
  const fishDuelRunningBanner = await saveContentImage({
    currentUrl: cleanSettingsValue.fishDuelRunningBannerUrl,
    currentRef: cleanSettingsValue.fishDuelRunningBannerRef,
    dataUrl: cleanSettingsValue.fishDuelRunningBannerBase64,
    sourceUrl: cleanSettingsValue.fishDuelRunningBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-duel-running-banner", extension),
    forceRehost: cleanSettingsValue.fishDuelRunningBannerUrlNeedsRehost
  });
  const fishDuelResultBanner = await saveContentImage({
    currentUrl: cleanSettingsValue.fishDuelResultBannerUrl,
    currentRef: cleanSettingsValue.fishDuelResultBannerRef,
    dataUrl: cleanSettingsValue.fishDuelResultBannerBase64,
    sourceUrl: cleanSettingsValue.fishDuelResultBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-duel-result-banner", extension),
    forceRehost: cleanSettingsValue.fishDuelResultBannerUrlNeedsRehost
  });
  const fishGuideBanner = await saveContentImage({
    currentUrl: cleanSettingsValue.fishGuideBannerUrl,
    currentRef: cleanSettingsValue.fishGuideBannerRef,
    dataUrl: cleanSettingsValue.fishGuideBannerBase64,
    sourceUrl: cleanSettingsValue.fishGuideBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-guide-banner", extension),
    forceRehost: cleanSettingsValue.fishGuideBannerUrlNeedsRehost
  });
  const fishHelpBanner = await saveContentImage({
    currentUrl: cleanSettingsValue.fishHelpBannerUrl,
    currentRef: cleanSettingsValue.fishHelpBannerRef,
    dataUrl: cleanSettingsValue.fishHelpBannerBase64,
    sourceUrl: cleanSettingsValue.fishHelpBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-help-banner", extension),
    forceRehost: cleanSettingsValue.fishHelpBannerUrlNeedsRehost
  });
  const sellFishBanner = await saveContentImage({
    currentUrl: cleanSettingsValue.sellFishBannerUrl,
    currentRef: cleanSettingsValue.sellFishBannerRef,
    dataUrl: cleanSettingsValue.sellFishBannerBase64,
    sourceUrl: cleanSettingsValue.sellFishBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("sell-fish-banner", extension),
    forceRehost: cleanSettingsValue.sellFishBannerUrlNeedsRehost
  });
  const eventBannerCache = new Map();
  async function saveEventBanner(event) {
    if (!event) {
      return { url: "", ref: null };
    }
    const cacheKey = String(event.id || "");
    if (cacheKey && eventBannerCache.has(cacheKey)) {
      return eventBannerCache.get(cacheKey);
    }
    const savedBanner = await saveContentImage({
      currentUrl: event.bannerUrl,
      currentRef: event.bannerRef,
      legacyContentKey: event.bannerContentKey,
      dataUrl: event.bannerBase64,
      sourceUrl: event.bannerUrl,
      keyForExtension: (extension) => eventContentKeyFor(event.id, extension),
      forceRehost: event.bannerUrlNeedsRehost
    });
    if (cacheKey) {
      eventBannerCache.set(cacheKey, savedBanner);
    }
    return savedBanner;
  }

  const banner = cleanEventValue ? await saveEventBanner(cleanEventValue) : { url: "", ref: null };
  const cleanEventsWithUrls = [];
  for (const event of cleanEventsValue) {
    const eventBanner = await saveEventBanner(event);
    cleanEventsWithUrls.push({
      ...event,
      bannerUrl: eventBanner.url,
      bannerRef: eventBanner.ref
    });
  }
  const cleanRoutineMessagesWithUrls = [];
  for (const routine of cleanRoutineMessagesValue) {
    const routineBanner = await saveContentImage({
      currentUrl: routine.bannerUrl,
      currentRef: routine.bannerRef,
      legacyContentKey: routine.bannerContentKey,
      dataUrl: routine.bannerBase64,
      sourceUrl: routine.bannerUrl,
      keyForExtension: (extension) => settingsImageContentKeyFor(`routine-message-${routine.id}-banner`, extension),
      forceRehost: routine.bannerUrlNeedsRehost
    });
    cleanRoutineMessagesWithUrls.push({
      ...routine,
      bannerUrl: routineBanner.url,
      bannerRef: routineBanner.ref
    });
  }
  const cleanFishWithUrls = [];
  for (const item of cleanFish) {
    const icon = await saveContentImage({
      currentUrl: item.iconUrl,
      currentRef: item.iconRef,
      legacyContentKey: item.iconContentKey,
      dataUrl: item.iconBase64,
      sourceUrl: item.iconUrl,
      keyForExtension: (extension) => iconContentKeyFor("fish", item.id, extension),
      forceRehost: item.iconNeedsRehost
    });
    cleanFishWithUrls.push({
      ...item,
      iconUrl: icon.url,
      iconRef: icon.ref
    });
  }
  const cleanRodsWithUrls = [];
  for (const item of cleanRods) {
    const icon = await saveContentImage({
      currentUrl: item.iconUrl,
      currentRef: item.iconRef,
      legacyContentKey: item.iconContentKey,
      dataUrl: item.iconBase64,
      sourceUrl: item.iconUrl,
      keyForExtension: (extension) => iconContentKeyFor("rod", item.id, extension),
      forceRehost: item.iconNeedsRehost
    });
    cleanRodsWithUrls.push({
      ...item,
      iconUrl: icon.url,
      iconRef: icon.ref
    });
  }
  const cleanFishBagsWithUrls = [];
  for (const item of cleanFishBags) {
    const icon = await saveContentImage({
      currentUrl: item.iconUrl,
      currentRef: item.iconRef,
      legacyContentKey: item.iconContentKey,
      dataUrl: item.iconBase64,
      sourceUrl: item.iconUrl,
      keyForExtension: (extension) => iconContentKeyFor("fish-bag", item.id, extension),
      forceRehost: item.iconNeedsRehost
    });
    cleanFishBagsWithUrls.push({
      ...item,
      iconUrl: icon.url,
      iconRef: icon.ref
    });
  }
  const fishRaidBosses = await saveFishRaidBossImages(cleanSettingsValue.fishRaidBosses);
  const cleanConfig = withoutConfigAssets({
    adminDiscordIds,
    settings: {
      ...cleanSettingsValue,
      rodStoreImageUrl: rodStoreImage.url,
      rodStoreImageRef: rodStoreImage.ref,
      fishCompBannerUrl: fishCompBanner.url,
      fishCompBannerRef: fishCompBanner.ref,
      fishCompRegistrationBannerUrl: fishCompRegistrationBanner.url,
      fishCompRegistrationBannerRef: fishCompRegistrationBanner.ref,
      fishCompRunningBannerUrl: fishCompRunningBanner.url,
      fishCompRunningBannerRef: fishCompRunningBanner.ref,
      fishCompResultBannerUrl: fishCompResultBanner.url,
      fishCompResultBannerRef: fishCompResultBanner.ref,
      fishRaidBannerUrl: fishRaidBanner.url,
      fishRaidBannerRef: fishRaidBanner.ref,
      fishRaidRegistrationBannerUrl: fishRaidRegistrationBanner.url,
      fishRaidRegistrationBannerRef: fishRaidRegistrationBanner.ref,
      fishRaidRunningBannerUrl: fishRaidRunningBanner.url,
      fishRaidRunningBannerRef: fishRaidRunningBanner.ref,
      fishRaidResultBannerUrl: fishRaidResultBanner.url,
      fishRaidResultBannerRef: fishRaidResultBanner.ref,
      fishDuelRegistrationBannerUrl: fishDuelRegistrationBanner.url,
      fishDuelRegistrationBannerRef: fishDuelRegistrationBanner.ref,
      fishDuelRunningBannerUrl: fishDuelRunningBanner.url,
      fishDuelRunningBannerRef: fishDuelRunningBanner.ref,
      fishDuelResultBannerUrl: fishDuelResultBanner.url,
      fishDuelResultBannerRef: fishDuelResultBanner.ref,
      fishRaidBosses,
      fishGuideBannerUrl: fishGuideBanner.url,
      fishGuideBannerRef: fishGuideBanner.ref,
      fishHelpBannerUrl: fishHelpBanner.url,
      fishHelpBannerRef: fishHelpBanner.ref,
      sellFishBannerUrl: sellFishBanner.url,
      sellFishBannerRef: sellFishBanner.ref
    },
    activeEvent: cleanEventValue
      ? {
        ...cleanEventValue,
        bannerUrl: banner.url,
        bannerRef: banner.ref
      }
      : null,
    events: cleanEventsWithUrls,
    routineMessages: cleanRoutineMessagesWithUrls
  });

  const storedFish = preferDiscordMessageReferences(withoutIcons(cleanFishWithUrls, "fish"));
  const storedRods = preferDiscordMessageReferences(withoutIcons(cleanRodsWithUrls, "rod"));
  const storedFishBags = preferDiscordMessageReferences(withoutIcons(cleanFishBagsWithUrls, "fish-bag"));
  const storedConfig = preferDiscordMessageReferences(cleanConfig);

  await saveTitleAsset(titleDataKeys.fish, JSON.stringify(storedFish));
  await saveTitleAsset(titleDataKeys.rods, JSON.stringify(storedRods));
  await saveTitleAsset(titleDataKeys.fishBags, JSON.stringify(storedFishBags));
  await saveTitleAsset(titleDataKeys.config, JSON.stringify(storedConfig));

  return {
    fish: storedFish,
    rods: storedRods,
    fishBags: storedFishBags,
    adminDiscordIds: storedConfig.adminDiscordIds,
    settings: storedConfig.settings,
    activeEvent: storedConfig.activeEvent,
    events: storedConfig.events,
    routineMessages: storedConfig.routineMessages
  };
}

async function saveItemSection(items, type, key) {
  const cleanItems = Array.isArray(items) ? items : [];
  assertUniqueItemIds(cleanItems, type);
  const withUrls = [];
  for (const item of cleanItems) {
    const icon = await saveContentImage({
      currentUrl: item.iconUrl,
      currentRef: item.iconRef,
      legacyContentKey: item.iconContentKey,
      dataUrl: item.iconBase64,
      sourceUrl: item.iconUrl,
      keyForExtension: (extension) => iconContentKeyFor(type, item.id, extension),
      forceRehost: item.iconNeedsRehost
    });
    withUrls.push({ ...item, iconUrl: icon.url, iconRef: icon.ref });
  }
  const stored = preferDiscordMessageReferences(withoutIcons(withUrls, type));
  await saveTitleAsset(key, JSON.stringify(stored));
  return stored;
}

async function saveSettingsSection(settings) {
  const clean = cleanSettings(settings);
  const imageDefinitions = [
    ["rodStoreImage", storeContentKeyFor, "rodStoreImageContentKey"],
    ["fishCompBanner", fishCompBannerContentKeyFor, "fishCompBannerContentKey"],
    ["fishCompRegistrationBanner", (extension) => settingsImageContentKeyFor("fish-comp-registration-banner", extension)],
    ["fishCompRunningBanner", (extension) => settingsImageContentKeyFor("fish-comp-running-banner", extension)],
    ["fishCompResultBanner", (extension) => settingsImageContentKeyFor("fish-comp-result-banner", extension)],
    ["fishRaidBanner", (extension) => settingsImageContentKeyFor("fish-raid-banner", extension)],
    ["fishRaidRegistrationBanner", (extension) => settingsImageContentKeyFor("fish-raid-registration-banner", extension)],
    ["fishRaidRunningBanner", (extension) => settingsImageContentKeyFor("fish-raid-running-banner", extension)],
    ["fishRaidResultBanner", (extension) => settingsImageContentKeyFor("fish-raid-result-banner", extension)],
    ["fishDuelRegistrationBanner", (extension) => settingsImageContentKeyFor("fish-duel-registration-banner", extension)],
    ["fishDuelRunningBanner", (extension) => settingsImageContentKeyFor("fish-duel-running-banner", extension)],
    ["fishDuelResultBanner", (extension) => settingsImageContentKeyFor("fish-duel-result-banner", extension)],
    ["fishGuideBanner", (extension) => settingsImageContentKeyFor("fish-guide-banner", extension)],
    ["fishHelpBanner", (extension) => settingsImageContentKeyFor("fish-help-banner", extension)],
    ["sellFishBanner", (extension) => settingsImageContentKeyFor("sell-fish-banner", extension)]
  ];
  const savedImages = {};
  for (const [baseKey, keyForExtension, legacyKey] of imageDefinitions) {
    savedImages[baseKey] = await saveContentImage({
      currentUrl: clean[`${baseKey}Url`],
      currentRef: clean[`${baseKey}Ref`],
      legacyContentKey: legacyKey ? clean[legacyKey] : "",
      dataUrl: clean[`${baseKey}Base64`],
      sourceUrl: clean[`${baseKey}Url`],
      keyForExtension,
      forceRehost: clean[`${baseKey}UrlNeedsRehost`]
    });
  }
  const settingsWithUrls = { ...clean, fishRaidBosses: await saveFishRaidBossImages(clean.fishRaidBosses) };
  for (const [baseKey] of imageDefinitions) {
    settingsWithUrls[`${baseKey}Url`] = savedImages[baseKey].url;
    settingsWithUrls[`${baseKey}Ref`] = savedImages[baseKey].ref;
  }
  const stored = preferDiscordMessageReferences(withoutConfigAssets({ settings: settingsWithUrls }).settings);
  await ensureLegacyConfigBackup();
  await saveTitleAsset(titleDataKeys.settings, JSON.stringify(stored));
  return stored;
}

async function saveEventSection(activeEvent, events) {
  const cleanActive = cleanEvent(activeEvent);
  const cleanList = cleanEvents(events, cleanActive);
  const cache = new Map();
  const saveBanner = async (event) => {
    if (!event) return { url: "", ref: null };
    const cacheKey = String(event.id || "");
    if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);
    const saved = await saveContentImage({
      currentUrl: event.bannerUrl,
      currentRef: event.bannerRef,
      legacyContentKey: event.bannerContentKey,
      dataUrl: event.bannerBase64,
      sourceUrl: event.bannerUrl,
      keyForExtension: (extension) => eventContentKeyFor(event.id, extension),
      forceRehost: event.bannerUrlNeedsRehost
    });
    if (cacheKey) cache.set(cacheKey, saved);
    return saved;
  };
  const activeBanner = await saveBanner(cleanActive);
  const storedEvents = [];
  for (const event of cleanList) {
    const banner = await saveBanner(event);
    storedEvents.push({ ...event, bannerBase64: "", bannerContentKey: "", bannerUrl: banner.url, bannerRef: banner.ref });
  }
  const storedActive = cleanActive
    ? { ...cleanActive, bannerBase64: "", bannerContentKey: "", bannerUrl: activeBanner.url, bannerRef: activeBanner.ref }
    : null;
  const stored = preferDiscordMessageReferences({ activeEvent: storedActive, events: storedEvents });
  await ensureLegacyConfigBackup();
  await saveTitleAsset(titleDataKeys.events, JSON.stringify(stored));
  return stored;
}

async function saveRoutineSection(routineMessages) {
  const storedRoutines = [];
  for (const routine of cleanRoutineMessages(routineMessages)) {
    const banner = await saveContentImage({
      currentUrl: routine.bannerUrl,
      currentRef: routine.bannerRef,
      legacyContentKey: routine.bannerContentKey,
      dataUrl: routine.bannerBase64,
      sourceUrl: routine.bannerUrl,
      keyForExtension: (extension) => settingsImageContentKeyFor(`routine-message-${routine.id}-banner`, extension),
      forceRehost: routine.bannerUrlNeedsRehost
    });
    storedRoutines.push({ ...routine, bannerBase64: "", bannerContentKey: "", bannerUrl: banner.url, bannerRef: banner.ref });
  }
  const stored = preferDiscordMessageReferences({ routineMessages: storedRoutines });
  await ensureLegacyConfigBackup();
  await saveTitleAsset(titleDataKeys.routines, JSON.stringify(stored));
  return stored.routineMessages;
}

async function adminSaveRoutineState(routineMessages) {
  const state = Object.fromEntries(cleanRoutineMessages(routineMessages).map((routine) => [routine.id, {
    lastSentAt: routine.lastSentAt || "",
    lastTriggerKey: routine.lastTriggerKey || "",
    lastSentByGuild: routine.lastSentByGuild || {}
  }]));
  await saveTitleAsset(titleDataKeys.routineState, JSON.stringify(state));
  return state;
}

async function adminSaveEventData(activeEvent, events) {
  return saveEventSection(activeEvent, events);
}

async function adminGetManagerTabData(tab, options = {}) {
  const caller = options.caller || `manager ${tab} tab`;
  if (tab === "fish") return { fish: await attachIcons(parseList(await loadTitleAsset(titleDataKeys.fish, true), defaultFish), "fish", true, caller) };
  if (tab === "rods") return { rods: await attachIcons(parseList(await loadTitleAsset(titleDataKeys.rods, true), defaultRods), "rod", true, caller) };
  if (tab === "fishBags") return { fishBags: await attachIcons(parseList(await loadTitleAsset(titleDataKeys.fishBags, true), defaultFishBags, { fallbackWhenEmpty: true }), "fish-bag", true, caller) };
  if (tab === "calc" || tab === "players") {
    const [fish, rods] = await Promise.all([
      attachIcons(parseList(await loadTitleAsset(titleDataKeys.fish, true), defaultFish), "fish", true, caller),
      tab === "calc" ? attachIcons(parseList(await loadTitleAsset(titleDataKeys.rods, true), defaultRods), "rod", true, caller) : Promise.resolve([])
    ]);
    return { fish, rods };
  }
  if (tab === "admin") {
    const config = await loadConfigSections(true, ["admins"]);
    return { adminDiscordIds: cleanAdminDiscordIds(config.adminDiscordIds) };
  }
  if (tab === "settings") {
    const config = await loadConfigSections(true, ["settings"]);
    return { settings: (await attachConfigAssets({ settings: config.settings }, true, caller)).settings };
  }
  if (tab === "event") {
    const config = await loadConfigSections(true, ["events"]);
    const attached = await attachConfigAssets({ activeEvent: config.activeEvent, events: config.events }, true, caller);
    return { activeEvent: attached.activeEvent, events: attached.events };
  }
  if (tab === "routine") {
    const config = await loadConfigSections(true, ["routines", "routineState"]);
    config.routineMessages = applyRoutineRuntimeState(config.routineMessages, config.routineState);
    const attached = await attachConfigAssets({ routineMessages: config.routineMessages }, true, caller);
    return { routineMessages: attached.routineMessages };
  }
  throw new Error(`Unknown manager tab: ${tab}`);
}

async function adminSaveManagerTabData(tab, data) {
  if (tab === "fish") return { fish: await saveItemSection(data.fish, "fish", titleDataKeys.fish) };
  if (tab === "rods") return { rods: await saveItemSection(data.rods, "rod", titleDataKeys.rods) };
  if (tab === "fishBags") return { fishBags: await saveItemSection(data.fishBags, "fish-bag", titleDataKeys.fishBags) };
  if (tab === "admin") {
    const adminDiscordIds = cleanAdminDiscordIds(data.adminDiscordIds);
    await ensureLegacyConfigBackup();
    await saveTitleAsset(titleDataKeys.admins, JSON.stringify(adminDiscordIds));
    return { adminDiscordIds };
  }
  if (tab === "settings") return { settings: await saveSettingsSection(data.settings) };
  if (tab === "event") return saveEventSection(data.activeEvent, data.events);
  if (tab === "routine") return { routineMessages: await saveRoutineSection(data.routineMessages) };
  throw new Error(`The ${tab} tab does not have editable data.`);
}

module.exports = {
  adminGetManagerTabData,
  adminGetGameData,
  adminDeletePlayer,
  adminGetPlayerRecord,
  adminListPlayers,
  adminResetPlayerData,
  adminSavePlayerData,
  adminSaveGameData,
  adminSaveManagerTabData,
  adminSaveEventData,
  adminSaveRoutineState,
  defaultSettings,
  getGameData,
  getPlayer,
  makeDefaultPlayer,
  savePlayer
};
