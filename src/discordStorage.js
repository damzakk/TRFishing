require("dotenv").config();

const fs = require("node:fs");
const pathModule = require("node:path");

const discordApiBaseUrl = "https://discord.com/api/v10";
const token = process.env.DISCORD_TOKEN;
const storageGuildId = process.env.DISCORD_STORAGE_GUILD_ID || "";
const storageGuildName = process.env.DISCORD_STORAGE_GUILD_NAME || "TR Fishing Test Server";
const storageChannelId = process.env.DISCORD_STORAGE_CHANNEL_ID || "";
const storageChannelName = process.env.DISCORD_STORAGE_CHANNEL_NAME || "storage";
const discordRequestTimeoutMs = 30_000;
const discordImageUrlCacheTtlMs = readPositiveInteger(process.env.DISCORD_IMAGE_URL_CACHE_MS, 5 * 60_000);
const discordImageRefreshConcurrency = readPositiveInteger(process.env.DISCORD_IMAGE_REFRESH_CONCURRENCY, 3);
const runtimeDirectory = pathModule.join(__dirname, "..", ".runtime");
const discordImageUrlCachePath = pathModule.join(runtimeDirectory, "discord-image-url-cache.json");
const discordImageUrlCache = new Map();
const discordImageRefreshInFlight = new Map();
const discordImageRefreshQueue = [];
const refreshStaleDiscordImageUrls = /^(1|true|yes)$/i.test(String(process.env.DISCORD_IMAGE_REFRESH_STALE || ""));
let activeDiscordImageRefreshes = 0;
let persistentCacheLoaded = false;
let persistentCacheSaveTimer = null;

function requireDiscordToken() {
  if (!token) {
    throw new Error("Missing DISCORD_TOKEN in .env.");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function discordImageRefCacheKey(ref) {
  return [
    ref.storage,
    ref.channelId,
    ref.messageId,
    ref.attachmentId || "",
    ref.fileName || ""
  ].map((part) => String(part)).join(":");
}

function loadPersistentDiscordImageCache() {
  if (persistentCacheLoaded) {
    return;
  }
  persistentCacheLoaded = true;
  try {
    if (!fs.existsSync(discordImageUrlCachePath)) {
      return;
    }
    const saved = JSON.parse(fs.readFileSync(discordImageUrlCachePath, "utf8"));
    const entries = saved && typeof saved === "object" && !Array.isArray(saved) ? saved.entries || saved : {};
    for (const [cacheKey, entry] of Object.entries(entries)) {
      if (!entry?.url) {
        continue;
      }
      discordImageUrlCache.set(cacheKey, {
        url: String(entry.url || ""),
        expiresAt: Math.max(0, Number(entry.expiresAt || 0)),
        savedAt: Math.max(0, Number(entry.savedAt || 0)),
        fileName: String(entry.fileName || "")
      });
    }
  } catch (error) {
    console.warn(`Discord image URL cache ignored | time=${new Date().toISOString()} | message=Could not read saved cache: ${error.message}`);
  }
}

function schedulePersistentDiscordImageCacheSave() {
  clearTimeout(persistentCacheSaveTimer);
  persistentCacheSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(runtimeDirectory, { recursive: true });
      const entries = {};
      for (const [cacheKey, entry] of discordImageUrlCache.entries()) {
        if (!entry?.url) {
          continue;
        }
        entries[cacheKey] = {
          url: entry.url,
          expiresAt: Math.max(0, Number(entry.expiresAt || 0)),
          savedAt: Math.max(0, Number(entry.savedAt || Date.now())),
          fileName: String(entry.fileName || "")
        };
      }
      fs.writeFileSync(discordImageUrlCachePath, JSON.stringify({ savedAt: new Date().toISOString(), entries }, null, 2));
    } catch (error) {
      console.warn(`Discord image URL cache save failed | time=${new Date().toISOString()} | message=${error.message}`);
    }
  }, 250);
}

function rememberDiscordImageUrl(cacheKey, ref, url) {
  if (!url) {
    return;
  }
  discordImageUrlCache.set(cacheKey, {
    url,
    expiresAt: Date.now() + discordImageUrlCacheTtlMs,
    savedAt: Date.now(),
    fileName: String(ref?.fileName || "")
  });
  schedulePersistentDiscordImageCacheSave();
}

function enqueueDiscordImageRefresh(work) {
  return new Promise((resolve, reject) => {
    discordImageRefreshQueue.push({ work, resolve, reject });
    drainDiscordImageRefreshQueue();
  });
}

function drainDiscordImageRefreshQueue() {
  while (activeDiscordImageRefreshes < discordImageRefreshConcurrency && discordImageRefreshQueue.length) {
    const task = discordImageRefreshQueue.shift();
    activeDiscordImageRefreshes += 1;

    Promise.resolve()
      .then(task.work)
      .then(task.resolve, task.reject)
      .finally(() => {
        activeDiscordImageRefreshes -= 1;
        drainDiscordImageRefreshQueue();
      });
  }
}

function refreshDiscordImageUrlInBackground(ref, cacheKey) {
  return enqueueDiscordImageRefresh(async () => {
    const url = await fetchDiscordImageUrl(ref);
    if (url) {
      rememberDiscordImageUrl(cacheKey, ref, url);
    }
    return url;
  }).catch((error) => {
    console.warn(`Discord image background refresh failed | time=${new Date().toISOString()} | image=${ref.fileName || "image.png"} | source=${ref.messageId || "Discord storage"} | message=${error.message}`);
  });
}

async function callDiscordApi(path, options = {}) {
  requireDiscordToken();

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), discordRequestTimeoutMs);
    let response;
    try {
      response = await fetch(`${discordApiBaseUrl}${path}`, {
        ...options,
        headers: {
          Authorization: `Bot ${token}`,
          ...(options.headers || {})
        },
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        throw new Error("Discord API request timed out.");
      }
      throw error;
    }
    clearTimeout(timeout);

    const payload = await response.json().catch(() => ({}));
    if (response.status === 429 && attempt < maxAttempts) {
      const retryAfterMs = Math.ceil(Number(payload.retry_after || 1) * 1000);
      await sleep(Math.max(1000, retryAfterMs));
      continue;
    }
    if (!response.ok) {
      const detail = payload.message || response.statusText || "Unknown Discord error";
      throw new Error(`Discord API failed: ${detail}`);
    }

    return payload;
  }

  throw new Error("Discord API failed after retrying.");
}

async function findStorageGuildId() {
  if (storageGuildId) {
    return storageGuildId;
  }

  const guilds = await callDiscordApi("/users/@me/guilds");
  const guild = guilds.find((entry) => entry.name === storageGuildName);
  if (!guild) {
    throw new Error(`Discord storage server "${storageGuildName}" was not found. Set DISCORD_STORAGE_GUILD_ID in .env.`);
  }

  return guild.id;
}

async function findStorageChannelId() {
  if (storageChannelId) {
    return storageChannelId;
  }

  const guildId = await findStorageGuildId();
  const channels = await callDiscordApi(`/guilds/${guildId}/channels`);
  const channel = channels.find((entry) => entry.name === storageChannelName && [0, 5, 15, 16].includes(entry.type));
  if (!channel) {
    throw new Error(`Discord storage channel "#${storageChannelName}" was not found. Set DISCORD_STORAGE_CHANNEL_ID in .env.`);
  }

  return channel.id;
}

function sanitizeFileName(fileName) {
  return String(fileName || "image.png")
    .replace(/[^a-z0-9._-]/gi, "-")
    .replace(/-+/g, "-")
    .slice(0, 96) || "image.png";
}

async function uploadDiscordImage({ buffer, contentType, fileName }) {
  const uploaded = await uploadDiscordImageWithRef({ buffer, contentType, fileName });
  return uploaded.url;
}

async function uploadDiscordImageWithRef({ buffer, contentType, fileName }) {
  const channelId = await findStorageChannelId();
  const formData = new FormData();
  const safeFileName = sanitizeFileName(fileName);

  formData.append("payload_json", JSON.stringify({
    content: `TR Fishing asset: ${safeFileName}`,
    allowed_mentions: { parse: [] }
  }));
  formData.append("files[0]", new Blob([buffer], { type: contentType }), safeFileName);

  const message = await callDiscordApi(`/channels/${channelId}/messages`, {
    method: "POST",
    body: formData
  });
  const attachmentUrl = message.attachments?.[0]?.url || "";
  if (!attachmentUrl) {
    throw new Error("Discord upload succeeded but did not return an attachment URL.");
  }

  return {
    url: attachmentUrl,
    ref: {
      storage: "discord_attachment",
      channelId,
      messageId: message.id || "",
      attachmentId: message.attachments?.[0]?.id || "",
      fileName: safeFileName,
      contentType
    }
  };
}

async function fetchDiscordImageUrl(ref) {
  const message = await callDiscordApi(`/channels/${ref.channelId}/messages/${ref.messageId}`);
  const attachment = (message.attachments || []).find((entry) => (
    String(entry.id || "") === String(ref.attachmentId || "")
    || String(entry.filename || "") === String(ref.fileName || "")
  )) || message.attachments?.[0];
  return attachment?.url || "";
}

async function getDiscordImageUrl(ref) {
  if (!ref || ref.storage !== "discord_attachment" || !ref.channelId || !ref.messageId) {
    return "";
  }
  loadPersistentDiscordImageCache();

  const cacheKey = discordImageRefCacheKey(ref);
  const cached = discordImageUrlCache.get(cacheKey);
  if (cached?.url && (!refreshStaleDiscordImageUrls || cached.expiresAt > Date.now())) {
    return cached.url;
  }
  if (cached?.url) {
    if (!discordImageRefreshInFlight.has(cacheKey)) {
      const refresh = Promise.resolve()
        .then(() => refreshDiscordImageUrlInBackground(ref, cacheKey))
        .finally(() => discordImageRefreshInFlight.delete(cacheKey));
      discordImageRefreshInFlight.set(cacheKey, refresh);
    }
    return cached.url;
  }

  const inFlight = discordImageRefreshInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const refresh = enqueueDiscordImageRefresh(async () => {
    const url = await fetchDiscordImageUrl(ref).catch((error) => {
      if (cached?.url) {
        error.staleUrl = cached.url;
      }
      throw error;
    });
    if (url) {
      rememberDiscordImageUrl(cacheKey, ref, url);
    }
    return url;
  }).finally(() => {
    discordImageRefreshInFlight.delete(cacheKey);
  });

  discordImageRefreshInFlight.set(cacheKey, refresh);
  return refresh;
}

module.exports = {
  getDiscordImageUrl,
  uploadDiscordImage,
  uploadDiscordImageWithRef
};
