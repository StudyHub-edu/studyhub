// Shared app state + a very small event bus so views can react to live updates.
import { api } from './api.js';

export const state = {
  me: null,
  users: new Map(),      // id -> public user
  channels: [],
  unread: {},            // conversation id -> unread count
  dms: [],               // [{ cid, userId, lastAt, lastText }]
  notifications: [],
  subjects: [],
  reactions: [],
  colors: [],
  online: new Set(),
  current: null,         // conversation currently open in the chat view
  socket: null,
};

const listeners = new Map();

export const bus = {
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },
  emit(event, data) {
    for (const fn of [...(listeners.get(event) || [])]) {
      try { fn(data); } catch (err) { console.error(err); }
    }
  },
};

/** Collects subscriptions so a view can drop them all when it closes. */
export function subscribe() {
  const offs = [];
  return {
    on(event, fn) { offs.push(bus.on(event, fn)); },
    off() { offs.splice(0).forEach((off) => off()); },
  };
}

export const dmId = (a, b) => 'dm-' + [a, b].sort().join('-');
export const userOf = (id) => state.users.get(id);
export const totalUnread = () => Object.values(state.unread).reduce((sum, n) => sum + n, 0);

export function markRead(cid) {
  if (state.unread[cid]) {
    state.unread[cid] = 0;
    bus.emit('unread:changed');
  }
  api(`/conversations/${cid}/read`, { method: 'POST' }).catch(() => {});
}
