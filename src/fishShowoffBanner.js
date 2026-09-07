const path = require("node:path");
const { Jimp, JimpMime, intToRGBA, loadFont, rgbaToInt } = require("jimp");
const { resolveDiscordStoredImage } = require("./discordStorage");
const {
  extensionFromContentType,
  getCachedImageForItem,
  getCachedImageForUrl,
  rememberCachedImageForItem,
  rememberCachedImageForUrl,
  parseDataImage
} = require("./imageUtils");

const templatePath = path.join(__dirname, "..", "assets", "fishshowoff-template.png");
const fontRoot = path.join(__dirname, "..", "node_modules", "@jimp", "plugin-print", "fonts", "open-sans");
const fontPaths = {
  title: path.join(fontRoot, "open-sans-32-white", "open-sans-32-white.fnt"),
  body: path.join(fontRoot, "open-sans-16-white", "open-sans-16-white.fnt"),
  small: path.join(fontRoot, "open-sans-14-black", "open-sans-14-black.fnt")
};

const avatarSlot = {
  centerX: 650,
  centerY: 320,
  size: 350,
  radius: 54,
  angle: 13
};

const fishSlot = {
  centerX: 1300,
  centerY: 245,
  size: 335,
  radius: 44,
  angle: -16
};

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value || 0))));
}

function rgba(r, g, b, a = 255) {
  return rgbaToInt(clampByte(r), clampByte(g), clampByte(b), clampByte(a));
}

function makeImage(width, height, color) {
  return new Jimp({ width, height, color });
}

function coverSquare(image, size) {
  const source = image.clone();
  const scale = Math.max(size / source.bitmap.width, size / source.bitmap.height);
  source.resize({
    w: Math.ceil(source.bitmap.width * scale),
    h: Math.ceil(source.bitmap.height * scale)
  });
  const x = Math.max(0, Math.floor((source.bitmap.width - size) / 2));
  const y = Math.max(0, Math.floor((source.bitmap.height - size) / 2));
  return source.crop({ x, y, w: size, h: size });
}

function applyRoundedCorners(image, radius) {
  const { width, height, data } = image.bitmap;
  const safeRadius = Math.max(0, Math.min(radius, Math.floor(Math.min(width, height) / 2)));
  if (!safeRadius) {
    return image;
  }

  image.scan(0, 0, width, height, function scanPixel(x, y, idx) {
    const left = x < safeRadius;
    const right = x >= width - safeRadius;
    const top = y < safeRadius;
    const bottom = y >= height - safeRadius;
    if ((!left && !right) || (!top && !bottom)) {
      return;
    }

    const cornerX = left ? safeRadius : width - safeRadius - 1;
    const cornerY = top ? safeRadius : height - safeRadius - 1;
    const dx = x - cornerX;
    const dy = y - cornerY;
    if (Math.sqrt(dx * dx + dy * dy) > safeRadius) {
      data[idx + 3] = 0;
    }
  });
  return image;
}

function compositeCentered(base, overlay, centerX, centerY) {
  const x = Math.round(centerX - overlay.bitmap.width / 2);
  const y = Math.round(centerY - overlay.bitmap.height / 2);
  base.composite(overlay, x, y);
}

async function fetchImageBufferFromUrl(url) {
  const selectedUrl = String(url || "").trim();
  if (!selectedUrl) {
    return null;
  }
  const response = await fetch(selectedUrl, {
    headers: {
      "User-Agent": "TRFishingBot/1.0",
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    }
  });
  if (!response.ok) {
    throw new Error(`Could not fetch image: ${response.status} ${response.statusText}`);
  }
  const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType,
    extension: extensionFromContentType(contentType)
  };
}

async function readImageFromUrl(url) {
  const cached = getCachedImageForUrl(url);
  if (cached?.buffer?.length) {
    return Jimp.read(cached.buffer);
  }
  const image = await fetchImageBufferFromUrl(url);
  if (image?.buffer?.length) {
    rememberCachedImageForUrl(url, image, { source: "fishshowoff_avatar", fileName: "fishshowoff-avatar.png" });
  }
  return image ? Jimp.read(image.buffer) : null;
}

async function readImageFromItem(item, imageTrace = {}) {
  const cached = getCachedImageForItem(item);
  if (cached) {
    imageTrace.name = cached.fileName || item?.iconRef?.fileName || `${item?.id || "fish"}.png`;
    imageTrace.url = cached.discordMessageUrl || cached.iconUrl || item?.iconRef?.messageUrl || item?.iconUrl || "local cache";
    imageTrace.source = "local cache";
    return Jimp.read(cached.buffer);
  }

  const base64Image = parseDataImage(item?.iconBase64);
  if (base64Image?.buffer?.length) {
    rememberCachedImageForItem(item, base64Image, { namePrefix: "fish", source: "base64" });
    imageTrace.name = `fish-${item?.id || "icon"}.${base64Image.extension || "png"}`;
    imageTrace.url = "manager upload";
    imageTrace.source = "manager upload";
    return Jimp.read(base64Image.buffer);
  }

  const storedImage = await resolveDiscordStoredImage({
    ref: item?.iconRef,
    messageUrl: item?.iconMessageUrl,
    fallbackUrl: item?.iconUrl,
    fileName: item?.iconRef?.fileName || `fish-${item?.id || "icon"}.png`
  }).catch((error) => {
    imageTrace.error = error.message;
    return null;
  });
  if (storedImage?.buffer?.length) {
    const resolvedItem = { ...item, iconRef: storedImage.ref || item?.iconRef };
    rememberCachedImageForItem(resolvedItem, storedImage, { namePrefix: "fish", source: storedImage.source });
    imageTrace.name = storedImage.ref?.fileName || item?.iconRef?.fileName || `fish-${item?.id || "icon"}.${storedImage.extension || "png"}`;
    imageTrace.url = storedImage.url || storedImage.ref?.messageUrl || item?.iconMessageUrl || item?.iconUrl || "local cache";
    imageTrace.source = storedImage.source || "stored image";
    return Jimp.read(storedImage.buffer);
  }

  imageTrace.name = "placeholder fish icon";
  imageTrace.url = item?.iconMessageUrl || item?.iconRef?.messageUrl || item?.iconUrl || "no image URL";
  imageTrace.source = "placeholder";
  return null;
}

function makeFishFallbackTile(fish) {
  const tile = makeImage(fishSlot.size, fishSlot.size, rgba(245, 57, 166, 255));
  const inner = makeImage(fishSlot.size - 32, fishSlot.size - 32, rgba(255, 126, 207, 245));
  applyRoundedCorners(inner, 34);
  tile.composite(inner, 16, 16);

  const cx = Math.floor(fishSlot.size / 2);
  const cy = Math.floor(fishSlot.size / 2);
  const bodyColor = rgba(124, 225, 232, 255);
  const finColor = rgba(80, 176, 209, 255);
  tile.scan(0, 0, fishSlot.size, fishSlot.size, function drawFish(x, y, idx) {
    const body = ((x - cx) ** 2) / (78 ** 2) + ((y - cy) ** 2) / (47 ** 2) <= 1;
    const tail = x > cx + 62 && Math.abs(y - cy) < (x - (cx + 62)) * 0.75 + 10 && x < cx + 112;
    const fin = x > cx - 5 && x < cx + 45 && y > cy - 74 && y < cy - 36;
    if (body || tail || fin) {
      const color = fin || tail ? finColor : bodyColor;
      const value = intToRGBA(color);
      this.bitmap.data[idx] = value.r;
      this.bitmap.data[idx + 1] = value.g;
      this.bitmap.data[idx + 2] = value.b;
      this.bitmap.data[idx + 3] = value.a;
    }
  });
  return tile;
}

async function makeOverlayImage(source, slot, fallback = null) {
  const image = source ? coverSquare(source, slot.size) : fallback || makeImage(slot.size, slot.size, rgba(120, 211, 238, 255));
  applyRoundedCorners(image, slot.radius);
  image.rotate(slot.angle);
  return image;
}

function makeStatsPanel(width, height) {
  const panel = makeImage(width, height, rgba(8, 24, 39, 190));
  applyRoundedCorners(panel, 26);
  return panel;
}

async function drawStats(base, fonts, stats) {
  const panelX = 54;
  const panelY = 612;
  const panel = makeStatsPanel(690, 210);
  base.composite(panel, panelX, panelY);

  base.print({ font: fonts.title, x: panelX + 28, y: panelY + 22, text: stats.displayName });
  base.print({ font: fonts.body, x: panelX + 30, y: panelY + 75, text: `Level ${stats.level}  |  EXP ${stats.exp}/${stats.nextExp}  |  Gold ${stats.gold}` });
  base.print({ font: fonts.body, x: panelX + 30, y: panelY + 108, text: `Total ikan: ${stats.totalFishCaught}  |  Jenis: ${stats.caughtFishTypes}/${stats.availableFishCount}` });
  base.print({ font: fonts.body, x: panelX + 30, y: panelY + 141, text: `Ikan dipamerkan : ${stats.fishName || "Belum ada"}${stats.fishRarity ? ` (${stats.fishRarity})` : ""}` });
  base.print({ font: fonts.body, x: panelX + 30, y: panelY + 174, text: `Max weight: ${stats.fishMaxWeight || "-"}  |  Luck Score: ${stats.fishLuckScore || "-"}` });
}

async function makeFishShowoffBanner({ avatarUrl, fish, stats, imageTrace = {} }) {
  const [base, fonts, avatar, fishImage] = await Promise.all([
    Jimp.read(templatePath),
    Promise.all([
      loadFont(fontPaths.title),
      loadFont(fontPaths.body),
      loadFont(fontPaths.small)
    ]).then(([title, body, small]) => ({ title, body, small })),
    readImageFromUrl(avatarUrl).catch(() => null),
    readImageFromItem(fish, imageTrace).catch((error) => {
      imageTrace.name = "placeholder fish icon";
      imageTrace.url = fish?.iconMessageUrl || fish?.iconRef?.messageUrl || fish?.iconUrl || "no image URL";
      imageTrace.source = "placeholder";
      imageTrace.error = error.message;
      return null;
    })
  ]);

  const avatarOverlay = await makeOverlayImage(avatar, avatarSlot);
  const fishOverlay = await makeOverlayImage(fishImage, fishSlot, makeFishFallbackTile(fish));
  compositeCentered(base, avatarOverlay, avatarSlot.centerX, avatarSlot.centerY);
  compositeCentered(base, fishOverlay, fishSlot.centerX, fishSlot.centerY);
  await drawStats(base, fonts, stats);
  return base.getBuffer(JimpMime.png);
}

module.exports = {
  makeFishShowoffBanner
};
