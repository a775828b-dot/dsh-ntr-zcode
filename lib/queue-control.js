// Queue contents remain in DSH's durable Inbox. Only the admission gate is local.
export class QueueControl {
  constructor(ctx) {
    this.states = new Map();
    this.locks = new Map();
    this.off = ctx.on('session/event', (session, event) => {
      const state = this.states.get(session.id);
      if (event.type === 'turn/start' && state?.agent.session === session && !state.autoDrain) {
        // turn/start precedes Inbox.claim: park the next turn without taking its input.
        state.agent.cancel({ kind: 'user' }, { keepInbox: true });
      }
    }, { global: true });
  }
  state(agent) {
    let state = this.states.get(agent.id);
    if (!state || state.agent !== agent) {
      state = { agent, autoDrain: true };
      this.states.set(agent.id, state);
    }
    return state;
  }
  autoDrain(id) { return this.states.get(id)?.autoDrain ?? true; }
  async lock(id, job) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(job);
    this.locks.set(id, current);
    try { return await current; }
    finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
  reorder(agent, id, before) {
    const items = [...agent.inbox.nextTurn];
    const index = items.findIndex(m => m.id === id);
    if (index < 0 || (before !== null && !items.some(m => m.id === before))) throw new Error('Queue item is no longer pending');
    if (id === before) return;
    const [item] = items.splice(index, 1);
    items.splice(before === null ? items.length : items.findIndex(m => m.id === before), 0, item);
    if (items.every((m, i) => agent.inbox.nextTurn[i].id === m.id)) return;
    // A single durable splice retains message identities, source receipts and attachments.
    agent.inbox.splice('next-turn', 0, items.length, items);
  }
  wake(agent) {
    if (agent.status === 'running') return;
    const last = agent.inbox.nextTurn.at(-1);
    if (!last) return;
    // Re-submit the tail through the public wake API, preserving FIFO ordering.
    agent.inbox.remove(last.id);
    try { agent.send(last, 'next-turn', true); }
    catch (error) {
      if (!agent.inbox.nextTurn.some(m => m.id === last.id)) agent.inbox.append('next-turn', last);
      throw error;
    }
  }
  dispose() {
    for (const state of this.states.values()) if (!state.autoDrain) state.agent.cancel({ kind: 'user' }, { keepInbox: true });
    this.off(); this.states.clear();
  }
}
