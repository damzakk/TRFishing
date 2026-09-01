require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { defaultFish, defaultRods } = require("./defaultData");
const { uploadDiscordImage } = require("./discordStorage");

const titleId = process.env.PLAYFAB_TITLE_ID;
const secretKey = process.env.PLAYFAB_SECRET_KEY;
const legacyPlayersPath = path.join(__dirname, "..", "data", "players.json");

const titleDataKeys = {
  fish: "fish_config",
  rods: "rod_config",
  config: "admin_config",
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
  fishGuideBannerBase64: "",
  fishGuideBannerUrl: "",
  fishHelpBannerBase64: "",
  fishHelpBannerUrl: "",
  sellFishBannerBase64: "",
  sellFishBannerUrl: "",
  fishCompEvents: [
    {
      id: "slip_pool",
      name: "Terjatuh ke kolam",
      chance: 4,
      type: "stun",
      durationTurns: 2,
      luckModifier: 0,
      canFishOnStart: false,
      canFishWhileActive: false,
      canFishOnEnd: false,
      affectOther: true,
      affectOtherChance: 35,
      otherType: "stun",
      otherDurationTurns: 2,
      otherLuckModifier: 0,
      startText: "{user} tersandung dan terjatuh ke kolam.",
      activeText: "{user} masih berusaha keluar dari kolam.",
      endText: "{user} keluar dari kolam setelah terjatuh.",
      otherStartText: "{target} terjatuh ke kolam karena tersenggol {user}.",
      otherActiveText: "{target} masih basah kuyup di kolam.",
      otherEndText: "{target} akhirnya keluar dari kolam."
    },
    {
      id: "lucky_chant",
      name: "Teriakan semangat",
      chance: 6,
      type: "empty",
      durationTurns: 1,
      luckModifier: 0,
      canFishOnStart: true,
      canFishWhileActive: true,
      canFishOnEnd: true,
      affectOther: false,
      startText: "{user} berteriak sekuat tenaga."
    },
    {
      id: "golden_ripple",
      name: "Riak emas",
      chance: 3,
      type: "buff",
      durationTurns: 2,
      luckModifier: 3,
      canFishOnStart: true,
      canFishWhileActive: true,
      canFishOnEnd: true,
      affectOther: false,
      startText: "Air di dekat {user} berkilau emas.",
      activeText: "{user} masih dikelilingi riak emas.",
      endText: "Riak emas di sekitar {user} menghilang."
    },
    {
      id: "tangled_line",
      name: "Senar kusut",
      chance: 4,
      type: "debuff",
      durationTurns: 2,
      luckModifier: -3,
      canFishOnStart: true,
      canFishWhileActive: true,
      canFishOnEnd: true,
      affectOther: false,
      startText: "Senar pancing {user} tiba-tiba kusut.",
      activeText: "{user} masih memancing dengan senar yang kurang nyaman.",
      endText: "Senar pancing {user} akhirnya rapi lagi."
    }
  ],
  fishCompLogIntervalMs: 2500,
  fishCompExpReward: 50,
  fishCompGoldReward: 0,
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
    inventory: {},
    totalFishCaught: 0,
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
  const inventory = rawPlayer?.inventory && typeof rawPlayer.inventory === "object" ? rawPlayer.inventory : {};
  const totalFromInventory = Object.values(inventory).reduce((sum, quantity) => sum + Math.max(0, Number(quantity || 0)), 0);
  const heaviestFish = rawPlayer?.heaviestFish && typeof rawPlayer.heaviestFish === "object"
    ? rawPlayer.heaviestFish
    : null;
  const luckiestFish = rawPlayer?.luckiestFish && typeof rawPlayer.luckiestFish === "object"
    ? rawPlayer.luckiestFish
    : null;
  return {
    ...makeDefaultPlayer(),
    ...(rawPlayer && typeof rawPlayer === "object" ? rawPlayer : {}),
    inventory,
    totalFishCaught: Math.max(0, Number(rawPlayer?.totalFishCaught ?? totalFromInventory)),
    heaviestFish,
    luckiestFish,
    voiceTotalMs: Math.max(0, Number(rawPlayer?.voiceTotalMs || 0)),
    voiceExpRemainderMs: Math.max(0, Number(rawPlayer?.voiceExpRemainderMs || 0)),
    rodId: rawPlayer?.rodId === "twig" ? starterRodId : rawPlayer?.rodId || starterRodId,
    ownedRods: ownedRods.map((rodId) => (rodId === "twig" ? starterRodId : rodId))
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

async function adminListPlayers(search = "") {
  const query = String(search || "").trim().toLowerCase();
  const directDiscordId = /^\d{12,}$/.test(query) ? await adminGetPlayerByDiscordId(query) : null;
  let profiles = [];
  try {
    profiles = await adminListPlayerProfiles();
  } catch (error) {
    console.warn(`Could not list PlayFab player segment, using player index fallback: ${error.message}`);
  }
  const indexedPlayers = profiles.length ? [] : await loadPlayerIndex();
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
  for (const playFabId of playFabIds) {
    try {
      records.push(await adminGetPlayerRecord(playFabId));
    } catch (error) {
      console.error(`Could not load player ${playFabId}:`, error);
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

async function adminSavePlayerData(playFabId, player) {
  const normalizedPlayer = normalizePlayer(player);
  await callPlayFab("Admin", "UpdateUserData", {
    PlayFabId: playFabId,
    Data: {
      player: JSON.stringify(normalizedPlayer)
    }
  }, true);
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

function parseList(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
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

function cleanSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const rodStoreImageUrl = String(source.rodStoreImageUrl || "").trim();
  const fishCompBannerUrl = String(source.fishCompBannerUrl || "").trim();
  const fishCompRegistrationBannerUrl = String(source.fishCompRegistrationBannerUrl || "").trim();
  const fishCompRunningBannerUrl = String(source.fishCompRunningBannerUrl || "").trim();
  const fishCompResultBannerUrl = String(source.fishCompResultBannerUrl || "").trim();
  const fishGuideBannerUrl = String(source.fishGuideBannerUrl || "").trim();
  const fishHelpBannerUrl = String(source.fishHelpBannerUrl || "").trim();
  const sellFishBannerUrl = String(source.sellFishBannerUrl || "").trim();
  return {
    rodStoreImageBase64: String(source.rodStoreImageBase64 || ""),
    rodStoreImageUrl,
    rodStoreImageContentKey: String(source.rodStoreImageContentKey || "").trim(),
    rodStoreImageRef: source.rodStoreImageRef && typeof source.rodStoreImageRef === "object" ? source.rodStoreImageRef : null,
    fishCompBannerBase64: String(source.fishCompBannerBase64 || ""),
    fishCompBannerUrl,
    fishCompBannerContentKey: String(source.fishCompBannerContentKey || "").trim(),
    fishCompBannerRef: source.fishCompBannerRef && typeof source.fishCompBannerRef === "object" ? source.fishCompBannerRef : null,
    fishCompRegistrationBannerBase64: String(source.fishCompRegistrationBannerBase64 || ""),
    fishCompRegistrationBannerUrl,
    fishCompRunningBannerBase64: String(source.fishCompRunningBannerBase64 || ""),
    fishCompRunningBannerUrl,
    fishCompResultBannerBase64: String(source.fishCompResultBannerBase64 || ""),
    fishCompResultBannerUrl,
    fishGuideBannerBase64: String(source.fishGuideBannerBase64 || ""),
    fishGuideBannerUrl,
    fishHelpBannerBase64: String(source.fishHelpBannerBase64 || ""),
    fishHelpBannerUrl,
    sellFishBannerBase64: String(source.sellFishBannerBase64 || ""),
    sellFishBannerUrl,
    fishCompEvents: cleanFishCompEvents(source.fishCompEvents),
    fishCompLogIntervalMs: Math.max(0, cleanNumber(source.fishCompLogIntervalMs ?? defaultSettings.fishCompLogIntervalMs, defaultSettings.fishCompLogIntervalMs)),
    fishCompExpReward: Math.max(0, cleanNumber(source.fishCompExpReward ?? defaultSettings.fishCompExpReward, defaultSettings.fishCompExpReward)),
    fishCompGoldReward: Math.max(0, cleanNumber(source.fishCompGoldReward ?? defaultSettings.fishCompGoldReward, defaultSettings.fishCompGoldReward)),
    chatCooldownMs: Math.max(0, Number(source.chatCooldownMs ?? defaultSettings.chatCooldownMs) || defaultSettings.chatCooldownMs),
    expMultiplier: Math.max(0, Number(source.expMultiplier ?? defaultSettings.expMultiplier) || defaultSettings.expMultiplier),
    levelExpMultiplier: Math.max(0.01, Number(source.levelExpMultiplier ?? defaultSettings.levelExpMultiplier) || defaultSettings.levelExpMultiplier),
    voiceExpAmount: Math.max(0, cleanNumber(source.voiceExpAmount ?? defaultSettings.voiceExpAmount, defaultSettings.voiceExpAmount)),
    voiceExpIntervalMinutes: Math.max(1, cleanNumber(source.voiceExpIntervalMinutes ?? defaultSettings.voiceExpIntervalMinutes, defaultSettings.voiceExpIntervalMinutes))
  };
}

function cleanFishCompEvents(events) {
  return (Array.isArray(events) ? events : defaultSettings.fishCompEvents).map((event, index) => {
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

  const chunks = [];
  for (let index = 0; index < assetValue.length; index += titleDataChunkSize) {
    chunks.push(assetValue.slice(index, index + titleDataChunkSize));
  }

  for (const [index, chunk] of chunks.entries()) {
    await setTitleData(chunkKeyFor(key, index), chunk);
  }

  const manifest = {
    storage: "title_data_chunks",
    key,
    chunks: chunks.length
  };

  await setTitleData(key, JSON.stringify(manifest));

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
  return uploadDiscordImage({
    buffer: image.buffer,
    contentType: image.contentType,
    fileName: contentKey.split("/").pop() || `image.${image.extension}`
  });
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

async function saveContentImage({ currentUrl, legacyContentKey, dataUrl, sourceUrl, keyForExtension }) {
  const url = String(sourceUrl || currentUrl || "").trim();
  if (!dataUrl && /^https?:\/\//i.test(url)) {
    return url;
  }
  if (!dataUrl && legacyContentKey) {
    return getContentDownloadUrl(legacyContentKey);
  }

  const image = await imageSourceToBuffer({ dataUrl, sourceUrl: url });
  if (!image) {
    return "";
  }

  const contentKey = keyForExtension(image.extension);
  return uploadContentBuffer(contentKey, image);
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

function withoutConfigAssets(config) {
  const settings = cleanSettings(config.settings);
  const activeEvent = cleanEvent(config.activeEvent);
  const events = cleanEvents(config.events, activeEvent);

  return {
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
      fishGuideBannerBase64: "",
      fishHelpBannerBase64: "",
      sellFishBannerBase64: ""
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
    }))
  };
}

async function attachConfigAssets(config, useSecretKey = false) {
  const settings = cleanSettings(config.settings);
  const activeEvent = cleanEvent(config.activeEvent);
  const events = cleanEvents(config.events, activeEvent);

  return {
    adminDiscordIds: cleanAdminDiscordIds(config.adminDiscordIds),
    settings: {
      ...settings,
      rodStoreImageBase64: "",
      rodStoreImageUrl: settings.rodStoreImageUrl || (settings.rodStoreImageContentKey
        ? await getContentDownloadUrl(settings.rodStoreImageContentKey)
        : ""),
      fishCompBannerBase64: "",
      fishCompBannerUrl: settings.fishCompBannerUrl || (settings.fishCompBannerContentKey
        ? await getContentDownloadUrl(settings.fishCompBannerContentKey)
        : ""),
      fishCompRegistrationBannerBase64: "",
      fishCompRegistrationBannerUrl: settings.fishCompRegistrationBannerUrl,
      fishCompRunningBannerBase64: "",
      fishCompRunningBannerUrl: settings.fishCompRunningBannerUrl,
      fishCompResultBannerBase64: "",
      fishCompResultBannerUrl: settings.fishCompResultBannerUrl,
      fishGuideBannerBase64: "",
      fishGuideBannerUrl: settings.fishGuideBannerUrl,
      fishHelpBannerBase64: "",
      fishHelpBannerUrl: settings.fishHelpBannerUrl,
      sellFishBannerBase64: "",
      sellFishBannerUrl: settings.sellFishBannerUrl
    },
    activeEvent: activeEvent
      ? {
        ...activeEvent,
        bannerBase64: "",
        bannerUrl: activeEvent.bannerUrl || (activeEvent.bannerContentKey
          ? await getContentDownloadUrl(activeEvent.bannerContentKey)
          : "")
      }
      : null,
    events: await Promise.all(events.map(async (event) => ({
      ...event,
      bannerBase64: "",
      bannerUrl: event.bannerUrl || (event.bannerContentKey
        ? await getContentDownloadUrl(event.bannerContentKey)
        : "")
    })))
  };
}

function withoutIcons(items, type) {
  return items.map((item) => {
    const { iconBase64, iconContentKey, iconKey, ...rest } = item;
    return rest;
  });
}

async function attachIcons(items, type, useSecretKey = false) {
  return Promise.all(items.map(async (item) => {
    const iconContentKey = item.iconContentKey || "";
    const iconUrl = String(item.iconUrl || "").trim();
    return {
      ...item,
      iconBase64: "",
      iconUrl: iconUrl || (iconContentKey ? await getContentDownloadUrl(iconContentKey) : "")
    };
  }));
}

async function getGameData() {
  const result = await callPlayFab("Server", "GetTitleData", {
    Keys: [titleDataKeys.config]
  }, true);

  const fish = parseList(await loadTitleAsset(titleDataKeys.fish, true), defaultFish);
  const rods = parseList(await loadTitleAsset(titleDataKeys.rods, true), defaultRods);
  const config = parseConfig(parseAssetManifest(result.Data?.[titleDataKeys.config] || "")?.type === "inline"
    ? result.Data?.[titleDataKeys.config]
    : await loadTitleAsset(titleDataKeys.config, true), {});
  const configWithAssets = await attachConfigAssets(config, true);

  return {
    fish: await attachIcons(fish, "fish", true),
    rods: await attachIcons(rods, "rod", true),
    adminDiscordIds: configWithAssets.adminDiscordIds,
    settings: configWithAssets.settings,
    activeEvent: configWithAssets.activeEvent,
    events: configWithAssets.events
  };
}

async function adminGetGameData() {
  const result = await callPlayFab("Server", "GetTitleData", {
    Keys: [titleDataKeys.config]
  }, true);

  const fish = parseList(await loadTitleAsset(titleDataKeys.fish, true), defaultFish);
  const rods = parseList(await loadTitleAsset(titleDataKeys.rods, true), defaultRods);
  const config = parseConfig(parseAssetManifest(result.Data?.[titleDataKeys.config] || "")?.type === "inline"
    ? result.Data?.[titleDataKeys.config]
    : await loadTitleAsset(titleDataKeys.config, true), {});
  const configWithAssets = await attachConfigAssets(config, true);
  return {
    fish: await attachIcons(fish, "fish", true),
    rods: await attachIcons(rods, "rod", true),
    adminDiscordIds: configWithAssets.adminDiscordIds,
    settings: configWithAssets.settings,
    activeEvent: configWithAssets.activeEvent,
    events: configWithAssets.events
  };
}

async function adminSaveGameData({ fish, rods, adminDiscordIds, settings, activeEvent, events }) {
  const cleanFish = fish || [];
  const cleanRods = rods || [];
  assertUniqueItemIds(cleanFish, "fish");
  assertUniqueItemIds(cleanRods, "rod");
  const cleanSettingsValue = cleanSettings(settings);
  const cleanEventValue = cleanEvent(activeEvent);
  const cleanEventsValue = cleanEvents(events, cleanEventValue);
  const rodStoreImageUrl = await saveContentImage({
    currentUrl: cleanSettingsValue.rodStoreImageUrl,
    legacyContentKey: cleanSettingsValue.rodStoreImageContentKey,
    dataUrl: cleanSettingsValue.rodStoreImageBase64,
    sourceUrl: cleanSettingsValue.rodStoreImageUrl,
    keyForExtension: storeContentKeyFor
  });
  const fishCompBannerUrl = await saveContentImage({
    currentUrl: cleanSettingsValue.fishCompBannerUrl,
    legacyContentKey: cleanSettingsValue.fishCompBannerContentKey,
    dataUrl: cleanSettingsValue.fishCompBannerBase64,
    sourceUrl: cleanSettingsValue.fishCompBannerUrl,
    keyForExtension: fishCompBannerContentKeyFor
  });
  const fishCompRegistrationBannerUrl = await saveContentImage({
    currentUrl: cleanSettingsValue.fishCompRegistrationBannerUrl,
    dataUrl: cleanSettingsValue.fishCompRegistrationBannerBase64,
    sourceUrl: cleanSettingsValue.fishCompRegistrationBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-comp-registration-banner", extension)
  });
  const fishCompRunningBannerUrl = await saveContentImage({
    currentUrl: cleanSettingsValue.fishCompRunningBannerUrl,
    dataUrl: cleanSettingsValue.fishCompRunningBannerBase64,
    sourceUrl: cleanSettingsValue.fishCompRunningBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-comp-running-banner", extension)
  });
  const fishCompResultBannerUrl = await saveContentImage({
    currentUrl: cleanSettingsValue.fishCompResultBannerUrl,
    dataUrl: cleanSettingsValue.fishCompResultBannerBase64,
    sourceUrl: cleanSettingsValue.fishCompResultBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-comp-result-banner", extension)
  });
  const fishGuideBannerUrl = await saveContentImage({
    currentUrl: cleanSettingsValue.fishGuideBannerUrl,
    dataUrl: cleanSettingsValue.fishGuideBannerBase64,
    sourceUrl: cleanSettingsValue.fishGuideBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-guide-banner", extension)
  });
  const fishHelpBannerUrl = await saveContentImage({
    currentUrl: cleanSettingsValue.fishHelpBannerUrl,
    dataUrl: cleanSettingsValue.fishHelpBannerBase64,
    sourceUrl: cleanSettingsValue.fishHelpBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("fish-help-banner", extension)
  });
  const sellFishBannerUrl = await saveContentImage({
    currentUrl: cleanSettingsValue.sellFishBannerUrl,
    dataUrl: cleanSettingsValue.sellFishBannerBase64,
    sourceUrl: cleanSettingsValue.sellFishBannerUrl,
    keyForExtension: (extension) => settingsImageContentKeyFor("sell-fish-banner", extension)
  });
  const bannerUrl = cleanEventValue
    ? await saveContentImage({
      currentUrl: cleanEventValue.bannerUrl,
      legacyContentKey: cleanEventValue.bannerContentKey,
      dataUrl: cleanEventValue.bannerBase64,
      sourceUrl: cleanEventValue.bannerUrl,
      keyForExtension: (extension) => eventContentKeyFor(cleanEventValue.id, extension)
    })
    : "";
  const cleanEventsWithUrls = [];
  for (const event of cleanEventsValue) {
    cleanEventsWithUrls.push({
      ...event,
      bannerUrl: await saveContentImage({
        currentUrl: event.bannerUrl,
        legacyContentKey: event.bannerContentKey,
        dataUrl: event.bannerBase64,
        sourceUrl: event.bannerUrl,
        keyForExtension: (extension) => eventContentKeyFor(event.id, extension)
      })
    });
  }
  const cleanFishWithUrls = [];
  for (const item of cleanFish) {
    cleanFishWithUrls.push({
      ...item,
      iconUrl: await saveContentImage({
        currentUrl: item.iconUrl,
        legacyContentKey: item.iconContentKey,
        dataUrl: item.iconBase64,
        sourceUrl: item.iconUrl,
        keyForExtension: (extension) => iconContentKeyFor("fish", item.id, extension)
      })
    });
  }
  const cleanRodsWithUrls = [];
  for (const item of cleanRods) {
    cleanRodsWithUrls.push({
      ...item,
      iconUrl: await saveContentImage({
        currentUrl: item.iconUrl,
        legacyContentKey: item.iconContentKey,
        dataUrl: item.iconBase64,
        sourceUrl: item.iconUrl,
        keyForExtension: (extension) => iconContentKeyFor("rod", item.id, extension)
      })
    });
  }
  const cleanConfig = withoutConfigAssets({
    adminDiscordIds,
    settings: {
      ...cleanSettingsValue,
      rodStoreImageUrl,
      fishCompBannerUrl,
      fishCompRegistrationBannerUrl,
      fishCompRunningBannerUrl,
      fishCompResultBannerUrl,
      fishGuideBannerUrl,
      fishHelpBannerUrl,
      sellFishBannerUrl
    },
    activeEvent: cleanEventValue
      ? {
        ...cleanEventValue,
        bannerUrl
      }
      : null,
    events: cleanEventsWithUrls
  });

  await saveTitleAsset(titleDataKeys.fish, JSON.stringify(withoutIcons(cleanFishWithUrls, "fish")));
  await saveTitleAsset(titleDataKeys.rods, JSON.stringify(withoutIcons(cleanRodsWithUrls, "rod")));
  await saveTitleAsset(titleDataKeys.config, JSON.stringify(cleanConfig));

  return {
    fish: withoutIcons(cleanFishWithUrls, "fish"),
    rods: withoutIcons(cleanRodsWithUrls, "rod"),
    adminDiscordIds: cleanConfig.adminDiscordIds,
    settings: cleanConfig.settings,
    activeEvent: cleanConfig.activeEvent,
    events: cleanConfig.events
  };
}

module.exports = {
  adminGetGameData,
  adminDeletePlayer,
  adminGetPlayerRecord,
  adminListPlayers,
  adminResetPlayerData,
  adminSavePlayerData,
  adminSaveGameData,
  defaultSettings,
  getGameData,
  getPlayer,
  makeDefaultPlayer,
  savePlayer
};
