import { createHash, randomUUID } from 'node:crypto';
import { v4AttachmentBeginParamsSchema, v4AttachmentChunkParamsSchema,
  v4AttachmentCommitParamsSchema, v4AttachmentAbortParamsSchema } from './zcode-wire.js';

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const TOTAL_MAX_BYTES = 24 * 1024 * 1024;
const TTL = 10 * 60 * 1000;
const types = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const imageRef = id => `dsh-image:${id}`;
export function imageAttachments(content) {
  return (Array.isArray(content) ? content : []).filter(b => ['image', 'file'].includes(b.type) && b.attachment?.attachmentId).map(b => ({
    ref: b.type === 'image' ? imageRef(b.attachment.attachmentId) : `dsh-file:${b.attachment.attachmentId}`, fileName: b.attachment.name || b.type,
    mime: b.attachment.mediaType || 'application/octet-stream', bytes: b.attachment.bytes,
  }));
}
function matchesType(bytes, mime) {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
}

// Uploads are scoped to a pairing, workspace and session, never filesystem paths.
// DSH performs full image decoding/normalization and durable storage on prompt.
export class ImageUploads {
  constructor({ allowFiles = false } = {}) { this.items = new Map(); this.allowFiles = allowFiles; }
  clear() { this.items.clear(); }
  prune() { for (const [key, value] of this.items) if (value.expires <= Date.now()) this.items.delete(key); }
  key(path, p) { return JSON.stringify([path, p.sessionId, p.uploadId]); }
  handle(method, path, raw) {
    this.prune();
    const schema = { attachmentBeginV4: v4AttachmentBeginParamsSchema, attachmentChunkV4: v4AttachmentChunkParamsSchema,
      attachmentCommitV4: v4AttachmentCommitParamsSchema, attachmentAbortV4: v4AttachmentAbortParamsSchema }[method];
    const p = schema.parse(raw), key = this.key(path, p);
    let item = this.items.get(key);
    if (method === 'attachmentBeginV4') {
      if ((!types.has(p.mime) && (!this.allowFiles || p.mime.startsWith('image/'))) || p.totalBytes < 1 || p.totalBytes > IMAGE_MAX_BYTES || p.totalChunks > 64) throw new Error('Attachment type or 8 MiB size limit exceeded');
      if (item && JSON.stringify(item.begin) !== JSON.stringify(p)) throw new Error('Upload ID reused with different metadata');
      if (!item) {
        if (this.items.size >= 32 || [...this.items.values()].reduce((n, v) => n + v.begin.totalBytes, 0) + p.totalBytes > TOTAL_MAX_BYTES) throw new Error('Image upload quota reached');
        item = { begin: p, path, sessionId: p.sessionId, chunks: [], received: 0, expires: Date.now() + TTL };
        this.items.set(key, item);
      }
      return { uploadId: p.uploadId, state: item.ref ? 'committed' : 'staging', nextChunkIndex: item.chunks.length, ...(item.ref ? { ref: item.ref } : {}) };
    }
    if (method === 'attachmentAbortV4') { this.items.delete(key); return {}; }
    if (!item) throw new Error('Image upload expired; attach the image again');
    if (item.begin.connectionId !== p.connectionId) throw new Error('Upload connection mismatch');
    if (method === 'attachmentChunkV4') {
      const bytes = Buffer.from(p.dataBase64, 'base64');
      if (item.chunks[p.chunkIndex]) {
        if (!item.chunks[p.chunkIndex].equals(bytes)) throw new Error('Chunk retry content mismatch');
      } else {
        if (item.ref || p.chunkIndex !== item.chunks.length || p.chunkIndex >= item.begin.totalChunks || !bytes.length || item.received + bytes.length > item.begin.totalBytes) throw new Error('Invalid image chunk sequence or size');
        item.chunks.push(bytes); item.received += bytes.length;
      }
      return { uploadId: p.uploadId, nextChunkIndex: p.chunkIndex + 1 };
    }
    if (!item.ref) {
      const bytes = Buffer.concat(item.chunks);
      if (item.chunks.length !== item.begin.totalChunks || bytes.length !== item.begin.totalBytes
        || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== item.begin.checksum || (types.has(item.begin.mime) && !matchesType(bytes, item.begin.mime))) throw new Error('Image checksum, format or size mismatch');
      item.ref = `dsh-upload:${randomUUID()}`;
    }
    return { ref: item.ref };
  }
  resolve(path, sessionId, refs = []) {
    this.prune();
    if (!Array.isArray(refs) || refs.length > 4) throw new Error('Send at most four images at a time');
    return refs.map(ref => {
      const item = [...this.items.values()].find(v => v.ref && v.ref === ref.ref && v.path === path && v.sessionId === sessionId);
      if (!item || ref.mime !== item.begin.mime || ref.bytes !== item.begin.totalBytes || ref.fileName !== item.begin.fileName || ref.sourceKind || ref.previewRef) throw new Error('Image is not an uploaded attachment of this session');
      return { type: types.has(item.begin.mime) ? 'image' : 'file-upload', mediaType: item.begin.mime, data: Buffer.concat(item.chunks).toString('base64'), name: item.begin.fileName };
    });
  }
  release(path, sessionId, refs = []) {
    const sent = new Set(refs.map(ref => ref.ref));
    for (const [key, item] of this.items) if (item.path === path && item.sessionId === sessionId && sent.has(item.ref)) this.items.delete(key);
  }
}
