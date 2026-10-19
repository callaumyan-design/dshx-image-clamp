// dshx-image-clamp — host half.
//
// Claude rejects a request that carries more than 20 images when any single
// image has a side above 2000px ("many-image requests: 2000 pixels"). DSH's
// attachment normalizer caps the *pixel budget* at 2000x2000 but lets one side
// exceed 2000 (e.g. 2730x1536), and the subscriptions plugin sends the stored
// bytes verbatim. Every later turn then replays the oversized image and the
// whole session is stuck.
//
// This plugin wraps the live `attachments` service's `readImage` so every image
// handed to any provider is downscaled on the fly (aspect ratio kept) until its
// long edge is <= maxSide. Stored objects on disk are never modified, so the
// original remains available and the change is fully reversible by disabling
// the plugin.

//
// Migrated to DeepSeek Harness 0.2.0 (desktop profile): the harness still reads
// normalized images through `ctx.attachments.readImage()` — the new
// `readImageRequest()` derives every provider-facing variant from it — so the
// same wrapper keeps working. `Config` is declared here (non-volatile, so values
// stay plain numbers) to validate the row config in `cordis.patch.yml`.
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'dshx-image-clamp'

/** Row config; validated at activation, editable from the profile patch. */
export const Config = z.object({
  maxSide: z.number().default(2000),
  maxBytes: z.number().default(184320),
})

/** Default long-edge cap; Claude's many-image limit is 2000px inclusive. */
const DEFAULT_MAX_SIDE = 2000
/**
 * Default per-image encoded byte budget. Anthropic caps a whole request at
 * ~32MB and base64 inflates by 4/3; 100 images (the per-request image cap)
 * x 180KB x 4/3 ~= 24MB, leaving headroom for text.
 */
const DEFAULT_MAX_BYTES = 180 * 1024
/** Quality ladder tried before stepping the size down. */
const QUALITY_LADDER = [82, 70, 58, 45]
/** Max number of downscaled images kept in memory. */
const CACHE_LIMIT = 256

function dshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured.length > 0 ? configured : path.join(os.homedir(), '.dsh')
}

/** Locate sharp: the plugin lives outside the host's node_modules tree. */
function loadSharp() {
  const bases = [
    process.argv[1],
    path.join(dshHome(), 'profiles', 'node_modules', '_'),
    path.join(path.dirname(process.execPath), 'node_modules', '_'),
    import.meta.url,
  ]
  for (const base of bases) {
    if (typeof base !== 'string' || base.length === 0) continue
    try {
      return createRequire(base)('sharp')
    } catch {
      // try next base
    }
  }
  return null
}

export function apply(ctx, config = {}) {
  const maxSide = Number.isSafeInteger(config.maxSide) && config.maxSide > 0 ? config.maxSide : DEFAULT_MAX_SIDE
  const maxBytes = Number.isSafeInteger(config.maxBytes) && config.maxBytes > 0 ? config.maxBytes : DEFAULT_MAX_BYTES
  const logger = ctx.logger?.(name)
  const sharp = loadSharp()
  if (sharp === null) {
    logger?.warn?.('sharp not found; image clamping disabled')
    return
  }

  /** attachmentId -> Promise<{ ref, data }> */
  const cache = new Map()
  const stats = { active: false, maxSide, maxBytes, clamped: 0, savedBytes: 0 }

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/dshx-image-clamp/status',
      handler: async (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ...stats, cached: cache.size }))
      },
    }), 'dshx-image-clamp-status')
  })

  /** Encode once at the given size/quality; alpha images keep transparency via WebP. */
  async function encode(data, w, h, hasAlpha, quality) {
    let pipeline = sharp(data, { failOn: 'none', limitInputPixels: false })
      .toColourspace('srgb')
      .resize({ width: w, height: h, fit: 'inside', withoutEnlargement: true })
    pipeline = hasAlpha
      ? pipeline.webp({ quality, effort: 2 })
      : pipeline.jpeg({ quality, mozjpeg: true })
    const { data: out, info } = await pipeline.toBuffer({ resolveWithObject: true })
    return { out, info, mediaType: hasAlpha ? 'image/webp' : 'image/jpeg' }
  }

  /**
   * Shrink until long edge <= maxSide AND encoded bytes <= maxBytes.
   * Walks a quality ladder, then steps the size down by 20% and retries.
   */
  async function shrink(stored) {
    const { ref, data } = stored
    const width = ref.width
    const height = ref.height
    const meta = await sharp(data, { failOn: 'none', limitInputPixels: false }).metadata()
    const hasAlpha = meta.hasAlpha === true
    let side = Math.min(maxSide, Math.max(width, height))
    let best
    for (let step = 0; step < 6; step += 1) {
      const scale = side / Math.max(width, height)
      const w = Math.max(1, Math.floor(width * scale))
      const h = Math.max(1, Math.floor(height * scale))
      for (const quality of QUALITY_LADDER) {
        const result = await encode(data, w, h, hasAlpha, quality)
        if (best === undefined || result.out.byteLength < best.out.byteLength) best = result
        if (result.out.byteLength <= maxBytes) { best = result; break }
      }
      if (best.out.byteLength <= maxBytes) break
      side = Math.max(256, Math.floor(side * 0.8))
    }
    const { out, info, mediaType } = best
    // Never replace an already-compliant original with something bigger.
    if (width <= maxSide && height <= maxSide && out.byteLength >= data.byteLength) return stored
    const bytes = new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
    stats.clamped += 1
    stats.savedBytes += Math.max(0, data.byteLength - bytes.byteLength)
    logger?.info?.('clamped %s %dx%d %dKB -> %dx%d %dKB', String(ref.attachmentId).slice(7, 19),
      width, height, Math.round(data.byteLength / 1024), info.width, info.height, Math.round(bytes.byteLength / 1024))
    return {
      ref: { ...ref, mediaType, width: info.width, height: info.height, bytes: bytes.byteLength },
      data: bytes,
    }
  }

  ctx.inject(['attachments'], (scope) => {
    const service = scope.get('attachments')
    if (service === undefined || typeof service.readImage !== 'function') return
    if (service.__dshxImageClamp === true) return
    const own = Object.prototype.hasOwnProperty.call(service, 'readImage')
    const original = service.readImage

    const clamped = async function readImage(ref, signal) {
      const stored = await original.call(this, ref, signal)
      const w = stored?.ref?.width ?? 0
      const h = stored?.ref?.height ?? 0
      const size = stored?.data?.byteLength ?? 0
      if (!(w > maxSide || h > maxSide || size > maxBytes)) return stored
      const key = String(stored.ref.attachmentId)
      let pending = cache.get(key)
      if (pending === undefined) {
        pending = shrink(stored)
        cache.set(key, pending)
        pending.catch(() => cache.delete(key))
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
      }
      try {
        return await pending
      } catch (error) {
        logger?.warn?.('clamp failed, sending original: %s', error?.message ?? error)
        return stored
      }
    }

    service.readImage = clamped
    service.__dshxImageClamp = true
    stats.active = true
    logger?.info?.('image clamp active (max side %dpx)', maxSide)

    scope.effect(() => () => {
      if (service.readImage === clamped) {
        if (own) service.readImage = original
        else delete service.readImage
      }
      delete service.__dshxImageClamp
      stats.active = false
      cache.clear()
    })
  })
}
