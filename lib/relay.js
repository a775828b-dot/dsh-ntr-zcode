import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

export const RELAY = 'wss://zcode.z.ai/ws';
export const WEB = 'https://zcode.z.ai/remote/v4';

// Pairing secrets are memory-only. Restart/refresh never reuses an old QR code.
export class Relay {
  constructor({ onPayload, onStatus = () => {}, WebSocketCtor = WebSocket }) {
    Object.assign(this, { onPayload, onStatus, WebSocketCtor });
    this.state = 'stopped';
    this.generation = 0;
  }
  status() { return { state: this.state, error: this.error ?? null }; }
  setState(state, error) {
    this.state = state;
    this.error = error;
    this.onStatus(this.status());
  }
  async start() {
    this.stop();
    const generation = this.generation;
    this.mid = `dsh-ntr-zcode-${randomUUID()}`;
    this.hash = createHash('sha256').update(randomBytes(32)).digest('base64');
    this.setState('connecting');
    const ws = this.socket = new this.WebSocketCtor(`${RELAY}?mid=${encodeURIComponent(this.mid)}`);
    const active = () => generation === this.generation && this.socket === ws;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(this.connectTimer);
        if (error) reject(new Error(error)); else resolve(this.status());
      };
      this.cancelStart = () => finish('Pairing stopped');
      const fail = error => {
        if (!active()) return;
        finish(error);
        this.stop();
        this.setState('error', error);
      };
      this.connectTimer = setTimeout(() => fail('Relay authentication timed out'), 20000);
      ws.addEventListener('open', () => {
        if (!active()) return;
        this.send({ type: 'device_register_init', device_mid: this.mid, pass_hash: this.hash,
          meta: { platform: process.platform, version: '0.4.1', name: 'Dsh ntr Zcode' } });
      });
      ws.addEventListener('message', async event => {
        if (!active()) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) throw new Error();
          const message = JSON.parse(event.data);
          this.lastReceived = Date.now();
          if (message.type === 'device_register_ack') {
            if (typeof message.device_sid !== 'string' || !message.device_sid) throw new Error();
            this.sid = message.device_sid;
            this.send({ type: 'auth_init', role: 'device', device_sid: this.sid,
              meta: { platform: process.platform, version: '0.4.1', name: 'Dsh ntr Zcode' } });
          } else if (message.type === 'auth_challenge') {
            if (!this.sid || typeof message.nonce !== 'string') throw new Error();
            this.send({ type: 'auth_response', device_sid: this.sid,
              proof: createHmac('sha256', this.hash).update(`${message.nonce}|device|${this.sid}`).digest('base64url') });
          } else if (message.type === 'auth_ack' || message.type === 'pair_status_ack') {
            this.setState(message.pair_status === 'matched' ? 'connected' : 'waiting');
            if (message.type === 'auth_ack') {
              clearInterval(this.heartbeat);
              this.heartbeat = setInterval(() => {
                if (Date.now() - this.lastReceived > 30000) return fail('Relay heartbeat timed out; refresh pairing');
                this.send({ type: 'pair_status_query', device_sid: this.sid });
              }, 10000);
              finish();
            }
          } else if (message.type === 'data') {
            if (this.state !== 'connected') return;
            await this.onPayload(message.payload);
          } else if (message.type === 'error') {
            // The official relay can report INTERNAL while the phone reloads.
            // Retain device pairing, suspend business frames and recheck status.
            if (message.code === 'INTERNAL' && ['connected', 'waiting'].includes(this.state)) {
              this.setState('waiting');
              this.send({ type: 'pair_status_query', device_sid: this.sid });
            } else fail('Relay rejected the connection');
          }
        } catch { fail('Remote protocol error; refresh pairing'); }
      });
      ws.addEventListener('error', () => fail('Relay connection failed'));
      ws.addEventListener('close', () => fail('Relay connection closed; refresh pairing'));
    });
  }
  send(message) {
    if (this.socket?.readyState !== 1) return false;
    this.socket.send(JSON.stringify({ ...message, client_ts: Date.now() }));
    return true;
  }
  payload(payload) { return this.state === 'connected' && this.send({ type: 'data', payload }); }
  link() {
    if (!this.sid || !['waiting', 'connected'].includes(this.state)) return null;
    return `${WEB}?${new URLSearchParams({ sid: this.sid, hash: this.hash, mid: this.mid,
      t: String(Date.now()), name: 'Dsh ntr Zcode' })}`;
  }
  stop() {
    this.generation++;
    clearTimeout(this.connectTimer);
    clearInterval(this.heartbeat);
    this.cancelStart?.();
    this.cancelStart = null;
    const socket = this.socket;
    this.socket = null;
    if (socket?.readyState < 2) socket.close();
    this.sid = this.hash = this.mid = null;
    this.setState('stopped');
  }
}
