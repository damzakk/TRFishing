const crypto = require("node:crypto");
const { AttachmentBuilder } = require("discord.js");
const { Jimp } = require("jimp");
const { GifFrame, GifCodec, GifUtil } = require("gifwrap");
const {
  getCachedImageForItem,
  getCachedImageForUrl,
  getCachedImageByKey,
  makeIconAttachment,
  makeImageCacheKeyForItem,
  makeImageCacheKeyForUrl,
  rememberCachedImageByKey,
  rememberCachedImageForItem,
  rememberCachedImageForUrl,
  parseDataImage,
  extensionFromContentType
} = require("./imageUtils");
const { getMutationDefinition } = require("./mutationSystem");

const mutationFrameCount = 8;
const mutationFrameDelay = 8;
const maxMutationIconSize = 192;

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

function parseColor(color, fallback = [255, 255, 255]) {
  const numeric = typeof color === "number" ? color : Number.parseInt(String(color || "").replace(/^#/, ""), 16);
  if (!Number.isFinite(numeric)) return fallback;
  return [(numeric >> 16) & 255, (numeric >> 8) & 255, numeric & 255];
}

function colorToOpaqueInt(color) {
  const [red, green, blue] = parseColor(color, [255, 255, 255]);
  return (((red << 24) | (green << 16) | (blue << 8) | 255) >>> 0);
}

async function flattenImageForMutation(image, mutation) {
  const background = new Jimp({
    width: image.bitmap.width,
    height: image.bitmap.height,
    color: colorToOpaqueInt(mutation?.color)
  });
  background.composite(image, 0, 0);
  const jpegBuffer = await background.getBuffer("image/jpeg", { quality: 95 });
  return Jimp.read(jpegBuffer);
}

function blendPixel(data, index, color, amount, alphaMultiplier = 1) {
  const alpha = data[index + 3];
  if (!alpha) return;
  const mix = Math.max(0, Math.min(1, amount));
  data[index] = clampByte(data[index] * (1 - mix) + color[0] * mix);
  data[index + 1] = clampByte(data[index + 1] * (1 - mix) + color[1] * mix);
  data[index + 2] = clampByte(data[index + 2] * (1 - mix) + color[2] * mix);
  data[index + 3] = clampByte(alpha * Math.max(0, Math.min(1, alphaMultiplier)));
}

function tintImage(image, color, amount = 0.35, alphaMultiplier = 1) {
  const { data } = image.bitmap;
  for (let index = 0; index < data.length; index += 4) {
    blendPixel(data, index, color, amount, alphaMultiplier);
  }
}

function setPixel(image, x, y, color, alpha = 255) {
  const { width, height, data } = image.bitmap;
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const index = (y * width + x) * 4;
  data[index] = color[0];
  data[index + 1] = color[1];
  data[index + 2] = color[2];
  data[index + 3] = alpha;
}

function drawLine(image, startX, startY, endX, endY, color, alpha = 230, thickness = 1) {
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

function drawBorder(image, color, width = 3, alpha = 240) {
  const { width: imageWidth, height: imageHeight } = image.bitmap;
  const safeWidth = Math.max(1, Math.min(width, Math.floor(Math.min(imageWidth, imageHeight) / 6)));
  for (let layer = 0; layer < safeWidth; layer += 1) {
    const layerAlpha = clampByte(alpha * (1 - layer / Math.max(1, safeWidth * 1.4)));
    for (let x = layer; x < imageWidth - layer; x += 1) {
      setPixel(image, x, layer, color, layerAlpha);
      setPixel(image, x, imageHeight - layer - 1, color, layerAlpha);
    }
    for (let y = layer; y < imageHeight - layer; y += 1) {
      setPixel(image, layer, y, color, layerAlpha);
      setPixel(image, imageWidth - layer - 1, y, color, layerAlpha);
    }
  }
}

function drawSparkle(image, x, y, color, size = 4, alpha = 240) {
  for (let offset = -size; offset <= size; offset += 1) {
    const strength = clampByte(alpha * (1 - Math.abs(offset) / Math.max(1, size + 1)));
    setPixel(image, x + offset, y, color, strength);
    setPixel(image, x, y + offset, color, strength);
  }
  setPixel(image, x, y, [255, 255, 255], 255);
}

function applyVisualPreset(image, mutation, frameIndex) {
  const preset = String(mutation?.visual || "");
  const color = parseColor(mutation?.color, [255, 255, 255]);
  const { width, height } = image.bitmap;
  const pulse = 0.5 + 0.5 * Math.sin((frameIndex / mutationFrameCount) * Math.PI * 2);

  if (preset === "stone") {
    tintImage(image, color, 0.42);
    drawBorder(image, color, 2 + Math.round(pulse), 220);
  } else if (preset === "gold") {
    tintImage(image, color, 0.32 + pulse * 0.13);
    drawBorder(image, color, 3 + Math.round(pulse), 230);
    drawSparkle(image, Math.round(width * 0.2 + pulse * width * 0.58), Math.round(height * 0.22), [255, 248, 183], 3, 235);
    drawSparkle(image, Math.round(width * 0.72), Math.round(height * (0.65 - pulse * 0.18)), [255, 255, 255], 2, 230);
  } else if (preset === "freezing") {
    tintImage(image, color, 0.32);
    drawBorder(image, [180, 242, 255], 3, 240);
    for (let index = 0; index < 5; index += 1) {
      const x = Math.round(((index * 41 + frameIndex * 7) % Math.max(1, width - 4)) + 2);
      const y = Math.round(((index * 67 + frameIndex * 11) % Math.max(1, height - 4)) + 2);
      drawSparkle(image, x, y, [225, 255, 255], 2, 190);
    }
  } else if (preset === "ghost") {
    tintImage(image, color, 0.26, 0.66 + pulse * 0.2);
    drawBorder(image, color, 2, 170);
    drawLine(image, Math.round(width * (0.16 + pulse * 0.07)), Math.round(height * 0.78), Math.round(width * 0.82), Math.round(height * (0.2 + pulse * 0.08)), color, 90, 1);
  } else if (preset === "radioactive") {
    tintImage(image, color, 0.25 + pulse * 0.1);
    drawBorder(image, color, 2 + Math.round(pulse), 240);
    for (let index = 0; index < 4; index += 1) {
      drawSparkle(image, Math.round(width * (0.18 + index * 0.2)), Math.round(height * (0.18 + ((frameIndex + index) % 4) * 0.2)), [216, 255, 117], 2, 200);
    }
  } else if (preset === "lightning") {
    tintImage(image, color, 0.2 + pulse * 0.12);
    drawBorder(image, color, 2, 210);
    const points = [
      [0.16, 0.15], [0.42, 0.32], [0.32, 0.52], [0.66, 0.65], [0.57, 0.88]
    ];
    for (let index = 1; index < points.length; index += 1) {
      drawLine(image, Math.round(width * points[index - 1][0]), Math.round(height * points[index - 1][1]), Math.round(width * points[index][0]), Math.round(height * points[index][1]), [255, 255, 190], 150 + Math.round(pulse * 100), 1);
    }
  } else if (preset === "midnight") {
    tintImage(image, color, 0.42 + pulse * 0.08);
    drawBorder(image, [109, 119, 255], 2, 220);
    for (let index = 0; index < 5; index += 1) {
      setPixel(image, Math.round(((index * 53 + frameIndex * 3) % Math.max(1, width - 2)) + 1), Math.round(((index * 37 + frameIndex * 5) % Math.max(1, height - 2)) + 1), [255, 255, 255], 210);
    }
  } else if (preset === "fairy_dust") {
    tintImage(image, color, 0.18 + pulse * 0.08);
    drawBorder(image, color, 2, 210);
    for (let index = 0; index < 7; index += 1) {
      drawSparkle(image, Math.round(((index * 67 + frameIndex * 13) % Math.max(1, width - 8)) + 4), Math.round(((index * 31 + frameIndex * 9) % Math.max(1, height - 8)) + 4), [255, 235, 255], 1 + (index % 2), 180);
    }
  } else if (preset === "gemstone") {
    tintImage(image, color, 0.22 + pulse * 0.12);
    drawBorder(image, [152, 255, 255], 3, 240);
    drawLine(image, 0, Math.round(height * 0.25), width, Math.round(height * (0.25 + pulse * 0.15)), [255, 255, 255], 100, 1);
  } else if (preset === "corrupt") {
    tintImage(image, color, 0.27);
    drawBorder(image, [216, 77, 255], 2 + Math.round(pulse), 225);
    for (let index = 0; index < 4; index += 1) {
      drawLine(image, Math.round(width * (0.1 + index * 0.23)), 0, Math.round(width * (0.24 + index * 0.19)), height, [255, 62, 210], 65 + Math.round(pulse * 80), 1);
    }
  } else if (preset === "galaxy") {
    tintImage(image, color, 0.18 + pulse * 0.1);
    drawBorder(image, [182, 125, 255], 3, 235);
    for (let index = 0; index < 9; index += 1) {
      setPixel(image, Math.round(((index * 47 + frameIndex * 7) % Math.max(1, width - 2)) + 1), Math.round(((index * 29 + frameIndex * 5) % Math.max(1, height - 2)) + 1), [255, 255, 255], 190);
    }
  } else if (preset === "bloodmoon") {
    tintImage(image, color, 0.3 + pulse * 0.1);
    drawBorder(image, [255, 75, 95], 3, 235);
    drawSparkle(image, Math.round(width * 0.76), Math.round(height * 0.22), [255, 148, 148], 3, 180);
  } else if (preset === "minty") {
    tintImage(image, color, 0.22 + pulse * 0.08);
    drawBorder(image, [171, 255, 224], 2, 225);
    for (let index = 0; index < 5; index += 1) {
      drawSparkle(image, Math.round(((index * 43 + frameIndex * 5) % Math.max(1, width - 6)) + 3), Math.round(((index * 71 + frameIndex * 3) % Math.max(1, height - 6)) + 3), [226, 255, 241], 1, 180);
    }
  } else if (preset === "jawa") {
    tintImage(image, color, 0.2 + pulse * 0.12);
    drawBorder(image, [255, 176, 91], 3, 235);
    drawSparkle(image, Math.round(width * (0.28 + pulse * 0.3)), Math.round(height * 0.25), [255, 243, 205], 3, 220);
  }

  return image;
}

function applyCustomOverlay(image, overlaySource, overlaySettings, frameIndex) {
  if (!overlaySource?.bitmap?.width || !overlaySource?.bitmap?.height) return image;
  const framePhase = (frameIndex / mutationFrameCount) * Math.PI * 2 * Math.max(0.1, Number(overlaySettings?.motionSpeed || 1));
  const motion = String(overlaySettings?.motion || "static");
  const baseScale = Math.max(0.05, Math.min(2, Number(overlaySettings?.scale || 0.35)));
  const scalePulse = motion === "pulse" || motion === "zoom" ? (motion === "zoom" ? 0.68 : 0.82) + (motion === "zoom" ? 0.32 : 0.18) * (0.5 + 0.5 * Math.sin(framePhase)) : 1;
  const targetSize = Math.max(1, Math.round(Math.min(image.bitmap.width, image.bitmap.height) * baseScale * scalePulse));
  const overlayImage = overlaySource.clone();
  const overlayScale = targetSize / Math.max(overlayImage.bitmap.width, overlayImage.bitmap.height);
  overlayImage.resize({
    w: Math.max(1, Math.round(overlayImage.bitmap.width * overlayScale)),
    h: Math.max(1, Math.round(overlayImage.bitmap.height * overlayScale))
  });

  let opacity = Math.max(0, Math.min(1, Number(overlaySettings?.opacity ?? 1)));
  if (motion === "twinkle") opacity *= 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(framePhase));
  if (opacity < 1) {
    for (let index = 3; index < overlayImage.bitmap.data.length; index += 4) {
      overlayImage.bitmap.data[index] = clampByte(overlayImage.bitmap.data[index] * opacity);
    }
  }

  const baseX = image.bitmap.width * Math.max(0, Math.min(100, Number(overlaySettings?.x ?? 75))) / 100;
  const baseY = image.bitmap.height * Math.max(0, Math.min(100, Number(overlaySettings?.y ?? 25))) / 100;
  let x = baseX;
  let y = baseY;
  if (motion === "float") {
    x += Math.sin(framePhase) * image.bitmap.width * 0.04;
    y += Math.cos(framePhase) * image.bitmap.height * 0.04;
  } else if (motion === "orbit") {
    x += Math.cos(framePhase) * image.bitmap.width * 0.16;
    y += Math.sin(framePhase) * image.bitmap.height * 0.16;
  } else if (motion === "sweep") {
    x += Math.sin(framePhase) * image.bitmap.width * 0.22;
  } else if (motion === "bounce") {
    x += Math.sin(framePhase) * image.bitmap.width * 0.08;
    y -= Math.abs(Math.sin(framePhase)) * image.bitmap.height * 0.14;
  } else if (motion === "spiral") {
    const radius = 0.06 + (0.5 + 0.5 * Math.sin(framePhase)) * 0.12;
    x += Math.cos(framePhase) * image.bitmap.width * radius;
    y += Math.sin(framePhase) * image.bitmap.height * radius;
  } else if (motion === "shake") {
    x += Math.sin(framePhase * 7) * image.bitmap.width * 0.025;
    y += Math.cos(framePhase * 9) * image.bitmap.height * 0.025;
  }
  image.composite(overlayImage, Math.round(x - overlayImage.bitmap.width / 2), Math.round(y - overlayImage.bitmap.height / 2));
  return image;
}

async function fetchImageBuffer(url) {
  const response = await fetch(String(url), {
    headers: { "User-Agent": "TRFishingBot/1.0", Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" }
  });
  if (!response.ok) throw new Error(`Could not fetch fish icon: ${response.status}`);
  const contentType = String(response.headers.get("content-type") || "image/png").split(";")[0].trim().toLowerCase();
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType,
    extension: extensionFromContentType(contentType)
  };
}

async function getBaseImage(item) {
  const cached = getCachedImageForItem(item) || getCachedImageForUrl(item?.iconUrl);
  if (cached?.buffer?.length) return cached;

  const dataImage = parseDataImage(item?.iconBase64);
  if (dataImage?.buffer?.length) {
    rememberCachedImageForItem(item, dataImage, { namePrefix: "fish", source: "mutation_visual_base64" });
    return dataImage;
  }

  if (item?.iconUrl) {
    const image = await fetchImageBuffer(item.iconUrl);
    rememberCachedImageForUrl(item.iconUrl, image, { source: "mutation_visual_url", fileName: `fish-${item.id || "icon"}.${image.extension}` });
    rememberCachedImageForItem(item, image, { namePrefix: "fish", source: "mutation_visual_url" });
    return image;
  }
  return null;
}

async function getOverlayImage(overlay) {
  const dataImage = parseDataImage(overlay?.base64);
  if (dataImage?.buffer?.length) return dataImage;
  const sourceUrl = String(overlay?.url || "").trim();
  if (!sourceUrl) return null;
  const cached = getCachedImageForUrl(sourceUrl);
  if (cached?.buffer?.length) return cached;
  const image = await fetchImageBuffer(sourceUrl);
  rememberCachedImageForUrl(sourceUrl, image, { source: "mutation_overlay_url", fileName: `mutation-overlay-${overlay?.id || "image"}.${image.extension}` });
  return image;
}

function mutationCacheKey(item, mutation, baseImage) {
  const sourceKey = makeImageCacheKeyForItem(item) || makeImageCacheKeyForUrl(item?.iconUrl) || crypto.createHash("sha256").update(baseImage.buffer).digest("hex");
  const mutationKey = JSON.stringify({
    id: mutation?.id || "",
    color: mutation?.color,
    visual: mutation?.visual,
    enabled: mutation?.enabled,
    overlays: (mutation?.customOverlays || []).map((overlay) => ({
      id: overlay?.id,
      name: overlay?.name,
      base64: overlay?.base64
        ? crypto.createHash("sha256").update(overlay.base64).digest("hex")
        : "",
      url: overlay?.url,
      scale: overlay?.scale,
      x: overlay?.x,
      y: overlay?.y,
      opacity: overlay?.opacity,
      motion: overlay?.motion,
      motionSpeed: overlay?.motionSpeed,
      enabled: overlay?.enabled
    }))
 });
  return crypto.createHash("sha256").update(`mutation|${item?.id || "fish"}|${mutationKey}|${sourceKey}`).digest("hex");
}

async function makeMutationIconAttachment(item, mutationId, namePrefix = "fish", rawMutations = null) {
  const mutation = getMutationDefinition(mutationId, rawMutations);
  if (!mutation) {
    const attachment = makeIconAttachment(item, namePrefix);
    const baseImage = await getBaseImage(item).catch(() => null);
    return { ...attachment, buffer: baseImage?.buffer || null, contentType: baseImage?.contentType || "image/png" };
  }

  try {
    const baseImage = await getBaseImage(item);
    if (!baseImage?.buffer?.length) return makeIconAttachment(item, namePrefix);

    const cacheKey = mutationCacheKey(item, mutation, baseImage);
    const cached = getCachedImageByKey(cacheKey);
    if (cached?.buffer?.length) {
      const fileName = `${namePrefix}-${item.id}-${mutation.id}.gif`;
      return {
        attachment: new AttachmentBuilder(cached.buffer, { name: fileName }),
        url: `attachment://${fileName}`,
        source: "mutation_cache",
        buffer: cached.buffer,
        contentType: "image/gif",
        cache: cached
      };
    }

    let source = await Jimp.read(baseImage.buffer);
   source = await flattenImageForMutation(source, mutation);
    if (Math.max(source.bitmap.width, source.bitmap.height) > maxMutationIconSize) {
      const scale = maxMutationIconSize / Math.max(source.bitmap.width, source.bitmap.height);
      source = source.resize({
        w: Math.max(1, Math.round(source.bitmap.width * scale)),
        h: Math.max(1, Math.round(source.bitmap.height * scale))
      });
    }

    const overlays = await Promise.all((mutation.customOverlays || [])
      .filter((overlay) => overlay?.enabled !== false)
      .map(async (overlay) => {
        const sourceOverlay = await getOverlayImage(overlay).catch(() => null);
        return {
          settings: overlay,
          image: sourceOverlay?.buffer?.length ? await Jimp.read(sourceOverlay.buffer) : null
        };
      }));
    const frames = [];
   for (let frameIndex = 0; frameIndex < mutationFrameCount; frameIndex += 1) {
      const frameImage = applyVisualPreset(source.clone(), mutation, frameIndex);
     for (const overlay of overlays) {
       if (overlay.image) applyCustomOverlay(frameImage, overlay.image, overlay.settings, frameIndex);
     }
      frames.push(new GifFrame(frameImage.bitmap, { delayCentisecs: mutationFrameDelay, disposalMethod: 2 }));
   }
    GifUtil.quantizeDekker(frames, 256);
    const gif = await new GifCodec().encodeGif(frames, { loops: 0 });
    const generated = rememberCachedImageByKey(cacheKey, {
      buffer: gif.buffer,
      contentType: "image/gif",
      extension: "gif"
    }, {
      source: "mutation_generated",
      itemId: String(item?.id || ""),
      mutationId: mutation.id,
      fileName: `${namePrefix}-${item.id}-${mutation.id}.gif`
    });
    const fileName = `${namePrefix}-${item.id}-${mutation.id}.gif`;
    return {
      attachment: new AttachmentBuilder(generated?.buffer || gif.buffer, { name: fileName }),
      url: `attachment://${fileName}`,
      source: "mutation_generated",
      buffer: generated?.buffer || gif.buffer,
      contentType: "image/gif",
      cache: generated
    };
  } catch (error) {
    console.warn(`Mutation icon generation failed for ${item?.id || "fish"}/${mutation.id}: ${error.message}`);
    const attachment = makeIconAttachment(item, namePrefix);
    const baseImage = await getBaseImage(item).catch(() => null);
    return { ...attachment, buffer: baseImage?.buffer || null, contentType: baseImage?.contentType || "image/png" };
  }
}

module.exports = { makeMutationIconAttachment };
