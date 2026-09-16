const path = require("node:path");
const { Jimp, JimpMime, intToRGBA, loadFont, rgbaToInt } = require("jimp");
const { GifCodec, GifFrame, GifUtil } = require("gifwrap");
const { resolveDiscordStoredImage } = require("./discordStorage");
const { makeMutationIconAttachment } = require("./mutationVisuals");
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

const equipmentCard = {
  width: 224,
  height: 214,
  y: 625,
  iconSize: 132,
  firstX: 790,
  gap: 18
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

function setPixel(image, x, y, color, alpha = 255) {
  const { width, height, data } = image.bitmap;
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const index = (y * width + x) * 4;
  data[index] = clampByte(color[0]);
  data[index + 1] = clampByte(color[1]);
  data[index + 2] = clampByte(color[2]);
  data[index + 3] = clampByte(alpha);
}

function drawLine(image, startX, startY, endX, endY, color, alpha = 255, thickness = 1) {
  const steps = Math.max(Math.abs(endX - startX), Math.abs(endY - startY), 1);
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    const x = Math.round(startX + (endX - startX) * progress);
    const y = Math.round(startY + (endY - startY) * progress);
    for (let offsetX = -thickness + 1; offsetX < thickness; offsetX += 1) {
      for (let offsetY = -thickness + 1; offsetY < thickness; offsetY += 1) {
        setPixel(image, x + offsetX, y + offsetY, color, alpha);
      }
    }
  }
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

async function readImageFromItem(item, imageTrace = {}, namePrefix = "fish") {
  if (!item) {
    return null;
  }

  const cached = getCachedImageForItem(item);
  if (cached) {
    imageTrace.name = cached.fileName || item?.iconRef?.fileName || `${item?.id || "fish"}.png`;
    imageTrace.url = cached.discordMessageUrl || cached.iconUrl || item?.iconRef?.messageUrl || item?.iconUrl || "local cache";
    imageTrace.source = "local cache";
    return Jimp.read(cached.buffer);
  }

  const base64Image = parseDataImage(item?.iconBase64);
  if (base64Image?.buffer?.length) {
    rememberCachedImageForItem(item, base64Image, { namePrefix, source: "base64" });
    imageTrace.name = `${namePrefix}-${item?.id || "icon"}.${base64Image.extension || "png"}`;
    imageTrace.url = "manager upload";
    imageTrace.source = "manager upload";
    return Jimp.read(base64Image.buffer);
  }

  const storedImage = await resolveDiscordStoredImage({
    ref: item?.iconRef,
    messageUrl: item?.iconMessageUrl,
    fallbackUrl: item?.iconUrl,
    fileName: item?.iconRef?.fileName || `${namePrefix}-${item?.id || "icon"}.png`
  }).catch((error) => {
    imageTrace.error = error.message;
    return null;
  });
  if (storedImage?.buffer?.length) {
    const resolvedItem = { ...item, iconRef: storedImage.ref || item?.iconRef };
    rememberCachedImageForItem(resolvedItem, storedImage, { namePrefix, source: storedImage.source });
    imageTrace.name = storedImage.ref?.fileName || item?.iconRef?.fileName || `${namePrefix}-${item?.id || "icon"}.${storedImage.extension || "png"}`;
    imageTrace.url = storedImage.url || storedImage.ref?.messageUrl || item?.iconMessageUrl || item?.iconUrl || "local cache";
    imageTrace.source = storedImage.source || "stored image";
    return Jimp.read(storedImage.buffer);
  }

  imageTrace.name = "placeholder fish icon";
  imageTrace.url = item?.iconMessageUrl || item?.iconRef?.messageUrl || item?.iconUrl || "no image URL";
  imageTrace.source = "placeholder";
  return null;
}

function makeEquipmentFallbackTile(item, type, size = equipmentCard.iconSize) {
  const colors = type === "rod"
    ? { background: [62, 117, 176], art: [255, 211, 120], accent: [205, 232, 255] }
    : { background: [71, 147, 133], art: [240, 205, 142], accent: [220, 255, 241] };
  const tile = makeImage(size, size, rgba(...colors.background, 255));
  const inner = makeImage(size - 14, size - 14, rgba(255, 255, 255, 32));
  applyRoundedCorners(inner, 18);
  tile.composite(inner, 7, 7);

  if (type === "rod") {
    drawLine(tile, Math.round(size * 0.2), Math.round(size * 0.76), Math.round(size * 0.78), Math.round(size * 0.2), colors.art, 255, 5);
    drawLine(tile, Math.round(size * 0.68), Math.round(size * 0.26), Math.round(size * 0.84), Math.round(size * 0.14), colors.accent, 230, 2);
    tile.scan(Math.round(size * 0.45), Math.round(size * 0.55), Math.round(size * 0.32), Math.round(size * 0.28), function drawReel(x, y, idx) {
      const dx = x - Math.round(size * 0.6);
      const dy = y - Math.round(size * 0.66);
      if (dx * dx + dy * dy < Math.round(size * 0.11) ** 2) {
        const color = intToRGBA(rgba(...colors.accent, 255));
        this.bitmap.data[idx] = color.r;
        this.bitmap.data[idx + 1] = color.g;
        this.bitmap.data[idx + 2] = color.b;
        this.bitmap.data[idx + 3] = color.a;
      }
    });
  } else {
    const bagX = Math.round(size * 0.22);
    const bagY = Math.round(size * 0.3);
    const bagW = Math.round(size * 0.56);
    const bagH = Math.round(size * 0.48);
    tile.scan(bagX, bagY, bagW, bagH, function drawBag(x, y, idx) {
      const edge = x === bagX || x === bagX + bagW - 1 || y === bagY + bagH - 1;
      const handle = y < bagY + 12 && x > bagX + 28 && x < bagX + bagW - 28;
      if (!edge && !handle) return;
      const color = intToRGBA(rgba(...(handle ? colors.accent : colors.art), 255));
      this.bitmap.data[idx] = color.r;
      this.bitmap.data[idx + 1] = color.g;
      this.bitmap.data[idx + 2] = color.b;
      this.bitmap.data[idx + 3] = color.a;
    });
    drawLine(tile, Math.round(size * 0.3), Math.round(size * 0.42), Math.round(size * 0.7), Math.round(size * 0.42), colors.accent, 220, 2);
  }

  applyRoundedCorners(tile, 22);
  return tile;
}

function fitImageInsideTile(source, size) {
  if (!source?.bitmap?.width || !source?.bitmap?.height) return null;
  const image = source.clone();
  const scale = Math.min((size - 18) / image.bitmap.width, (size - 18) / image.bitmap.height);
  image.resize({
    w: Math.max(1, Math.round(image.bitmap.width * scale)),
    h: Math.max(1, Math.round(image.bitmap.height * scale))
  });
  const tile = makeImage(size, size, rgba(0, 0, 0, 0));
  compositeCentered(tile, image, size / 2, size / 2);
  return tile;
}

function makeEquipmentCard(base, fonts, image, item, type, x) {
  const card = makeImage(equipmentCard.width, equipmentCard.height, rgba(8, 24, 39, 190));
  applyRoundedCorners(card, 24);
  const fallback = makeEquipmentFallbackTile(item, type, equipmentCard.iconSize);
  const fitted = fitImageInsideTile(image, equipmentCard.iconSize);
  if (fitted) fallback.composite(fitted, 0, 0);
  card.composite(fallback, Math.round((equipmentCard.width - equipmentCard.iconSize) / 2), 30);
  base.composite(card, x, equipmentCard.y);

  const label = type === "rod" ? "Pancingan" : "Tas Pancing";
  base.print({
    font: fonts.body,
    x: x + 12,
    y: equipmentCard.y + 10,
    text: label,
    maxWidth: equipmentCard.width - 24,
    maxHeight: 18
  });
  base.print({
    font: fonts.body,
    x: x + 12,
    y: equipmentCard.y + 168,
    text: item?.name || "Belum ada",
    maxWidth: equipmentCard.width - 24,
    maxHeight: 40
  });
}

async function readFishFrames(fish, mutationId = "", mutationSettings = null, imageTrace = {}) {
  if (!fish) return [];

  if (mutationId) {
    const mutationIcon = await makeMutationIconAttachment(fish, mutationId, "fishshowoff", mutationSettings).catch(() => null);
    if (mutationIcon?.buffer?.length) {
      imageTrace.name = mutationIcon.cache?.fileName || `fishshowoff-${fish.id}-${mutationId}.gif`;
      imageTrace.url = fish?.iconRef?.messageUrl || fish?.iconMessageUrl || fish?.iconUrl || "local mutation cache";
      imageTrace.source = mutationIcon.contentType === "image/gif" ? "mutation animation" : "mutation icon";
      if (mutationIcon.contentType === "image/gif") {
        try {
          const decoded = await new GifCodec().decodeGif(mutationIcon.buffer);
          if (decoded.frames.length) {
            return decoded.frames.map((frame) => Jimp.fromBitmap(frame.bitmap));
          }
        } catch (error) {
          imageTrace.error = error.message;
        }
      }
      try {
        return [await Jimp.read(mutationIcon.buffer)];
      } catch {
        // Fall through to the normal item-image resolver below.
      }
    }
  }

  const image = await readImageFromItem(fish, imageTrace, "fish");
  return image ? [image] : [];
}

function makeFishShowoffGif(base, fishOverlays, delays) {
  const firstFrame = base.clone();
  compositeCentered(firstFrame, fishOverlays[0], fishSlot.centerX, fishSlot.centerY);
  const frames = [new GifFrame(firstFrame.bitmap, {
    delayCentisecs: Math.max(1, Number(delays[0] || 8)),
    disposalMethod: GifFrame.DisposeNothing
  })];

  // Keep the static banner in the first frame and encode only the fish area for
  // later frames so an animated showoff stays reasonably small for Discord.
  const patchSize = 480;
  const patchX = Math.max(0, Math.round(fishSlot.centerX - patchSize / 2));
  const patchY = Math.max(0, Math.round(fishSlot.centerY - patchSize / 2));
  const patchTemplate = base.clone().crop({ x: patchX, y: patchY, w: patchSize, h: patchSize });
  for (let index = 1; index < fishOverlays.length; index += 1) {
    const patch = patchTemplate.clone();
    compositeCentered(patch, fishOverlays[index], fishSlot.centerX - patchX, fishSlot.centerY - patchY);
    frames.push(new GifFrame(patch.bitmap, {
      xOffset: patchX,
      yOffset: patchY,
      delayCentisecs: Math.max(1, Number(delays[index] || delays[index - 1] || 8)),
      disposalMethod: GifFrame.DisposeNothing
    }));
  }

  GifUtil.quantizeWu(frames, 256, 4);
  return new GifCodec().encodeGif(frames, { loops: 0 });
}

function annotateBannerBuffer(buffer, contentType, extension) {
  Object.defineProperties(buffer, {
    contentType: { value: contentType, enumerable: false },
    extension: { value: extension, enumerable: false }
  });
  return buffer;
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
  const mutationText = stats.fishMutationName ? ` · ${stats.fishMutationName}` : "";
  base.print({ font: fonts.body, x: panelX + 30, y: panelY + 141, text: `Ikan dipamerkan : ${stats.fishName || "Belum ada"}${mutationText}${stats.fishRarity ? ` (${stats.fishRarity})` : ""}` });
  base.print({ font: fonts.body, x: panelX + 30, y: panelY + 174, text: `Max weight: ${stats.fishMaxWeight || "-"}  |  Luck Score: ${stats.fishLuckScore || "-"}` });
}

async function makeFishShowoffBanner({ avatarUrl, fish, rod = null, fishBag = null, mutationId = "", mutationSettings = null, stats, imageTrace = {} }) {
  const [base, fonts, avatar, fishFrames, rodImage, fishBagImage] = await Promise.all([
    Jimp.read(templatePath),
    Promise.all([
      loadFont(fontPaths.title),
      loadFont(fontPaths.body),
      loadFont(fontPaths.small)
    ]).then(([title, body, small]) => ({ title, body, small })),
    readImageFromUrl(avatarUrl).catch(() => null),
    readFishFrames(fish, mutationId, mutationSettings, imageTrace).catch((error) => {
      imageTrace.name = "placeholder fish icon";
      imageTrace.url = fish?.iconMessageUrl || fish?.iconRef?.messageUrl || fish?.iconUrl || "no image URL";
      imageTrace.source = "placeholder";
      imageTrace.error = error.message;
      return [];
    }),
    readImageFromItem(rod, {}, "rod").catch(() => null),
    readImageFromItem(fishBag, {}, "fish-bag").catch(() => null)
  ]);

  const avatarOverlay = await makeOverlayImage(avatar, avatarSlot);
  compositeCentered(base, avatarOverlay, avatarSlot.centerX, avatarSlot.centerY);
  makeEquipmentCard(base, fonts, rodImage, rod, "rod", equipmentCard.firstX);
  makeEquipmentCard(base, fonts, fishBagImage, fishBag, "fishBag", equipmentCard.firstX + equipmentCard.width + equipmentCard.gap);
  await drawStats(base, fonts, stats);

  const sourceFrames = fishFrames.length ? fishFrames : [makeFishFallbackTile(fish)];
  const fishOverlays = await Promise.all(sourceFrames.map((source) => makeOverlayImage(source, fishSlot, makeFishFallbackTile(fish))));
  if (fishOverlays.length > 1) {
    const delays = sourceFrames.map((source) => Math.max(1, Number(source?.delayCentisecs || 8)));
    const gif = await makeFishShowoffGif(base, fishOverlays, delays);
    return annotateBannerBuffer(gif.buffer, "image/gif", "gif");
  }

  compositeCentered(base, fishOverlays[0], fishSlot.centerX, fishSlot.centerY);
  return annotateBannerBuffer(await base.getBuffer(JimpMime.png), "image/png", "png");
}

module.exports = {
  makeFishShowoffBanner
};
