// Group chat: channels + private messages, live updates, replies, reactions, edit/delete, typing and @mentions.
import { state, subscribe, dmId, markRead } from '../state.js';
import { api } from '../api.js';
import {
  h, icon, avatar, avatarStatus, roleBadge, userName, richText, formatTime, formatDay, sameDay,
  toast, confirmDialog, openModal, showPopover, closePopover, emptyState, errorState, loadingState, field,
} from '../ui.js?v=3';

const EMOJIS = ['😀', '😄', '😂', '🤣', '😊', '😉', '😍', '🤩', '😎', '🤔', '😅', '😢', '😭', '😮', '🙄', '😴', '🤯', '🥳',
  '👍', '👎', '👏', '🙌', '🙏', '💪', '👀', '🔥', '✨', '💡', '📚', '✏️', '📝', '🎓', '🧠', '🔬', '🧪', '💻',
  '📐', '❤️', '💯', '✅', '❌', '⭐', '🎉', '☕'];
const CHANNEL_EMOJIS = ['💬', '📚', '📐', '🔬', '💻', '✍️', '🎨', '🎵', '⚽', '🌍', '🧪', '🎮', '💡', '🧠'];

function resolveConv(cid) {
  if (!cid) return null;
  if (cid.startsWith('dm-')) {
    const parts = cid.split('-');
    if (parts.length !== 3 || !parts.includes(state.me.id) || parts[1] >= parts[2]) return null;
    const otherId = parts[1] === state.me.id ? parts[2] : parts[1];
    const other = state.users.get(otherId);
    return other ? { type: 'dm', other } : null;
  }
  const channel = state.channels.find((c) => c.id === cid);
  return channel ? { type: 'channel', channel } : null;
}

export function mountChat(container, requestedCid) {
  let cid = requestedCid;
  if (!cid) {
    const last = localStorage.getItem('sh_last_chat');
    cid = last && resolveConv(last)
      ? last
      : (state.channels.find((c) => c.name === 'general') || state.channels[0] || {}).id;
  }
  const conv = resolveConv(cid);
  if (!conv) {
    container.append(h('div', { class: 'page narrow' },
      emptyState('chat', 'Conversation not found', 'It may have been deleted, or the link is wrong.',
        h('a', { class: 'btn primary', href: '#/chat/general' }, 'Go to general'))));
    return () => {};
  }
  if (cid !== requestedCid) history.replaceState(null, '', '#/chat/' + cid);
  localStorage.setItem('sh_last_chat', cid);
  state.current = cid;

  const me = state.me;
  const sub = subscribe();
  const isChannel = conv.type === 'channel';

  /* ---------------- state ---------------- */
  let messages = [];
  let hasMore = false;
  let loading = true;
  let pending = [];           // live messages that arrive while history is still loading
  let replyTo = null;
  let editingId = null;
  let sending = false;
  let lastTypingSent = 0;
  const els = new Map();      // message id -> element
  const typers = new Map();   // user id -> timeout

  /* ---------------- layout ---------------- */
  const side = h('aside', { class: 'chat-side', 'aria-label': 'Conversations' });
  const backdrop = h('div', { class: 'side-backdrop', onclick: () => root.classList.remove('side-open') });
  const main = h('section', { class: 'chat-main' });
  const root = h('div', { class: 'chat' }, side, backdrop, main);

  const list = h('div', { class: 'msg-list' });
  const loadMoreBtn = h('button', { class: 'btn small load-more hidden', type: 'button', onclick: loadOlder }, 'Load earlier messages');
  const scroller = h('div', { class: 'messages', tabindex: '-1', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages' }, loadMoreBtn, list);
  const newPill = h('button', { class: 'new-pill hidden', type: 'button', onclick: () => scrollToBottom() }, icon('down', 16), 'New messages');
  const typingEl = h('div', { class: 'typing', 'aria-live': 'polite' });

  const replyBar = h('div', { class: 'reply-bar hidden' });
  const mentionBox = h('div', { class: 'mention-box hidden', role: 'listbox', 'aria-label': 'Mention someone' });
  const input = h('textarea', {
    class: 'composer-input', rows: 1, maxlength: '2000', 'aria-label': 'Write a message',
    placeholder: isChannel ? `Message #${conv.channel.name}` : `Message ${conv.other.name}`,
  });
  const emojiBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Add emoji', title: 'Add emoji', onclick: openEmoji }, icon('smile', 20));
  const sendBtn = h('button', { class: 'send-btn', type: 'button', 'aria-label': 'Send message', title: 'Send', onclick: send }, icon('send', 18));
  const composer = h('div', { class: 'composer' }, replyBar, mentionBox, h('div', { class: 'composer-row' }, emojiBtn, input, sendBtn));

  const statusEl = h('span', { class: 'head-status' });
  const headEl = h('header', { class: 'chat-head' });

  main.append(headEl, h('div', { class: 'messages-wrap' }, scroller, newPill), typingEl, composer);
  container.append(root);

  /* ---------------- header + sidebar ---------------- */
  const onlineNow = () => {
    let n = 0;
    for (const id of state.online) { const u = state.users.get(id); if (u && !u.bot) n += 1; }
    return n;
  };

  function updateStatus() {
    if (isChannel) {
      const n = onlineNow();
      statusEl.textContent = `${n} online`;
      statusEl.classList.toggle('on', n > 0);
    }
    else {
      const on = state.online.has(conv.other.id);
      statusEl.textContent = on ? 'Online' : 'Offline';
      statusEl.classList.toggle('on', on);
    }
  }

  function renderHeader() {
    const canDelete = isChannel && !conv.channel.locked && (conv.channel.createdBy === me.id || me.role === 'teacher');
    headEl.replaceChildren(
      h('button', { class: 'icon-btn side-toggle', type: 'button', 'aria-label': 'Show conversations', onclick: () => root.classList.add('side-open') }, icon('menu')),
      isChannel
        ? h('span', { class: 'ch-emoji big', 'aria-hidden': 'true' }, conv.channel.emoji)
        : avatarStatus(conv.other, 38),
      h('div', { class: 'head-text' },
        isChannel
          ? h('h1', null, '#' + conv.channel.name)
          : h('h1', null, conv.other.name, roleBadge(conv.other)),
        isChannel && conv.channel.description ? h('p', null, conv.channel.description) : null),
      h('div', { class: 'head-actions' },
        h('span', { class: 'head-pill' }, h('span', { class: 'live-dot' }), statusEl),
        canDelete ? h('button', { class: 'icon-btn', type: 'button', title: 'Delete channel', 'aria-label': 'Delete channel', onclick: deleteChannel }, icon('trash')) : null));
    updateStatus();
  }

  function unreadBadge(id) {
    const n = state.unread[id] || 0;
    return n ? h('span', { class: 'count', 'aria-label': n + ' unread' }, n > 99 ? '99+' : n) : null;
  }

  function renderSide() {
    const channels = [...state.channels].sort((a, b) => (b.locked - a.locked) || a.name.localeCompare(b.name));
    const dms = [...state.dms];
    if (!isChannel && !dms.some((d) => d.cid === cid)) dms.unshift({ cid, userId: conv.other.id, lastAt: Date.now() });

    side.replaceChildren(
      h('div', { class: 'side-head' },
        h('h2', null, 'Conversations'),
        h('button', { class: 'icon-btn side-close', type: 'button', 'aria-label': 'Close', onclick: () => root.classList.remove('side-open') }, icon('x'))),
      h('div', { class: 'side-scroll' },
        h('div', { class: 'side-title' },
          h('span', null, 'Channels'),
          h('button', { class: 'icon-btn small', type: 'button', title: 'Create a channel', 'aria-label': 'Create a channel', onclick: openCreateChannel }, icon('plus', 16))),
        h('nav', { 'aria-label': 'Channels' }, channels.map((c) =>
          h('a', { class: 'side-item' + (c.id === cid ? ' active' : '') + (state.unread[c.id] ? ' unread' : ''), href: '#/chat/' + c.id },
            h('span', { class: 'ch-emoji', 'aria-hidden': 'true' }, c.emoji),
            h('span', { class: 'side-name' }, c.name),
            unreadBadge(c.id)))),
        h('div', { class: 'side-title' },
          h('span', null, 'Direct messages'),
          h('button', { class: 'icon-btn small', type: 'button', title: 'New message', 'aria-label': 'New direct message', onclick: openNewDM }, icon('plus', 16))),
        h('nav', { 'aria-label': 'Direct messages' }, dms.length
          ? dms.map((d) => {
            const u = state.users.get(d.userId);
            return h('a', { class: 'side-item' + (d.cid === cid ? ' active' : '') + (state.unread[d.cid] ? ' unread' : ''), href: '#/chat/' + d.cid },
              avatarStatus(u, 24),
              h('span', { class: 'side-name' }, u ? u.name : 'Someone'),
              unreadBadge(d.cid));
          })
          : h('p', { class: 'side-empty' }, 'Start a private chat with a classmate or teacher.'))));
  }

  /* ---------------- messages ---------------- */
  const isNearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;

  function scrollToBottom() {
    scroller.scrollTop = scroller.scrollHeight;
    newPill.classList.add('hidden');
  }

  function iconBtn(name, label, handler) {
    return h('button', { class: 'icon-btn small', type: 'button', title: label, 'aria-label': label, onclick: handler }, icon(name, 15));
  }

  function messageEl(m, prev) {
    if (m.system) return h('div', { class: 'msg-system', dataset: { id: m.id } }, h('span', null, m.text));

    const u = state.users.get(m.userId);
    const mine = m.userId === me.id;
    const compact = !!prev && !prev.system && prev.userId === m.userId && !m.reply
      && m.createdAt - prev.createdAt < 5 * 60 * 1000 && sameDay(prev.createdAt, m.createdAt);
    const mentioned = !m.deleted && new RegExp('(^|[^\\w])@' + me.username + '\\b', 'i').test(m.text);

    const el = h('div', {
      class: 'msg' + (compact ? ' compact' : '') + (mine ? ' mine' : '') + (mentioned ? ' mentioned' : '') + (m.deleted ? ' is-deleted' : ''),
      dataset: { id: m.id },
      onclick: (e) => {
        if (window.matchMedia('(hover: none)').matches && !e.target.closest('a, button, textarea')) el.classList.toggle('show-actions');
      },
    });

    const gutter = compact
      ? h('div', { class: 'msg-gutter' }, h('span', { class: 'gutter-time' }, formatTime(m.createdAt)))
      : h('div', { class: 'msg-gutter' }, h('a', { href: '#/user/' + m.userId, class: 'avatar-link', 'aria-label': (u ? u.name : 'Someone') + ' profile' }, avatar(u, 38)));

    const head = compact ? null : h('div', { class: 'msg-head' },
      h('a', { class: 'msg-name', href: '#/user/' + m.userId }, u ? u.name : 'Someone'),
      roleBadge(u),
      h('time', { datetime: new Date(m.createdAt).toISOString() }, formatTime(m.createdAt)),
      m.editedAt && !m.deleted ? h('span', { class: 'edited' }, '(edited)') : null);

    const quote = m.reply ? h('button', { class: 'reply-quote', type: 'button', onclick: () => jumpTo(m.reply.id) },
      icon('reply', 13), h('strong', null, userName(m.reply.userId)),
      h('span', null, m.reply.deleted ? 'Deleted message' : m.reply.text)) : null;

    const text = m.deleted
      ? h('div', { class: 'msg-text deleted' }, 'This message was deleted')
      : h('div', { class: 'msg-text' }, richText(m.text));

    const reactionEntries = Object.entries(m.reactions || {});
    const reactions = reactionEntries.length ? h('div', { class: 'reactions' }, reactionEntries.map(([emoji, ids]) =>
      h('button', {
        class: 'reaction' + (ids.includes(me.id) ? ' mine' : ''), type: 'button',
        title: ids.map(userName).join(', '), 'aria-label': `${emoji} ${ids.length}`,
        onclick: () => react(m.id, emoji),
      }, emoji, h('span', null, ids.length)))) : null;

    const canDelete = mine || (isChannel && me.role === 'teacher');
    const actions = m.deleted ? null : h('div', { class: 'msg-actions', role: 'toolbar', 'aria-label': 'Message actions' },
      iconBtn('smile', 'Add reaction', (e) => openReactionPicker(e.currentTarget, m)),
      iconBtn('reply', 'Reply', () => startReply(m)),
      mine ? iconBtn('edit', 'Edit', () => startEdit(m, el)) : null,
      canDelete ? iconBtn('trash', 'Delete', () => deleteMessage(m)) : null);

    el.append(gutter, h('div', { class: 'msg-body' }, head, quote, text, reactions), actions);
    return el;
  }

  function appendEl(m, prev) {
    if (!prev || !sameDay(prev.createdAt, m.createdAt)) {
      list.append(h('div', { class: 'day-divider', role: 'separator' }, h('span', null, formatDay(m.createdAt))));
    }
    const el = messageEl(m, prev);
    els.set(m.id, el);
    list.append(el);
  }

  function replaceEl(index) {
    const m = messages[index];
    const old = els.get(m.id);
    if (!old) return;
    const fresh = messageEl(m, messages[index - 1]);
    old.replaceWith(fresh);
    els.set(m.id, fresh);
  }

  function renderAll() {
    list.replaceChildren();
    els.clear();
    if (!messages.length) {
      list.append(h('div', { class: 'chat-empty' }, icon('chat', 30), h('h3', null, 'No messages yet'),
        h('p', null, isChannel ? 'Be the first to say something in #' + conv.channel.name + '.' : 'Say hello to ' + conv.other.name + '.')));
    }
    let prev = null;
    for (const m of messages) { appendEl(m, prev); prev = m; }
    loadMoreBtn.classList.toggle('hidden', !hasMore);
  }

  function addMessage(m, { forceScroll = false } = {}) {
    if (m.cid !== cid) return;
    if (loading) { pending.push(m); return; }
    if (messages.some((x) => x.id === m.id)) return;
    const stick = isNearBottom();
    const prev = messages[messages.length - 1];
    messages.push(m);
    const empty = list.querySelector('.chat-empty');
    if (empty) empty.remove();
    appendEl(m, prev);
    clearTyper(m.userId);
    if (forceScroll || stick || m.userId === me.id) scrollToBottom();
    else newPill.classList.remove('hidden');
  }

  function applyUpdate(m) {
    if (m.cid !== cid) return;
    const index = messages.findIndex((x) => x.id === m.id);
    if (index < 0) return;
    messages[index] = m;
    if (editingId !== m.id) replaceEl(index);
    // keep quoted previews in other messages up to date
    messages.forEach((x, i) => {
      if (x.reply && x.reply.id === m.id) {
        x.reply = { ...x.reply, deleted: m.deleted, text: m.deleted ? '' : m.text.slice(0, 140) };
        replaceEl(i);
      }
    });
  }

  function jumpTo(id) {
    const el = els.get(id);
    if (!el) { toast('That message is older. Use "Load earlier messages" to see it.'); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  }

  async function loadInitial() {
    loading = true;
    list.replaceChildren(loadingState('Loading messages...'));
    try {
      const r = await api(`/conversations/${cid}/messages?limit=50`);
      messages = r.messages;
      hasMore = r.hasMore;
      loading = false;
      renderAll();
      scrollToBottom();
      const queued = pending;
      pending = [];
      queued.forEach((m) => addMessage(m));
      markRead(cid);
    } catch (err) {
      loading = false;
      list.replaceChildren(errorState(err.message, loadInitial));
    }
  }

  async function loadOlder() {
    const before = messages[0] && messages[0].createdAt;
    if (!before) return;
    loadMoreBtn.disabled = true;
    try {
      const r = await api(`/conversations/${cid}/messages?limit=50&before=${before}`);
      const oldHeight = scroller.scrollHeight;
      const oldTop = scroller.scrollTop;
      messages = [...r.messages, ...messages];
      hasMore = r.hasMore;
      renderAll();
      scroller.scrollTop = scroller.scrollHeight - oldHeight + oldTop;
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      loadMoreBtn.disabled = false;
    }
  }

  /* ---------------- message actions ---------------- */
  async function react(id, emoji) {
    try {
      const r = await api(`/messages/${id}/react`, { method: 'POST', body: { emoji } });
      applyUpdate(r.message);
    } catch (err) { toast(err.message, 'error'); }
  }

  function openReactionPicker(anchor, m) {
    const pop = h('div', { class: 'reaction-picker' }, state.reactions.map((emoji) =>
      h('button', { class: 'emoji-btn', type: 'button', 'aria-label': 'React with ' + emoji, onclick: () => { closePopover(); react(m.id, emoji); } }, emoji)));
    showPopover(anchor, pop);
  }

  async function deleteMessage(m) {
    const ok = await confirmDialog('This message will be removed for everyone.', { title: 'Delete message', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try {
      const r = await api('/messages/' + m.id, { method: 'DELETE' });
      applyUpdate(r.message);
    } catch (err) { toast(err.message, 'error'); }
  }

  function startEdit(m, el) {
    if (editingId) cancelEdit();
    const textEl = el.querySelector('.msg-text');
    if (!textEl) return;
    editingId = m.id;
    const ta = h('textarea', { class: 'edit-input', rows: 2, maxlength: '2000', 'aria-label': 'Edit message' });
    ta.value = m.text;
    const save = async () => {
      const text = ta.value.trim();
      if (!text) { toast('A message cannot be empty. Use delete instead.', 'error'); return; }
      if (text === m.text) { cancelEdit(); return; }
      try {
        const r = await api('/messages/' + m.id, { method: 'PATCH', body: { text } });
        editingId = null;
        applyUpdate(r.message);
      } catch (err) { toast(err.message, 'error'); }
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
    });
    textEl.replaceWith(h('div', { class: 'editor' }, ta,
      h('div', { class: 'editor-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: cancelEdit }, 'Cancel'),
        h('button', { class: 'btn small primary', type: 'button', onclick: save }, 'Save'),
        h('span', { class: 'hint' }, 'Esc to cancel, Enter to save'))));
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function cancelEdit() {
    const id = editingId;
    editingId = null;
    const index = messages.findIndex((x) => x.id === id);
    if (index >= 0) replaceEl(index);
  }

  /* ---------------- composer ---------------- */
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  function startReply(m) {
    replyTo = m;
    replyBar.classList.remove('hidden');
    replyBar.replaceChildren(
      icon('reply', 15),
      h('span', { class: 'reply-bar-text' }, 'Replying to ', h('strong', null, userName(m.userId)), ': ', m.text.slice(0, 90)),
      h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Cancel reply', onclick: clearReply }, icon('x', 15)));
    input.focus();
  }

  function clearReply() {
    replyTo = null;
    replyBar.classList.add('hidden');
    replyBar.replaceChildren();
  }

  async function send() {
    const text = input.value.trim();
    if (!text || sending) return;
    sending = true;
    const reply = replyTo;
    input.value = '';
    autosize();
    clearReply();
    hideMention();
    try {
      const r = await api(`/conversations/${cid}/messages`, { method: 'POST', body: { text, replyTo: reply ? reply.id : undefined } });
      addMessage(r.message, { forceScroll: true });
    } catch (err) {
      toast(err.message, 'error');
      input.value = text;
      autosize();
      if (reply) startReply(reply);
    } finally {
      sending = false;
      input.focus();
    }
  }

  function insertAtCursor(text) {
    input.focus();
    input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
    autosize();
  }

  function openEmoji(e) {
    const grid = h('div', { class: 'emoji-grid' }, EMOJIS.map((em) =>
      h('button', { class: 'emoji-btn', type: 'button', 'aria-label': em, onclick: () => { closePopover(); insertAtCursor(em); } }, em)));
    showPopover(e.currentTarget, grid, { className: 'emoji-pop' });
  }

  /* @mention suggestions */
  let mentionItems = [];
  let mentionIndex = 0;
  let mentionRange = null;

  function hideMention() {
    mentionItems = [];
    mentionRange = null;
    mentionBox.classList.add('hidden');
    mentionBox.replaceChildren();
  }

  function renderMention() {
    mentionBox.classList.remove('hidden');
    mentionBox.replaceChildren(...mentionItems.map((u, i) =>
      h('button', {
        class: 'mention-item' + (i === mentionIndex ? ' active' : ''), type: 'button', role: 'option',
        'aria-selected': String(i === mentionIndex),
        onmousedown: (e) => { e.preventDefault(); pickMention(u); },
      }, avatar(u, 24), h('strong', null, u.name), h('small', null, '@' + u.username))));
  }

  function updateMention() {
    if (!isChannel) return;
    const pos = input.selectionStart;
    const match = input.value.slice(0, pos).match(/(^|\s)@([a-z0-9_]{0,20})$/i);
    if (!match) { hideMention(); return; }
    const q = match[2].toLowerCase();
    mentionItems = [...state.users.values()]
      .filter((u) => !u.bot && u.id !== me.id && (u.username.startsWith(q) || u.name.toLowerCase().includes(q)))
      .slice(0, 5);
    if (!mentionItems.length) { hideMention(); return; }
    mentionRange = { start: pos - q.length - 1, end: pos };
    mentionIndex = 0;
    renderMention();
  }

  function pickMention(u) {
    if (!mentionRange) return;
    input.setRangeText('@' + u.username + ' ', mentionRange.start, mentionRange.end, 'end');
    hideMention();
    autosize();
    input.focus();
  }

  input.addEventListener('input', () => {
    autosize();
    updateMention();
    if (input.value.trim() && state.socket && Date.now() - lastTypingSent > 2500) {
      lastTypingSent = Date.now();
      state.socket.emit('typing', { cid });
    }
  });
  input.addEventListener('click', updateMention);
  input.addEventListener('blur', () => setTimeout(hideMention, 120));
  input.addEventListener('keydown', (e) => {
    if (mentionItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionIndex = (mentionIndex + 1) % mentionItems.length; renderMention(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionIndex = (mentionIndex - 1 + mentionItems.length) % mentionItems.length; renderMention(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionItems[mentionIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideMention(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  /* ---------------- typing indicator ---------------- */
  function renderTyping() {
    const names = [...typers.keys()].map(userName);
    if (!names.length) typingEl.replaceChildren();
    else {
      const text = names.length === 1 ? `${names[0]} is typing`
        : names.length === 2 ? `${names[0]} and ${names[1]} are typing` : 'Several people are typing';
      typingEl.replaceChildren(h('span', { class: 'dots' }, h('i'), h('i'), h('i')), text);
    }
  }
  function clearTyper(userId) {
    if (typers.has(userId)) { clearTimeout(typers.get(userId)); typers.delete(userId); renderTyping(); }
  }

  /* ---------------- modals ---------------- */
  function openCreateChannel() {
    let emoji = CHANNEL_EMOJIS[0];
    const name = h('input', { class: 'input', maxlength: '30', placeholder: 'e.g. physics-club', autocomplete: 'off' });
    const desc = h('input', { class: 'input', maxlength: '120', placeholder: 'What is this channel for?', autocomplete: 'off' });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const picker = h('div', { class: 'emoji-choice' }, CHANNEL_EMOJIS.map((em) =>
      h('button', {
        class: 'emoji-btn' + (em === emoji ? ' selected' : ''), type: 'button', 'aria-pressed': String(em === emoji), 'aria-label': 'Icon ' + em,
        onclick: () => {
          emoji = em;
          picker.querySelectorAll('.emoji-btn').forEach((b) => {
            const on = b.textContent === em;
            b.classList.toggle('selected', on);
            b.setAttribute('aria-pressed', String(on));
          });
        },
      }, em)));
    const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Create channel');
    const form = h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        submit.disabled = true;
        try {
          const r = await api('/channels', { method: 'POST', body: { name: name.value, description: desc.value, emoji } });
          if (!state.channels.some((c) => c.id === r.channel.id)) state.channels.push(r.channel);
          modal.close();
          location.hash = '#/chat/' + r.channel.id;
        } catch (ex) {
          err.textContent = ex.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    field('Channel name', name, 'Lowercase letters, numbers and dashes.'),
    field('Description (optional)', desc),
    h('div', { class: 'field' }, h('p', { class: 'label' }, 'Icon'), picker),
    err,
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
    const modal = openModal({ title: 'Create a channel', content: form });
  }

  function openNewDM() {
    const search = h('input', { class: 'input', placeholder: 'Search people by name', 'aria-label': 'Search people', autocomplete: 'off' });
    const listEl = h('div', { class: 'pick-list' });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const people = [...state.users.values()]
        .filter((u) => !u.bot && u.id !== me.id && (!q || u.name.toLowerCase().includes(q) || u.username.includes(q)))
        .sort((a, b) => (state.online.has(b.id) - state.online.has(a.id)) || a.name.localeCompare(b.name));
      listEl.replaceChildren(...(people.length
        ? people.map((u) => h('button', {
          class: 'pick-item', type: 'button',
          onclick: () => { modal.close(); location.hash = '#/chat/' + dmId(me.id, u.id); },
        }, avatarStatus(u, 34), h('span', { class: 'pick-text' }, h('strong', null, u.name), h('small', null, '@' + u.username)), roleBadge(u)))
        : [h('p', { class: 'side-empty' }, 'Nobody found.')]));
    };
    search.addEventListener('input', draw);
    const modal = openModal({ title: 'New message', content: h('div', null, search, listEl) });
    draw();
  }

  async function deleteChannel() {
    const ok = await confirmDialog(`Delete #${conv.channel.name} and all of its messages? This cannot be undone.`,
      { title: 'Delete channel', confirmText: 'Delete channel', danger: true });
    if (!ok) return;
    try {
      await api('/channels/' + cid, { method: 'DELETE' });
      state.channels = state.channels.filter((c) => c.id !== cid);
      delete state.unread[cid];
      location.hash = '#/chat/general';
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ---------------- live events ---------------- */
  sub.on('message:new', (m) => {
    addMessage(m);
    renderSide();
  });
  sub.on('message:update', applyUpdate);
  sub.on('typing', ({ cid: c, userId }) => {
    if (c !== cid || userId === me.id) return;
    clearTimeout(typers.get(userId));
    typers.set(userId, setTimeout(() => clearTyper(userId), 3500));
    renderTyping();
  });
  sub.on('presence', () => { updateStatus(); renderSide(); });
  sub.on('channels:changed', renderSide);
  sub.on('dms:changed', renderSide);
  sub.on('unread:changed', renderSide);
  sub.on('users:changed', () => { renderHeader(); renderSide(); });
  sub.on('reconnected', loadInitial);

  const onVisible = () => { if (!document.hidden && state.unread[cid]) markRead(cid); };
  document.addEventListener('visibilitychange', onVisible);
  scroller.addEventListener('scroll', () => { if (isNearBottom()) newPill.classList.add('hidden'); });

  /* ---------------- go ---------------- */
  renderHeader();
  renderSide();
  loadInitial();
  if (window.matchMedia('(hover: hover)').matches) input.focus();

  return () => {
    sub.off();
    document.removeEventListener('visibilitychange', onVisible);
    typers.forEach((t) => clearTimeout(t));
    closePopover();
    if (state.current === cid) state.current = null;
  };
}
