import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Relay } from '../lib/relay.js';

class Socket extends EventTarget {
  static instances = [];
  readyState = 0;
  sent = [];
  constructor(url) { super(); this.url = url; Socket.instances.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  receive(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
async function connected(relay) {
  const ready = relay.start();
  const socket = Socket.instances.at(-1);
  socket.open();
  socket.receive({ type: 'device_register_ack', device_sid: 'synthetic-sid' });
  socket.receive({ type: 'auth_challenge', nonce: 'nonce' });
  socket.receive({ type: 'auth_ack', pair_status: 'waiting' });
  await ready;
  return socket;
}
test('auth proof uses official hash-string HMAC and no payload before matching', async () => {
  const payloads = [];
  const relay = new Relay({ WebSocketCtor: Socket, onPayload: p => payloads.push(p) });
  try {
    const s = await connected(relay);
    const hash = s.sent[0].pass_hash;
    assert.equal(s.sent.find(m => m.type === 'auth_response').proof, createHmac('sha256', hash).update('nonce|device|synthetic-sid').digest('base64url'));
    s.receive({ type: 'data', payload: { test: true } }); assert.equal(payloads.length, 0);
    s.receive({ type: 'pair_status_ack', pair_status: 'matched' });
    s.receive({ type: 'data', payload: { test: true } }); assert.equal(payloads.length, 1);
  } finally { relay.stop(); }
});
test('refresh rotates credentials and late old frames cannot access the new pairing', async () => {
  let received = 0;
  const relay = new Relay({ WebSocketCtor: Socket, onPayload: () => { received++; } });
  try {
    const first = await connected(relay); const old = relay.link();
    await connected(relay); const next = relay.link();
    assert.notEqual(new URL(old).searchParams.get('mid'), new URL(next).searchParams.get('mid'));
    assert.notEqual(new URL(old).searchParams.get('hash'), new URL(next).searchParams.get('hash'));
    first.receive({ type: 'pair_status_ack', pair_status: 'matched' }); first.receive({ type: 'data', payload: {} });
    assert.equal(received, 0); assert.equal(first.readyState, 3);
    relay.stop(); assert.equal(relay.link(), null); assert.equal(relay.state, 'stopped');
  } finally { relay.stop(); }
});
test('stop cancels an in-flight start and does not leave timers/sockets alive', async () => {
  const relay = new Relay({ WebSocketCtor: Socket, onPayload: () => {} });
  const start = relay.start(); relay.stop();
  await assert.rejects(start, /stopped/);
  assert.equal(Socket.instances.at(-1).readyState, 3); assert.equal(relay.link(), null);
});
