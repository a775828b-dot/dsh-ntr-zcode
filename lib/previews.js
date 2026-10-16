import { posix, win32 } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';

export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
export const PREVIEW_CHUNK_BYTES = 256 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const fileTypes = { '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif' };
export const fileMediaType = name => fileTypes[posix.extname(String(name).replaceAll('\\', '/')).toLowerCase()] || 'application/octet-stream';
export const outputImageRef = id => `zcode-artifact://dsh/image/${id}`;
export function outputImages(content) {
  return (Array.isArray(content) ? content : []).filter(b => b.type === 'image'
    && /^sha256:[a-f0-9]{64}$/.test(b.attachment?.attachmentId) && imageTypes.has(b.attachment.mediaType));
}
export function imageMarkdown(content) {
  return outputImages(content).map(b => `![${String(b.attachment.name || 'DSH image').replace(/[\[\]\\\r\n]/g, '_')}](${outputImageRef(b.attachment.attachmentId)})`).join('\n\n');
}
export function fileMarkdown(content) {
  return (Array.isArray(content) ? content : []).filter(b => b.type === 'file' && /^sha256:[a-f0-9]{64}$/.test(b.attachment?.attachmentId))
    .map(b => `[DSH file: ${String(b.attachment.name || 'file').replace(/[\[\]\\\r\n]/g, '_')}](./__dsh_session_files__/${b.attachment.attachmentId.slice(7)}/${encodeURIComponent(b.attachment.name || 'file').replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)})`).join('\n\n');
}
export function previewResult(data, target, method, p, totalBytes = data.length) {
  const offset = p.offset ?? 0;
  if (method === 'readFileRange') return new Uint8Array(data);
  if (method === 'readTextFile') {
    const isBinary = data.includes(0);
    let content = '';
    try { if (!isBinary) content = new TextDecoder('utf-8', { fatal: true }).decode(data, { stream: offset + data.length < totalBytes }); }
    catch { throw new Error('File is not UTF-8 text'); }
    return { path: target, content, offset, bytesRead: data.length, totalBytes, truncated: offset + data.length < totalBytes, isBinary };
  }
  return { path: target, dataBase64: data.toString('base64'), totalBytes,
    ...(method === 'readMediaPreview' ? { mediaType: imageMediaType(data) } : {}) };
}
export function previewRange(p, method, bytes) {
  const offset = p.offset ?? 0;
  const length = p.length ?? (method === 'readTextFile' ? PREVIEW_CHUNK_BYTES : bytes);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0
    || length > PREVIEW_MAX_BYTES || (['readFileRange', 'readTextFile'].includes(method) && length > PREVIEW_CHUNK_BYTES)) throw new Error('Invalid preview range');
  if (p.maxBytes !== undefined && (!Number.isSafeInteger(p.maxBytes) || p.maxBytes < bytes)) throw new Error('Preview exceeds requested limit');
  return { offset, end: Math.min(bytes, offset + length) };
}
export function eventContent(event) {
  return event.type === 'user/message' ? event.data.content
    : ['assistant/message', 'tool/result'].includes(event.type) ? event.data.message?.content : [];
}
export function markdownLinks(content) {
  const links = new Set();
  for (const block of content ?? []) {
    if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length > 1024 * 1024) continue;
    const visit = node => {
      if (['link', 'image', 'definition'].includes(node.type)) links.add(node.url);
      for (const child of node.children ?? []) visit(child);
    };
    visit(fromMarkdown(block.text));
  }
  return links;
}

// Neither a guessed path nor a Markdown link grants access outside the shared root.
export function previewPath(root, input) {
  if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x1f]/.test(input)) throw new Error('Invalid preview path');
  let value = input;
  try { value = decodeURIComponent(value); } catch { throw new Error('Invalid path encoding'); }
  if (/[\x00-\x1f]/.test(value) || /^(?:file:|\\\\|\/\/|~)/i.test(value)) throw new Error('Unsupported preview path');
  const path = /^[a-z]:[\\/]/i.test(root) ? win32 : posix;
  if (path === win32 && /^\/[a-z]:\//i.test(value)) value = value.slice(1);
  value = value.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !(path === win32 && /^[a-z]:[\\/]/i.test(value))) throw new Error('Not a local file');
  const absolute = path.resolve(root, value);
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('File is outside the shared workspace');
  const parts = relative.split(/[\\/]/);
  if (parts.some(p => p.startsWith('.') || /[:\x00-\x1f]/.test(p) || /[. ]$/.test(p))) throw new Error('Hidden or special files are not exposed');
  return absolute;
}

export function imageMediaType(bytes) {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return 'image/gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Only PNG, JPEG, WebP and GIF previews are supported');
}
