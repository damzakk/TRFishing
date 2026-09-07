const { AttachmentBuilder } = require("discord.js");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const runtimeDirectory = path.join(__dirname, "..", ".runtime");
const imageCacheDirectory = path.join(runtimeDirectory, "image-cache");
const imageCacheMetaPath = path.join(imageCacheDirectory, "meta.json");
const legacyImageCacheDirectory = path.join(runtimeDirectory, "manager-image-cache");
const legacyImageCacheIndexPath = path.join(legacyImageCacheDirectory, "index.json");

function ensureImageCacheDirectory() {
  fs.mkdirSync(imageCacheDirectory, { recursive: true });
}

function readImageCacheMeta() {
  try {
    if (!fs.existsSync(imageCacheMetaPath)) {
      return {};
    }
    const meta = JSON.parse(fs.readFileSync(imageCacheMetaPath, "utf8"));
    return meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
  } catch {
    return {};
  }
}

function writeImageCacheMeta(meta) {
  ensureImageCacheDirectory();
  fs.writeFileSync(imageCacheMetaPath, JSON.stringify(meta, null, 2));
}

function extensionFromContentType(contentType) {
  return {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp"
  }[String(contentType || "").split(";")[0].trim().toLowerCase()] || "png";
}

function contentTypeFromExtension(extension) {
  const selectedExtension = String(extension || "").toLowerCase().replace(/^\./, "");
  return {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp"
  }[selectedExtension] || "application/octet-stream";
}

function sanitizeFileNamePart(value, fallback = "image") {
  return String(value || fallback)
    .replace(/[^a-z0-9._-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || fallback;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function stableImageUrl(url) {
  const selectedUrl = String(url || "").trim();
  try {
    const parsed = new URL(selectedUrl);
    if (["cdn.discordapp.com", "media.discordapp.net"].includes(parsed.hostname.toLowerCase())) {
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
  } catch {
    return selectedUrl;
  }
  return selectedUrl;
}

function makeImageCacheKeyForUrl(url) {
  const selectedUrl = stableImageUrl(url);
  return selectedUrl ? sha256(`url|${selectedUrl}`) : "";
}

function makeImageCacheKeyForRef(ref) {
  if (!ref || typeof ref !== "object") {
    return "";
  }
  const messageUrl = String(ref.messageUrl || "").trim();
  const messageId = String(ref.messageId || "").trim();
  if (!messageUrl && !messageId) {
    return "";
  }
  return sha256([
    "discord-ref",
    messageUrl,
    ref.channelId || "",
    messageId
  ].join("|"));
}

function makeImageCacheKeyForItem(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  const ref = item.iconRef || (item.iconMessageUrl ? { messageUrl: item.iconMessageUrl } : null);
  if (ref?.storage && ref?.messageId) {
    return sha256([
      "ref",
      item.id || "",
      ref.storage || "",
      ref.channelId || "",
      ref.messageId || "",
      ref.attachmentId || "",
      ref.fileName || ""
    ].join("|"));
  }
  if (item.iconUrl) {
    return sha256(["url", item.id || "", String(item.iconUrl || "").trim()].join("|"));
  }
  if (item.iconBase64) {
    return sha256(["base64", item.id || "", sha256(item.iconBase64)].join("|"));
  }
  return "";
}

function imageCacheFilePath(cacheKey) {
  return path.join(imageCacheDirectory, `${cacheKey}.img`);
}

function getCachedImageByKey(cacheKey) {
  if (!cacheKey) {
    return null;
  }
  const meta = readImageCacheMeta();
  const entry = meta[cacheKey];
  const filePath = imageCacheFilePath(cacheKey);
  if (!entry || !fs.existsSync(filePath)) {
    return null;
  }
  return {
    ...entry,
    buffer: fs.readFileSync(filePath),
    contentType: entry.contentType || contentTypeFromExtension(entry.extension),
    extension: entry.extension || extensionFromContentType(entry.contentType),
    fileName: entry.fileName || `image-${cacheKey.slice(0, 12)}.${entry.extension || "png"}`,
    source: entry.source || "",
    savedAt: entry.savedAt || ""
  };
}

function rememberCachedImageByKey(cacheKey, image, metadata = {}) {
  if (!cacheKey || !image?.buffer?.length) {
    return null;
  }
  const contentType = String(image.contentType || metadata.contentType || "image/png").split(";")[0].trim().toLowerCase();
  const extension = image.extension || metadata.extension || extensionFromContentType(contentType);
  const fileName = sanitizeFileNamePart(metadata.fileName || `image-${cacheKey.slice(0, 12)}.${extension}`);
  ensureImageCacheDirectory();
  fs.writeFileSync(imageCacheFilePath(cacheKey), image.buffer);
  const meta = readImageCacheMeta();
  meta[cacheKey] = {
    ...metadata,
    contentType,
    extension,
    fileName,
    source: metadata.source || "",
    savedAt: new Date().toISOString(),
    size: image.buffer.length
  };
  writeImageCacheMeta(meta);
  return getCachedImageByKey(cacheKey);
}

function getCachedImageForItem(item) {
  return getCachedImageByKey(makeImageCacheKeyForItem(item))
    || getCachedImageForRef(item?.iconRef || (item?.iconMessageUrl ? { messageUrl: item.iconMessageUrl } : null));
}

function rememberCachedImageForItem(item, image, metadata = {}) {
  const extension = image?.extension || metadata.extension || extensionFromContentType(image?.contentType || metadata.contentType);
  return rememberCachedImageByKey(makeImageCacheKeyForItem(item), image, {
    itemId: String(item?.id || ""),
    itemName: String(item?.name || ""),
    iconUrl: String(item?.iconUrl || ""),
    iconRef: item?.iconRef || null,
    fileName: `${sanitizeFileNamePart(metadata.namePrefix || "item")}-${sanitizeFileNamePart(item?.id || "image")}.${extension}`,
    ...metadata
  });
}

function getCachedImageForUrl(url) {
  const current = getCachedImageByKey(makeImageCacheKeyForUrl(url));
  if (current) {
    return current;
  }
  try {
    if (!fs.existsSync(legacyImageCacheIndexPath)) {
      return null;
    }
    const index = JSON.parse(fs.readFileSync(legacyImageCacheIndexPath, "utf8"));
    const selectedStableUrl = stableImageUrl(url);
    const match = Object.entries(index || {}).find(([, entry]) => stableImageUrl(entry?.url) === selectedStableUrl);
    if (!match) {
      return null;
    }
    const [legacyKey, entry] = match;
    const legacyPath = path.join(legacyImageCacheDirectory, `${legacyKey}.img`);
    if (!fs.existsSync(legacyPath)) {
      return null;
    }
    return rememberCachedImageForUrl(url, {
      buffer: fs.readFileSync(legacyPath),
      contentType: entry.contentType || "image/png",
      extension: extensionFromContentType(entry.contentType)
    }, {
      source: "legacy_local_cache",
      originalUrl: entry.url || ""
    });
  } catch {
    return null;
  }
}

function getCachedImageForRef(ref) {
  return getCachedImageByKey(makeImageCacheKeyForRef(ref));
}

function rememberCachedImageForRef(ref, image, metadata = {}) {
  const extension = image?.extension || metadata.extension || extensionFromContentType(image?.contentType || metadata.contentType);
  return rememberCachedImageByKey(makeImageCacheKeyForRef(ref), image, {
    discordMessageUrl: String(ref?.messageUrl || ""),
    discordRef: ref || null,
    fileName: metadata.fileName || ref?.fileName || `discord-image.${extension}`,
    ...metadata
  });
}

function rememberCachedImageForUrl(url, image, metadata = {}) {
  const extension = image?.extension || metadata.extension || extensionFromContentType(image?.contentType || metadata.contentType);
  return rememberCachedImageByKey(makeImageCacheKeyForUrl(url), image, {
    url: String(url || "").trim(),
    source: String(url || "").trim(),
    fileName: metadata.fileName || `url-${makeImageCacheKeyForUrl(url).slice(0, 12)}.${extension}`,
    ...metadata
  });
}

function parseDataImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    return null;
  }

  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|gif|webp));base64,\s*([A-Za-z0-9+/=\s]+)$/);
  if (!match) {
    return null;
  }

  const extension = match[1].split("/")[1].replace("jpeg", "jpg");
  return {
    buffer: Buffer.from(match[2].replace(/\s/g, ""), "base64"),
    contentType: match[1],
    extension
  };
}

function makeIconAttachment(item, namePrefix) {
  const cached = getCachedImageForItem(item);
  if (cached) {
    const fileName = `${sanitizeFileNamePart(namePrefix)}-${sanitizeFileNamePart(item.id)}.${cached.extension}`;
    return {
      attachment: new AttachmentBuilder(cached.buffer, { name: fileName }),
      url: `attachment://${fileName}`,
      source: "cache",
      cache: cached
    };
  }

  const cachedUrl = getCachedImageForUrl(item?.iconUrl);
  if (cachedUrl) {
    rememberCachedImageForItem(item, cachedUrl, { namePrefix, source: "url_cache" });
    const fileName = `${sanitizeFileNamePart(namePrefix)}-${sanitizeFileNamePart(item.id)}.${cachedUrl.extension}`;
    return {
      attachment: new AttachmentBuilder(cachedUrl.buffer, { name: fileName }),
      url: `attachment://${fileName}`,
      source: "url_cache",
      cache: cachedUrl
    };
  }

  const image = parseDataImage(item.iconBase64);
  if (image) {
    rememberCachedImageForItem(item, image, { namePrefix, source: "base64" });
    const fileName = `${namePrefix}-${item.id}.${image.extension}`;
    return {
      attachment: new AttachmentBuilder(image.buffer, { name: fileName }),
      url: `attachment://${fileName}`,
      source: "base64"
    };
  }

  if (item.iconUrl) {
    return {
      attachment: null,
      url: item.iconUrl,
      source: "url"
    };
  }

  return null;
}

module.exports = {
  extensionFromContentType,
  getCachedImageByKey,
  getCachedImageForItem,
  getCachedImageForRef,
  getCachedImageForUrl,
  makeImageCacheKeyForItem,
  makeImageCacheKeyForRef,
  makeImageCacheKeyForUrl,
  rememberCachedImageByKey,
  rememberCachedImageForItem,
  rememberCachedImageForRef,
  rememberCachedImageForUrl,
  parseDataImage,
  makeIconAttachment
};
