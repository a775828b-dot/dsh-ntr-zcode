import QRCode from 'qrcode';
import { Relay } from './relay.js';
import { DshBackend } from './dsh.js';
import { RemoteHost } from './bridge.js';

export const name = 'dsh-ntr-zcode';
export const inject = ['connection', 'sessionController', 'workspaceController', 'commands'];
export const ROUTE = '/api/plugins/dsh-ntr-zcode/remote';

export function createControl(ctx) {
  let host, link = null, qr = null, selected = [], starting = false, disposed = false, intent = 0, allowPermissionChanges = false;
  const relay = new Relay({ onPayload: p => host?.accept(p), onStatus: status => {
    if (['error', 'stopped'].includes(status.state)) { host?.dispose(); link = qr = null; }
  } });
  const stop = () => { intent++; host?.dispose(); host = null; relay.stop(); link = qr = null; };
  const all = new DshBackend(ctx, null);
  async function status() {
    const workspaces = (await all.workspaces()).map(w => ({ id: w.workspaceId, title: w.title, path: w.path, sessions: w.sessionIds.length }));
    return { ...relay.status(), link, qr, selected, allowPermissionChanges,
      workspaces };
  }
  return {
    dispose() { disposed = true; stop(); all.dispose(); },
    async fetch(request) {
      const reply = (code, body) => Response.json(body, { status: code, headers: { 'cache-control': 'no-store' } });
      try {
        if (disposed) return reply(503, { error: 'Plugin stopped' });
        if (request.method === 'GET') return reply(200, await status());
        if (request.method !== 'POST') return reply(405, { error: 'GET/POST only' });
        if (!request.headers.get('content-type')?.startsWith('application/json')) return reply(415, { error: 'JSON required' });
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 8192) return reply(413, { error: 'Request too large' });
        let body;
        try { body = JSON.parse(raw); } catch { return reply(400, { error: 'Invalid JSON' }); }
        if (body?.action === 'stop') { stop(); return reply(200, await status()); }
        if (!['start', 'refresh'].includes(body?.action)) return reply(400, { error: 'Unknown action' });
        if (starting) return reply(409, { error: 'Pairing is already starting' });
        if (body.consent !== true) return reply(400, { error: 'Remote access consent required' });
        if (!Array.isArray(body.workspaces) || body.workspaces.length === 0 || body.workspaces.length > 20
          || body.workspaces.some(id => typeof id !== 'string')) return reply(400, { error: 'Select 1-20 workspaces' });
        const requestIntent = intent;
        const known = await all.workspaces();
        if (body.workspaces.some(id => !known.some(w => w.workspaceId === id))) return reply(400, { error: 'Workspace not found' });
        if (disposed) return reply(503, { error: 'Plugin stopped' });
        if (requestIntent !== intent) return reply(409, { error: 'Pairing request was superseded' });
        if (starting) return reply(409, { error: 'Pairing is already starting' });
        starting = true;
        try {
          stop();
          selected = [...new Set(body.workspaces)];
          allowPermissionChanges = body.allowPermissionChanges === true;
          const backend = new DshBackend(ctx, selected, allowPermissionChanges);
          // Relay.start calls stop internally; create the host after initial reset.
          const start = relay.start();
          const remote = new RemoteHost(backend, p => relay.payload(p), undefined, () => {
            if (host !== remote) return;
            stop();
            relay.setState('error', 'DSH subscription failed; refresh pairing');
          });
          host = remote;
          await start;
          if (disposed || relay.state === 'stopped') throw new Error('Pairing stopped');
          const generation = relay.generation;
          const nextLink = relay.link();
          const nextQr = await QRCode.toDataURL(nextLink, { width: 320, margin: 3, errorCorrectionLevel: 'M' });
          if (!disposed && relay.generation === generation) { link = nextLink; qr = nextQr; }
        } finally { starting = false; }
        return reply(200, await status());
      } catch { return reply(503, { error: 'Remote pairing unavailable. Check DSH desktop and network, then retry.' }); }
    },
  };
}

export function apply(ctx) {
  const control = createControl(ctx);
  ctx.effect(() => () => control.dispose(), 'Dsh ntr Zcode: close remote connections');
  ctx.effect(() => ctx.connection.fetch.register({ path: ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: request => control.fetch(request) }), 'Dsh ntr Zcode: authenticated remote control');
}
