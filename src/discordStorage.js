require("dotenv").config();

const discordApiBaseUrl = "https://discord.com/api/v10";
const token = process.env.DISCORD_TOKEN;
const storageGuildId = process.env.DISCORD_STORAGE_GUILD_ID || "";
const storageGuildName = process.env.DISCORD_STORAGE_GUILD_NAME || "TR Fishing Test Server";
const storageChannelId = process.env.DISCORD_STORAGE_CHANNEL_ID || "";
const storageChannelName = process.env.DISCORD_STORAGE_CHANNEL_NAME || "storage";
const discordRequestTimeoutMs = 30_000;

function requireDiscordToken() {
  if (!token) {
    throw new Error("Missing DISCORD_TOKEN in .env.");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  return attachmentUrl;
}

module.exports = {
  uploadDiscordImage
};
