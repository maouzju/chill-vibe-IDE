import iconv from 'iconv-lite'
import jschardet from 'jschardet'

/**
 * Text encoding detection and round-trip-safe re-encoding for workspace files.
 *
 * Canonical encoding ids are lowercase iconv-lite names ('utf8', 'utf16le',
 * 'gb18030', ...). 'utf8bom' is our own marker for UTF-8 with a stripped BOM
 * so saves can faithfully restore the BOM bytes.
 */
export type DetectedText = { content: string; encoding: string }

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16BE_BOM = Buffer.from([0xfe, 0xff])

// Guessing is statistical — bound the sample so huge files stay cheap.
const DETECT_SNIFF_BYTES = 64 * 1024
const MIN_DETECT_CONFIDENCE = 0.7

// The pragmatic fallback for non-UTF-8 text on this product's primary
// (Chinese Windows) audience: GB18030 is a GBK/GB2312 superset and decodes
// nearly every byte sequence, so it never throws where utf8 would mojibake.
const FALLBACK_ENCODING = 'gb18030'

export const sniffBomEncoding = (buffer: Buffer): 'utf8bom' | 'utf16le' | 'utf16be' | null => {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)) {
    return 'utf8bom'
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(UTF16LE_BOM)) {
    return 'utf16le'
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(UTF16BE_BOM)) {
    return 'utf16be'
  }
  return null
}

const decodeStrictUtf8 = (buffer: Buffer): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

// jschardet labels → iconv-lite names. The GB family is widened to GB18030
// (strict superset) so rare characters outside GB2312 still decode.
const normalizeDetectedEncoding = (label: string): string => {
  const lowered = label.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (lowered === 'gb2312' || lowered === 'gbk' || lowered === 'gb18030') {
    return 'gb18030'
  }
  return label.toLowerCase()
}

const guessLegacyEncoding = (buffer: Buffer): string => {
  const sample = buffer.subarray(0, DETECT_SNIFF_BYTES)
  const detected = jschardet.detect(sample)
  if (!detected?.encoding || detected.confidence < MIN_DETECT_CONFIDENCE) {
    return FALLBACK_ENCODING
  }
  const normalized = normalizeDetectedEncoding(detected.encoding)
  return iconv.encodingExists(normalized) ? normalized : FALLBACK_ENCODING
}

/** Decode a buffer for display: BOM first, strict UTF-8 next, guessed legacy encoding last. */
export const detectAndDecode = (buffer: Buffer): DetectedText => {
  const bom = sniffBomEncoding(buffer)
  if (bom === 'utf8bom') {
    return { content: buffer.subarray(UTF8_BOM.length).toString('utf8'), encoding: 'utf8bom' }
  }
  if (bom === 'utf16le' || bom === 'utf16be') {
    // iconv-lite strips the BOM during decode by default.
    return { content: iconv.decode(buffer, bom), encoding: bom }
  }

  const strict = decodeStrictUtf8(buffer)
  if (strict !== null) {
    return { content: strict, encoding: 'utf8' }
  }

  const encoding = guessLegacyEncoding(buffer)
  return { content: iconv.decode(buffer, encoding), encoding }
}

/** Decode on-disk bytes with a known encoding id (conflict probes must match the read path). */
export const decodeWithEncoding = (buffer: Buffer, encoding: string | undefined): string => {
  if (!encoding || encoding === 'utf8' || encoding === 'utf8bom') {
    // iconv utf8 decode strips a leading BOM, matching detectAndDecode output.
    return iconv.decode(buffer, 'utf8')
  }
  return iconv.encodingExists(encoding) ? iconv.decode(buffer, encoding) : iconv.decode(buffer, 'utf8')
}

/** Encode editor content back to the bytes the original file used, restoring BOMs. */
export const encodeForWrite = (content: string, encoding: string | undefined): Buffer => {
  if (!encoding || encoding === 'utf8') {
    return Buffer.from(content, 'utf8')
  }
  if (encoding === 'utf8bom') {
    return Buffer.concat([UTF8_BOM, Buffer.from(content, 'utf8')])
  }
  if (encoding === 'utf16le' || encoding === 'utf16be') {
    // These ids only come from BOM sniffing, so the rewritten file keeps its BOM.
    return iconv.encode(content, encoding, { addBOM: true })
  }
  return iconv.encodingExists(encoding) ? iconv.encode(content, encoding) : Buffer.from(content, 'utf8')
}
