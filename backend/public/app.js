const API = '/api';
let chats = [];
let activeChatId = null;
let currentMessages = [];
let currentEditMessage = null;
let seenMessageIds = new Set();
let draggedChatId = null;
const expandedIds = new Set();

const chatListEl = document.getElementById('chatList');
const rootDropZone = document.getElementById('rootDropZone');
const emptyState = document.getElementById('emptyState');
const activeChatEl = document.getElementById('activeChat');
const chatNameInput = document.getElementById('chatNameInput');
const chatSub = document.getElementById('chatSub');
const chatAvatar = document.getElementById('chatAvatar');
const chatAvatarFallback = document.getElementById('chatAvatarFallback');
const messagesEl = document.getElementById('messages');
const textInput = document.getElementById('textInput');
const timestampInput = document.getElementById('timestampInput');
const senderInput = document.getElementById('senderInput');
const searchInput = document.getElementById('searchInput');
const appTitle = document.getElementById('appTitle');

// ============================================================
// Marker-based formatting — like WhatsApp. A message is stored as
// plain text with literal marker characters in it: *bold*, _italic_,
// and bracket tags that carry a value for strikethrough/highlight/
// color/font/size: [S#hex]...[/S], [H#hex]...[/H], [C#hex]...[/C],
// [F:key]...[/F], [Z:key]...[/Z].
//
// This replaces an earlier approach built on contenteditable + DOM
// Range manipulation, which kept misbehaving in practice (formatting
// leaking to the wrong scope, undo not working, native color pickers
// losing the selection). Plain text with markers has no such failure
// mode: formatting exists only where the marker characters are,
// full stop — undo is deleting them, and there's no DOM state that
// can drift out of sync with what's on screen.
//
// The composer/edit boxes are plain <textarea>s. Markers are visible
// while typing (same as WhatsApp's own compose box) and are parsed
// into styled HTML only at render time, in the message bubble.
// ============================================================

function escapeHtml(str) {
  const d = document.createElement('div');
  d.innerText = str ?? '';
  return d.innerHTML;
}

const FONT_FAMILIES = {
  inter: "'Inter', sans-serif", fraunces: "'Fraunces', serif", mono: "'IBM Plex Mono', monospace",
  hand: "'Caveat', cursive", georgia: "Georgia, serif", courier: "'Courier New', monospace"
};
const FONT_SIZES = { s: '12px', m: '15px', l: '19px', xl: '26px' };

// Parses marker text into safe HTML. Only ever emits <span style="...">
// built from our own fixed templates plus a strictly-validated hex color
// or a lookup-table key — there is no path for arbitrary attacker-
// controlled CSS to reach the output, since anything that doesn't match
// the exact marker syntax is treated as literal (escaped) text.
function parseMarkup(text) {
  const root = { children: [] };
  const stack = [root];
  let boldOpen = false, italicOpen = false;
  let buffer = '';
  const n = (text || '').length;
  let i = 0;

  function flush() {
    if (buffer) { stack[stack.length - 1].children.push({ type: 'text', value: buffer }); buffer = ''; }
  }
  function openTagNode(style, close) {
    const node = { tag: true, style, close, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  while (i < n) {
    const ch = text[i];
    if (ch === '*') {
      flush();
      if (boldOpen) { stack.pop(); boldOpen = false; }
      else { openTagNode('font-weight:700', null); boldOpen = true; }
      i++; continue;
    }
    if (ch === '_') {
      flush();
      if (italicOpen) { stack.pop(); italicOpen = false; }
      else { openTagNode('font-style:italic', null); italicOpen = true; }
      i++; continue;
    }
    if (ch === '[') {
      const openHex = /^\[(S|H|C)#([0-9A-Fa-f]{6})\]/.exec(text.slice(i));
      if (openHex) {
        flush();
        const kind = openHex[1], hex = '#' + openHex[2];
        const styleMap = {
          S: `text-decoration:line-through;text-decoration-color:${hex}`,
          H: `background-color:${hex};border-radius:3px;padding:0 2px`,
          C: `color:${hex}`
        };
        openTagNode(styleMap[kind], '[/' + kind + ']');
        i += openHex[0].length;
        continue;
      }
      const openKey = /^\[(F|Z):([a-z]+)\]/.exec(text.slice(i));
      if (openKey) {
        const kind = openKey[1], key = openKey[2];
        const lookup = kind === 'F' ? FONT_FAMILIES : FONT_SIZES;
        if (lookup[key]) {
          flush();
          const prop = kind === 'F' ? 'font-family' : 'font-size';
          openTagNode(`${prop}:${lookup[key]}`, '[/' + kind + ']');
          i += openKey[0].length;
          continue;
        }
      }
      const close = /^\[\/(S|H|C|F|Z)\]/.exec(text.slice(i));
      if (close && stack.length > 1 && stack[stack.length - 1].close === close[0]) {
        flush();
        stack.pop();
        i += close[0].length;
        continue;
      }
    }
    buffer += ch;
    i++;
  }
  flush();

  function render(node) {
    if (node.type === 'text') return escapeHtml(node.value).replace(/\n/g, '<br>');
    const inner = node.children.map(render).join('');
    return node === root ? inner : `<span style="${node.style}">${inner}</span>`;
  }
  return render(root);
}

// ---------- Simple toggling markers (Bold/Italic) ----------
function toggleSimpleMarker(textarea, marker) {
  const start = textarea.selectionStart, end = textarea.selectionEnd;
  const value = textarea.value;
  if (start === end) {
    textarea.value = value.slice(0, start) + marker + marker + value.slice(start);
    textarea.focus();
    textarea.setSelectionRange(start + marker.length, start + marker.length);
    return;
  }
  const before = value.slice(0, start), after = value.slice(end);
  if (before.endsWith(marker) && after.startsWith(marker)) {
    textarea.value = before.slice(0, -marker.length) + value.slice(start, end) + after.slice(marker.length);
    textarea.focus();
    textarea.setSelectionRange(start - marker.length, end - marker.length);
  } else {
    const selected = value.slice(start, end);
    textarea.value = before + marker + selected + marker + after;
    textarea.focus();
    textarea.setSelectionRange(start + marker.length, end + marker.length);
  }
}

// ---------- Value-carrying markers (Strike/Highlight/Color/Font/Size) ----------
// Wraps/unwraps [KIND<sep>value]...[/KIND] around the current selection.
// Passing value = null removes any existing wrap without adding a new one.
function applyMarker(textarea, kind, sep, valuePattern, value) {
  const start = textarea.selectionStart, end = textarea.selectionEnd;
  const val = textarea.value;
  const before = val.slice(0, start), selected = val.slice(start, end), after = val.slice(end);

  const openRe = new RegExp('\\[' + kind + '\\' + sep + valuePattern + '\\]$');
  const closeRe = new RegExp('^\\[/' + kind + '\\]');
  const openMatch = before.match(openRe);
  const closeMatch = after.match(closeRe);

  let newBefore = before, newAfter = after, newStart = start;
  if (openMatch && closeMatch) {
    newBefore = before.slice(0, before.length - openMatch[0].length);
    newAfter = after.slice(closeMatch[0].length);
    newStart = start - openMatch[0].length;
  }

  let finalValue, finalStart, finalEnd;
  if (value) {
    const openTag = `[${kind}${sep}${value}]`, closeTag = `[/${kind}]`;
    finalValue = newBefore + openTag + selected + closeTag + newAfter;
    finalStart = newStart;
    finalEnd = newStart + openTag.length + selected.length + closeTag.length;
  } else {
    finalValue = newBefore + selected + newAfter;
    finalStart = newStart;
    finalEnd = newStart + selected.length;
  }
  textarea.value = finalValue;
  textarea.focus();
  textarea.setSelectionRange(finalStart, finalEnd);
}
const applyColorMarker = (textarea, kind, hex) => applyMarker(textarea, kind, '#', '[0-9A-Fa-f]{6}', hex);
const applyKeyMarker = (textarea, kind, key) => applyMarker(textarea, kind, ':', '[a-z]+', key);

// Strips every recognized marker within the current selection, reverting
// it to plain text — a universal undo for mixed/messy formatting.
function eraseMarkersInSelection(textarea) {
  const start = textarea.selectionStart, end = textarea.selectionEnd;
  if (start === end) return;
  const value = textarea.value;
  const cleaned = stripMarkup(value.slice(start, end));
  textarea.value = value.slice(0, start) + cleaned + value.slice(end);
  textarea.focus();
  textarea.setSelectionRange(start, start + cleaned.length);
}

// ---------- Shared popup (colors for Strike/Highlight/Color, choices for Font/Size) ----------
const TEXT_COLORS = ['#2E2A22', '#B5533C', '#6E7F5C', '#5B7A9D', '#7A5C7E', '#A9822E', '#3E6B5E', '#8A2F52'];
const HIGHLIGHT_COLORS = ['#F4E1A1', '#F2C9C0', '#D9E4D0', '#D6E2EC', '#E6D6E8', '#FCE8B8', '#C9E4DE', '#F6D6D6'];
const STRIKE_COLORS = ['#B5533C', '#2E2A22', '#6E7F5C', '#5B7A9D', '#7A5C7E', '#A9822E', '#3E6B5E', '#8A2F52'];
const FONT_CHOICES = [
  { key: 'inter', label: 'Inter' }, { key: 'fraunces', label: 'Fraunces' }, { key: 'mono', label: 'Plex Mono' },
  { key: 'hand', label: 'Handwritten' }, { key: 'georgia', label: 'Georgia' }, { key: 'courier', label: 'Courier' }
];
const SIZE_CHOICES = [
  { key: 's', label: 'Small' }, { key: 'm', label: 'Medium' }, { key: 'l', label: 'Large' }, { key: 'xl', label: 'Extra Large' }
];

const colorPopup = document.getElementById('colorPopup');
const colorPopupTitle = document.getElementById('colorPopupTitle');
const swatchGrid = document.getElementById('swatchGrid');
let popupTarget = null; // { textarea, kind }

function openColorPopup(textarea, kind, title, colors) {
  const start = textarea.selectionStart, end = textarea.selectionEnd;
  if (start === end) return; // nothing selected — nothing to style
  popupTarget = { textarea, kind };
  colorPopupTitle.textContent = title;
  swatchGrid.className = 'swatchGrid';
  swatchGrid.innerHTML = '';

  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'swatchBtn swatchNone';
  none.title = 'Remove';
  none.addEventListener('click', () => { applyColorMarker(popupTarget.textarea, popupTarget.kind, null); closeColorPopup(); });
  swatchGrid.appendChild(none);

  colors.forEach(hex => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatchBtn';
    b.style.background = hex;
    b.title = hex;
    b.addEventListener('click', () => { applyColorMarker(popupTarget.textarea, popupTarget.kind, hex.replace('#', '')); closeColorPopup(); });
    swatchGrid.appendChild(b);
  });

  colorPopup.classList.remove('hidden');
}

function openChoicePopup(textarea, kind, title, choices, previewStyleFor) {
  const start = textarea.selectionStart, end = textarea.selectionEnd;
  if (start === end) return;
  popupTarget = { textarea, kind };
  colorPopupTitle.textContent = title;
  swatchGrid.className = 'swatchGrid choiceGrid';
  swatchGrid.innerHTML = '';

  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'choiceBtn choiceNone';
  none.textContent = 'Default';
  none.addEventListener('click', () => { applyKeyMarker(popupTarget.textarea, popupTarget.kind, null); closeColorPopup(); });
  swatchGrid.appendChild(none);

  choices.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'choiceBtn';
    b.style.cssText = previewStyleFor(c.key);
    b.textContent = c.label;
    b.addEventListener('click', () => { applyKeyMarker(popupTarget.textarea, popupTarget.kind, c.key); closeColorPopup(); });
    swatchGrid.appendChild(b);
  });

  colorPopup.classList.remove('hidden');
}
function closeColorPopup() {
  colorPopup.classList.add('hidden');
  popupTarget = null;
}
colorPopup.addEventListener('click', (e) => { if (e.target === colorPopup) closeColorPopup(); });

function wireToolbar(ids, textareaGetter) {
  document.getElementById(ids.bold).addEventListener('click', () => toggleSimpleMarker(textareaGetter(), '*'));
  document.getElementById(ids.italic).addEventListener('click', () => toggleSimpleMarker(textareaGetter(), '_'));
  document.getElementById(ids.strike).addEventListener('click', () => openColorPopup(textareaGetter(), 'S', 'Strikethrough color', STRIKE_COLORS));
  document.getElementById(ids.highlight).addEventListener('click', () => openColorPopup(textareaGetter(), 'H', 'Highlight color', HIGHLIGHT_COLORS));
  document.getElementById(ids.color).addEventListener('click', () => openColorPopup(textareaGetter(), 'C', 'Text color', TEXT_COLORS));
  document.getElementById(ids.font).addEventListener('click', () =>
    openChoicePopup(textareaGetter(), 'F', 'Font', FONT_CHOICES, key => `font-family:${FONT_FAMILIES[key]};font-size:15px;`));
  document.getElementById(ids.size).addEventListener('click', () =>
    openChoicePopup(textareaGetter(), 'Z', 'Size', SIZE_CHOICES, key => `font-size:${FONT_SIZES[key]};`));
  document.getElementById(ids.eraser).addEventListener('click', () => eraseMarkersInSelection(textareaGetter()));
}

const COMPOSER_IDS = {
  bold: 'boldBtn', italic: 'italicBtn', strike: 'strikeBtn', highlight: 'highlightBtn',
  color: 'colorBtn', font: 'fontBtn', size: 'sizeBtn', eraser: 'eraserBtn'
};
const EDIT_IDS = {
  bold: 'editBoldBtn', italic: 'editItalicBtn', strike: 'editStrikeBtn', highlight: 'editHighlightBtn',
  color: 'editColorBtn', font: 'editFontBtn', size: 'editSizeBtn', eraser: 'editEraserBtn'
};



// ---------- Palette / hashing ----------
const PALETTE = ['#B5533C', '#6E7F5C', '#5B7A9D', '#7A5C7E', '#A9822E', '#3E6B5E'];
function colorFor(str) {
  let h = 0;
  for (let i = 0; i < (str || '').length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initialsFor(name) { return (name || '?').trim().slice(0, 1).toUpperCase(); }
function isMe(sender) { return (sender || '').trim().toLowerCase() === 'me'; }

function nowLocalDatetime() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
function toIso(localDatetimeValue) { return new Date(localDatetimeValue).toISOString(); }
function fromIsoToLocalInput(iso) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
function fmtDay(d) { return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }
function fmtTime(d) { return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }

const ICON_EDIT = `<svg viewBox="0 0 20 20" fill="none"><path d="M4 14.5V16h1.5l8.4-8.4-1.5-1.5L4 14.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M13 5.5l1.5-1.5 1.5 1.5-1.5 1.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
const ICON_CLOCK = `<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M10 6.5V10l2.5 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 20 20" fill="none"><path d="M4 6h12M8 6V4.6c0-.6.4-1 1-1h2c.6 0 1 .4 1 1V6m-7 0 .7 9.3c.05.7.6 1.2 1.3 1.2h5c.7 0 1.25-.5 1.3-1.2L15 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_PLUS = `<svg viewBox="0 0 20 20" fill="none"><path d="M10 4.5v11M4.5 10h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const ICON_COPY = `<svg viewBox="0 0 20 20" fill="none"><rect x="7" y="7" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-7A1.5 1.5 0 0 0 3 5.5v7A1.5 1.5 0 0 0 4.5 14H7" stroke="currentColor" stroke-width="1.4"/></svg>`;
const ICON_PIN = `<svg viewBox="0 0 20 20" fill="none"><path d="M8 3h4l-.6 5 2.6 2.5v1H10v4l-1 1.5L8 15.5V11.5H5.9v-1L8.5 8 8 3Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
const ICON_CARET = `<svg viewBox="0 0 20 20" fill="none"><path d="M7.5 5.5 12.5 10l-5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_DOTS = `<svg viewBox="0 0 20 20" fill="currentColor"><circle cx="10" cy="4.5" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="10" cy="15.5" r="1.4"/></svg>`;
const ICON_CHEVRON_DOWN = `<svg viewBox="0 0 20 20" fill="none"><path d="M5.5 8l4.5 4.5L14.5 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 20 20" fill="none"><path d="M4.5 10.5l3.5 3.5 7.5-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Strips every recognized marker, leaving clean plain text — used for
// avatar initials, the copy button, and anywhere else raw text is needed.
function stripMarkup(text) {
  return (text || '').replace(/\*|_|\[\/?(S|H|C)(#[0-9A-Fa-f]{6})?\]|\[\/?(F|Z)(:[a-z]+)?\]/g, '');
}

// The STAMPED field defaults to acting like a live clock — it keeps
// showing the current time until the person deliberately edits it to
// backdate/postdate a message. Without this, it's just a snapshot from
// whenever it was last set, so a message typed a minute later would
// send with a stale timestamp instead of the actual moment of sending.
let timestampManuallySet = false;
timestampInput.value = nowLocalDatetime();
timestampInput.addEventListener('input', () => { timestampManuallySet = true; });
setInterval(() => {
  if (!timestampManuallySet && document.activeElement !== timestampInput) {
    timestampInput.value = nowLocalDatetime();
  }
}, 15000);

// ---------- App name ----------
async function loadSettings() {
  const res = await fetch(`${API}/settings`);
  const data = await res.json();
  appTitle.textContent = data.app_name;
  document.title = data.app_name + ' — your chats';
}
appTitle.addEventListener('blur', async () => {
  const val = appTitle.textContent.trim();
  if (!val) { appTitle.textContent = 'Keepsake'; return; }
  await fetch(`${API}/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_name: val })
  });
  document.title = val + ' — your chats';
});
appTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); appTitle.blur(); } });

// ---------- Chats: load + tree rendering ----------
async function loadChats() {
  const res = await fetch(`${API}/chats`);
  chats = await res.json();
  renderChatList();
}

let effectiveActivityMap = new Map();

// A chat's own last_message_at only reflects messages sent directly in
// it — not in chats filed inside it. This computes, for every chat, the
// most recent activity anywhere in its own subtree, so a message sent
// three levels deep bubbles that whole chain up in the sidebar too.
function computeEffectiveActivity() {
  const childrenOf = new Map();
  chats.forEach(c => {
    const key = c.parent_id || null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(c);
  });
  const cache = new Map();
  function effective(chat) {
    if (cache.has(chat.id)) return cache.get(chat.id);
    let best = chat.last_message_at ? new Date(chat.last_message_at).getTime() : 0;
    (childrenOf.get(chat.id) || []).forEach(k => { best = Math.max(best, effective(k)); });
    cache.set(chat.id, best);
    return best;
  }
  chats.forEach(c => effective(c));
  return cache;
}

function sortSiblings(list) {
  const pinned = list.filter(c => c.pinned).sort((a, b) => a.sort_order - b.sort_order);
  const unpinned = list.filter(c => !c.pinned).sort((a, b) => {
    const at = effectiveActivityMap.get(a.id) ?? new Date(a.created_at).getTime();
    const bt = effectiveActivityMap.get(b.id) ?? new Date(b.created_at).getTime();
    return bt - at;
  });
  return [...pinned, ...unpinned];
}

const seenChatIds = new Set();

function renderChatList() {
  effectiveActivityMap = computeEffectiveActivity();
  chatListEl.innerHTML = '';
  const roots = sortSiblings(chats.filter(c => !c.parent_id));
  roots.forEach(chat => chatListEl.appendChild(renderChatNode(chat, 0)));
}

function renderChatNode(chat, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'chatNode';

  const children = sortSiblings(chats.filter(c => c.parent_id === chat.id));
  const hasChildren = children.length > 0;
  const expanded = expandedIds.has(chat.id);

  const isNew = !seenChatIds.has(chat.id);
  seenChatIds.add(chat.id);

  const item = document.createElement('div');
  item.className = 'chatItem' + (chat.id === activeChatId ? ' active' : '') + (isNew ? ' entering' : '');
  item.style.paddingLeft = (8 + depth * 18) + 'px';
  item.draggable = true;
  item.dataset.chatId = chat.id;

  const tab = colorFor(chat.id);
  const avatarHtml = chat.avatar
    ? `<img class="chatAvatarSmall" src="/media/${chat.avatar}" />`
    : `<span class="chatAvatarInitial" style="--tab-color:${tab}">${initialsFor(stripMarkup(chat.name))}</span>`;

  const caretHtml = hasChildren
    ? `<span class="expandCaret${expanded ? ' expanded' : ''}">${ICON_CARET}</span>`
    : `<span class="expandCaretSpacer"></span>`;

  item.innerHTML = `
    ${caretHtml}
    ${avatarHtml}
    <span class="chatItemName">${parseMarkup(chat.name)}</span>
    ${chat.pinned ? `<span class="pinnedBadge" title="Pinned">${ICON_PIN}</span>` : ''}
    <button class="chatItemDots" title="More">${ICON_DOTS}</button>
  `;

  if (hasChildren) {
    item.querySelector('.expandCaret').addEventListener('click', (e) => {
      e.stopPropagation();
      if (expandedIds.has(chat.id)) expandedIds.delete(chat.id); else expandedIds.add(chat.id);
      renderChatList();
    });
  }
  const dotsBtn = item.querySelector('.chatItemDots');
  dotsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openChatMenu(chat, dotsBtn);
  });
  item.addEventListener('click', () => selectChat(chat.id));

  // ---- Drag & drop ----
  item.addEventListener('dragstart', (e) => {
    draggedChatId = chat.id;
    item.classList.add('dragging');
    rootDropZone.classList.add('visible');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', chat.id);
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    rootDropZone.classList.remove('visible');
    clearDropClasses();
    draggedChatId = null;
  });
  item.addEventListener('dragover', (e) => {
    if (!draggedChatId || draggedChatId === chat.id) return;
    e.preventDefault();
    clearDropClasses();
    const rect = item.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    if (ratio < 0.25) item.classList.add('dropBefore');
    else if (ratio > 0.75) item.classList.add('dropAfter');
    else item.classList.add('dropNest');
  });
  item.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!draggedChatId || draggedChatId === chat.id) return;
    if (isDescendant(chat.id, draggedChatId)) { clearDropClasses(); return; }
    if (item.classList.contains('dropNest')) {
      expandedIds.add(chat.id);
      await fetch(`${API}/chats/${draggedChatId}/move`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id: chat.id })
      });
    } else {
      await fetch(`${API}/chats/${draggedChatId}/move`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id: chat.parent_id || null, insert_before: chat.id })
      });
    }
    clearDropClasses();
    await loadChats();
  });

  wrap.appendChild(item);

  if (hasChildren) {
    const childrenEl = document.createElement('div');
    childrenEl.className = 'chatChildren' + (expanded ? '' : ' collapsed');
    children.forEach(c => childrenEl.appendChild(renderChatNode(c, depth + 1)));
    wrap.appendChild(childrenEl);
  }

  return wrap;
}

function clearDropClasses() {
  document.querySelectorAll('.dropNest, .dropBefore, .dropAfter').forEach(el =>
    el.classList.remove('dropNest', 'dropBefore', 'dropAfter'));
}
function isDescendant(possibleChildId, ofId) {
  let cur = chats.find(c => c.id === possibleChildId);
  while (cur && cur.parent_id) {
    if (cur.parent_id === ofId) return true;
    cur = chats.find(c => c.id === cur.parent_id);
  }
  return false;
}

rootDropZone.addEventListener('dragover', (e) => {
  if (!draggedChatId) return;
  e.preventDefault();
  rootDropZone.classList.add('dragOver');
});
rootDropZone.addEventListener('dragleave', () => rootDropZone.classList.remove('dragOver'));
rootDropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  rootDropZone.classList.remove('dragOver');
  if (!draggedChatId) return;
  await fetch(`${API}/chats/${draggedChatId}/move`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent_id: null })
  });
  await loadChats();
});

const chatMenu = document.getElementById('chatMenu');

// A real in-app dialog, used instead of window.prompt() — Electron's
// desktop shell doesn't implement prompt() at all (alert/confirm work,
// prompt silently does nothing), so relying on it broke every "name this
// chat" flow in the packaged app. This works identically in the browser
// and in Electron, and looks better than the browser's native prompt too.
function showTextPrompt(title, defaultValue = '') {
  return new Promise((resolve) => {
    const modal = document.getElementById('textPromptModal');
    const titleEl = document.getElementById('textPromptTitle');
    const input = document.getElementById('textPromptInput');
    const okBtn = document.getElementById('textPromptOkBtn');
    const cancelBtn = document.getElementById('textPromptCancelBtn');

    titleEl.textContent = title;
    input.value = defaultValue;
    modal.classList.remove('hidden');
    input.focus();
    input.select();

    function cleanup(result) {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKeydown);
      resolve(result);
    }
    function onOk() { cleanup(input.value.trim() || null); }
    function onCancel() { cleanup(null); }
    function onKeydown(e) {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKeydown);
  });
}
let menuAnchor = null;

// items: [{ icon, label, action, danger }]
function openMenu(items, anchorBtn) {
  if (menuAnchor) menuAnchor.classList.remove('menuOpen');
  menuAnchor = anchorBtn;
  anchorBtn.classList.add('menuOpen');

  chatMenu.innerHTML = items.map((it, i) =>
    `<button class="chatMenuItem${it.danger ? ' danger' : ''}" data-i="${i}">${it.icon}<span>${it.label}</span></button>`
  ).join('');
  chatMenu.classList.remove('hidden');

  const rect = anchorBtn.getBoundingClientRect();
  const menuRect = chatMenu.getBoundingClientRect();
  let left = rect.right - menuRect.width;
  let top = rect.bottom + 4;
  if (left < 8) left = 8;
  if (top + menuRect.height > window.innerHeight - 8) top = rect.top - menuRect.height - 4;
  chatMenu.style.left = left + 'px';
  chatMenu.style.top = top + 'px';

  chatMenu.querySelectorAll('.chatMenuItem').forEach((btn, i) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeChatMenu();
      items[i].action();
    });
  });
}
function closeChatMenu() {
  chatMenu.classList.add('hidden');
  if (menuAnchor) { menuAnchor.classList.remove('menuOpen'); menuAnchor = null; }
}
document.addEventListener('mousedown', (e) => {
  if (!chatMenu.classList.contains('hidden') && !chatMenu.contains(e.target) && !e.target.closest('.chatItemDots, .msgMenuBtn')) {
    closeChatMenu();
  }
});

function openChatMenu(chat, anchorBtn) {
  openMenu([
    { icon: ICON_PIN, label: chat.pinned ? 'Unpin' : 'Pin', action: async () => {
        await fetch(`${API}/chats/${chat.id}/pin`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned: !chat.pinned })
        });
        await loadChats();
      } },
    { icon: ICON_PLUS, label: 'New chat inside', action: async () => {
        const name = await showTextPrompt('Name this new chat inside "' + stripMarkup(chat.name) + '"');
        if (!name) return;
        const res = await fetch(`${API}/chats`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, parent_id: chat.id })
        });
        const newChat = await res.json();
        expandedIds.add(chat.id);
        await loadChats();
        selectChat(newChat.id);
      } },
    { icon: ICON_COPY, label: 'Duplicate', action: async () => {
        await fetch(`${API}/chats/${chat.id}/duplicate`, { method: 'POST' });
        await loadChats();
      } },
    { icon: ICON_EDIT, label: 'Rename & style', action: async () => {
        await selectChat(chat.id);
        enterNameEditMode();
      } },
    { icon: ICON_TRASH, label: 'Delete', danger: true, action: () => deleteChat(chat) }
  ], anchorBtn);
}

document.getElementById('newChatBtn').addEventListener('click', async () => {
  const name = await showTextPrompt('Name this chat (e.g. "Work", "Family", "Project X")');
  if (!name) return;
  const res = await fetch(`${API}/chats`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const chat = await res.json();
  await loadChats();
  selectChat(chat.id);
});

async function selectChat(id) {
  activeChatId = id;
  const chat = chats.find(c => c.id === id);
  emptyState.classList.add('hidden');
  activeChatEl.classList.remove('hidden');
  exitNameEditMode(false);
  exitSelectionMode();
  seenMessageIds = new Set();
  updateHeaderName(chat);
  searchInput.value = '';
  updateHeaderAvatar(chat);
  renderChatList();
  await loadMessages(id);
}

function updateHeaderAvatar(chat) {
  if (chat.avatar) {
    chatAvatar.src = '/media/' + chat.avatar;
    chatAvatar.style.display = 'block';
    chatAvatarFallback.style.display = 'none';
  } else {
    chatAvatar.style.display = 'none';
    chatAvatarFallback.style.display = 'flex';
    chatAvatarFallback.textContent = initialsFor(stripMarkup(chat.name));
    chatAvatarFallback.style.background = colorFor(chat.id);
  }
}

// ---------- Chat name: styled view mode, marker-toolbar edit mode ----------
const chatNameView = document.getElementById('chatNameView');
const editNameBtn = document.getElementById('editNameBtn');
const chatNameToolbarEl = document.getElementById('chatNameToolbar');
const NAME_IDS = {
  bold: 'nameBoldBtn', italic: 'nameItalicBtn', strike: 'nameStrikeBtn', highlight: 'nameHighlightBtn',
  color: 'nameColorBtn', font: 'nameFontBtn', size: 'nameSizeBtn', eraser: 'nameEraserBtn'
};
wireToolbar(NAME_IDS, () => chatNameInput);

function updateHeaderName(chat) {
  chatNameView.innerHTML = parseMarkup(chat.name);
}

let nameEditing = false;
function enterNameEditMode() {
  if (!activeChatId) return;
  const chat = chats.find(c => c.id === activeChatId);
  if (!chat) return;
  nameEditing = true;
  chatNameInput.value = chat.name;
  chatNameView.classList.add('hidden');
  chatNameInput.classList.remove('hidden');
  chatNameToolbarEl.classList.remove('hidden');
  chatNameInput.focus();
  chatNameInput.select();
}
async function exitNameEditMode(commit) {
  if (!nameEditing) return;
  nameEditing = false;
  if (commit && activeChatId) {
    const val = chatNameInput.value.trim();
    const chat = chats.find(c => c.id === activeChatId);
    if (val && chat && val !== chat.name) {
      await fetch(`${API}/chats/${activeChatId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: val })
      });
      await loadChats();
    }
  }
  const chat = chats.find(c => c.id === activeChatId);
  if (chat) { updateHeaderName(chat); updateHeaderAvatar(chat); }
  chatNameView.classList.remove('hidden');
  chatNameInput.classList.add('hidden');
  chatNameToolbarEl.classList.add('hidden');
}
editNameBtn.addEventListener('click', enterNameEditMode);
chatNameView.addEventListener('click', enterNameEditMode);
chatNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); exitNameEditMode(true); }
  if (e.key === 'Escape') { e.preventDefault(); exitNameEditMode(false); }
});
document.addEventListener('mousedown', (e) => {
  if (!nameEditing) return;
  const withinEditArea = document.getElementById('chatHeaderText').contains(e.target) || colorPopup.contains(e.target);
  if (!withinEditArea) exitNameEditMode(true);
});

document.getElementById('avatarInput').addEventListener('change', async (e) => {
  if (!activeChatId || !e.target.files[0]) return;
  const fd = new FormData();
  fd.append('avatar', e.target.files[0]);
  const res = await fetch(`${API}/chats/${activeChatId}/avatar`, { method: 'POST', body: fd });
  const chat = await res.json();
  updateHeaderAvatar(chat);
  await loadChats();
});

document.getElementById('deleteChatBtn').addEventListener('click', () => {
  const chat = chats.find(c => c.id === activeChatId);
  if (chat) deleteChat(chat);
});

async function deleteChat(chat) {
  const childCount = chats.filter(c => c.parent_id === chat.id).length;
  const warn = childCount > 0 ? ` This also deletes ${childCount} chat${childCount > 1 ? 's' : ''} filed inside it.` : '';
  if (!confirm(`Delete "${stripMarkup(chat.name)}" and everything in it — messages, photos, video, audio?${warn} This can't be undone.`)) return;
  await fetch(`${API}/chats/${chat.id}`, { method: 'DELETE' });
  if (chat.id === activeChatId || isDescendant(activeChatId, chat.id)) {
    activeChatId = null;
    activeChatEl.classList.add('hidden');
    emptyState.classList.remove('hidden');
  }
  await loadChats();
}

// ---------- Messages ----------
async function loadMessages(chatId, scrollTo = 'bottom') {
  const res = await fetch(`${API}/chats/${chatId}/messages`);
  currentMessages = await res.json();
  render(scrollTo);
}

searchInput.addEventListener('input', () => render('preserve'));

// ---------- Multi-select ----------
let selectionMode = false;
const selectedMessageIds = new Set();
const normalHeaderEl = document.getElementById('normalHeader');
const selectionBarEl = document.getElementById('selectionBar');
const selectionCountEl = document.getElementById('selectionCount');

function enterSelectionMode() {
  if (selectionMode) return;
  selectionMode = true;
  selectedMessageIds.clear();
  normalHeaderEl.classList.add('hidden');
  selectionBarEl.classList.remove('hidden');
  messagesEl.classList.add('selecting');
  updateSelectionCount();
}
function exitSelectionMode() {
  if (!selectionMode) return;
  selectionMode = false;
  selectedMessageIds.clear();
  normalHeaderEl.classList.remove('hidden');
  selectionBarEl.classList.add('hidden');
  messagesEl.classList.remove('selecting');
  messagesEl.querySelectorAll('.msg.selected').forEach(el => el.classList.remove('selected'));
}
function updateSelectionCount() {
  const n = selectedMessageIds.size;
  selectionCountEl.textContent = `${n} selected`;
}
function toggleMessageSelection(id, bubbleEl) {
  if (selectedMessageIds.has(id)) { selectedMessageIds.delete(id); bubbleEl.classList.remove('selected'); }
  else { selectedMessageIds.add(id); bubbleEl.classList.add('selected'); }
  updateSelectionCount();
}
document.getElementById('selectModeBtn').addEventListener('click', enterSelectionMode);
document.getElementById('exitSelectionBtn').addEventListener('click', exitSelectionMode);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && selectionMode) exitSelectionMode(); });

document.getElementById('selectionCopyBtn').addEventListener('click', async () => {
  if (selectedMessageIds.size === 0) return;
  const selected = currentMessages
    .filter(m => selectedMessageIds.has(m.id))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const text = selected
    .map(m => m.content_type === 'text' ? stripMarkup(m.content) : stripMarkup(m.caption || ''))
    .filter(t => t.trim())
    .join('\n\n');
  if (text) await copyToClipboard(text);
});
document.getElementById('selectionDeleteBtn').addEventListener('click', async () => {
  const n = selectedMessageIds.size;
  if (n === 0) return;
  if (!confirm(`Delete ${n} message${n > 1 ? 's' : ''}? This can't be undone.`)) return;
  await Promise.all([...selectedMessageIds].map(id => fetch(`${API}/messages/${id}`, { method: 'DELETE' })));
  exitSelectionMode();
  await loadMessages(activeChatId, 'preserve');
  await loadChats();
});

function render(scrollTo = 'bottom') {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = currentMessages.filter(m => !query || (m.content_type === 'text' && m.content.toLowerCase().includes(query)));
  const prevScrollTop = messagesEl.scrollTop;

  chatSub.textContent = `${currentMessages.length} ${currentMessages.length === 1 ? 'entry' : 'entries'}`;
  messagesEl.innerHTML = '';

  if (currentMessages.length === 0) {
    messagesEl.innerHTML = `<div class="emptyMsgState"><div class="stub">Nothing here yet</div>Write your first message below, or attach a photo, video or voice note.</div>`;
    return;
  }
  if (filtered.length === 0) {
    messagesEl.innerHTML = `<div class="emptyMsgState"><div class="stub">No matches</div>Try a different search term.</div>`;
    return;
  }

  let lastDay = null;
  filtered.forEach(m => {
    const d = new Date(m.timestamp);
    const dayKey = d.toDateString();
    if (dayKey !== lastDay) {
      const div = document.createElement('div');
      div.className = 'dayDivider';
      div.textContent = fmtDay(d);
      messagesEl.appendChild(div);
      lastDay = dayKey;
    }
    messagesEl.appendChild(renderMessage(m, d));
  });

  messagesEl.scrollTop = scrollTo === 'preserve' ? prevScrollTop : messagesEl.scrollHeight;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (err2) { /* clipboard unavailable, give up quietly */ }
    document.body.removeChild(ta);
  }
}

function buildBaseStyle(m) {
  let s = `font-family:${m.font_family}; color:${m.font_color}; font-size:${m.font_size}; font-weight:${m.bold ? 'bold' : 'normal'}; font-style:${m.italic ? 'italic' : 'normal'};`;
  if (m.strikethrough) s += `text-decoration:line-through; text-decoration-color:${m.strikethrough_color || m.font_color};`;
  if (m.highlight_color) s += `background-color:${m.highlight_color}; border-radius:5px; padding:1px 5px;`;
  return s;
}

function renderMessage(m, d) {
  const me = isMe(m.sender);
  const row = document.createElement('div');
  row.className = me ? 'rowMe' : 'rowThem';

  const bubble = document.createElement('div');
  const isNewMsg = !seenMessageIds.has(m.id);
  seenMessageIds.add(m.id);
  bubble.className = 'msg ' + (me ? 'me' : 'them')
    + (isNewMsg ? ' entering' : '')
    + (selectionMode && selectedMessageIds.has(m.id) ? ' selected' : '');
  if (!me) bubble.style.setProperty('--accent', colorFor(m.sender));

  let bodyHtml = '';
  if (m.content_type === 'text') {
    // New messages: parse marker text. Old messages saved before this
    // change may still have content_html from the previous rich-text
    // system — keep rendering those correctly too.
    const inner = (m.content_html && m.content_html.trim()) ? m.content_html : parseMarkup(m.content);
    bodyHtml = `<div class="msgBody" style="${buildBaseStyle(m)}">${inner}</div>`;
  } else {
    if (m.content_type === 'image') bodyHtml = `<img src="/media/${m.content}" />`;
    else if (m.content_type === 'video') bodyHtml = `<video src="/media/${m.content}" controls></video>`;
    else if (m.content_type === 'audio') bodyHtml = `<audio src="/media/${m.content}" controls></audio>`;
    else bodyHtml = `<a class="fileLink" href="/media/${m.content}" download="${m.file_name || ''}">${escapeHtml(m.file_name || 'Download file')}</a>`;

    const hasCaption = (m.caption_html && m.caption_html.trim()) || (m.caption && m.caption.trim());
    if (hasCaption) {
      const captionInner = (m.caption_html && m.caption_html.trim()) ? m.caption_html : parseMarkup(m.caption);
      bodyHtml += `<div class="msgCaption" style="${buildBaseStyle(m)}">${captionInner}</div>`;
    }
  }

  const copyText = m.content_type === 'text' ? stripMarkup(m.content) : stripMarkup(m.caption || '');

  bubble.innerHTML = `
    <span class="msgCheckbox">${ICON_CHECK}</span>
    ${!me ? `<div class="msgSender">${escapeHtml(m.sender)}</div>` : ''}
    ${bodyHtml}
    <div class="metaRow">
      <span class="stamp" title="Click to change the date &amp; time">${fmtTime(d)}</span>
      <button class="msgMenuBtn" title="Message options">${ICON_CHEVRON_DOWN}</button>
    </div>
  `;

  bubble.querySelector('.stamp').addEventListener('click', (e) => {
    if (selectionMode) { e.stopPropagation(); toggleMessageSelection(m.id, bubble); return; }
    openEditModal(m);
  });

  bubble.querySelector('.msgMenuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const items = [];
    if (copyText.trim()) {
      items.push({ icon: ICON_COPY, label: 'Copy text', action: () => copyToClipboard(copyText) });
    }
    items.push({ icon: ICON_EDIT, label: m.content_type === 'text' ? 'Edit' : 'Edit caption & details', action: () => openEditModal(m) });
    items.push({ icon: ICON_CHECK, label: 'Select', action: () => { enterSelectionMode(); toggleMessageSelection(m.id, bubble); } });
    items.push({ icon: ICON_TRASH, label: 'Delete', danger: true, action: async () => {
        if (!confirm('Delete this message?')) return;
        await fetch(`${API}/messages/${m.id}`, { method: 'DELETE' });
        await loadMessages(activeChatId, 'preserve');
        await loadChats();
      } });
    openMenu(items, e.currentTarget);
  });

  bubble.addEventListener('click', (e) => {
    if (!selectionMode) return;
    e.stopPropagation();
    toggleMessageSelection(m.id, bubble);
  });

  row.appendChild(bubble);
  return row;
}

// ---------- Composer ----------
wireToolbar(COMPOSER_IDS, () => textInput);

let pendingFile = null;
let pendingFileUrl = null;
const pendingFileChip = document.getElementById('pendingFileChip');
const pendingFileThumb = document.getElementById('pendingFileThumb');
const pendingFileName = document.getElementById('pendingFileName');

function clearPendingFile() {
  if (pendingFileUrl) URL.revokeObjectURL(pendingFileUrl);
  pendingFile = null;
  pendingFileUrl = null;
  pendingFileChip.classList.add('hidden');
  document.getElementById('fileInput').value = '';
}

document.getElementById('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  clearPendingFile();
  pendingFile = file;
  pendingFileName.textContent = file.name;
  if (file.type.startsWith('image/')) {
    pendingFileUrl = URL.createObjectURL(file);
    pendingFileThumb.style.backgroundImage = `url(${pendingFileUrl})`;
    pendingFileThumb.textContent = '';
  } else {
    pendingFileThumb.style.backgroundImage = '';
    pendingFileThumb.textContent = file.type.startsWith('video/') ? '🎞️' : file.type.startsWith('audio/') ? '🎵' : '📄';
  }
  pendingFileChip.classList.remove('hidden');
  textInput.focus();
});
document.getElementById('pendingFileRemove').addEventListener('click', clearPendingFile);

function autoGrow(el, maxPx) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, maxPx) + 'px';
}

document.getElementById('sendBtn').addEventListener('click', send);
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
textInput.addEventListener('input', () => autoGrow(textInput, 160));

async function send() {
  if (!activeChatId) return;
  const text = textInput.value.trim();
  if (!pendingFile && !text) return;
  // If the person hasn't deliberately backdated/postdated this message,
  // use the actual current moment of sending rather than whatever the
  // field happened to be showing (which only refreshes every 15s).
  const ts = timestampManuallySet ? toIso(timestampInput.value || nowLocalDatetime()) : new Date().toISOString();
  const sender = senderInput.value || 'Me';

  if (pendingFile) {
    const fd = new FormData();
    fd.append('file', pendingFile);
    fd.append('sender', sender);
    fd.append('timestamp', ts);
    fd.append('caption', text);
    await fetch(`${API}/chats/${activeChatId}/upload`, { method: 'POST', body: fd });
    clearPendingFile();
  } else {
    const body = { sender, content: text, timestamp: ts };
    await fetch(`${API}/chats/${activeChatId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  textInput.value = '';
  textInput.style.height = 'auto';
  timestampManuallySet = false;
  timestampInput.value = nowLocalDatetime();
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.classList.remove('sent'); void sendBtn.offsetWidth; sendBtn.classList.add('sent');
  await loadMessages(activeChatId);
  await loadChats();
}

// ---------- Edit modal ----------
// Handles both editing a text message's body AND adding/editing a caption
// on an image/video/audio/file message — same textarea+toolbar either way.
const editModal = document.getElementById('editModal');
const editContentEl = document.getElementById('editContent');
const editEyebrow = document.getElementById('editEyebrow');
wireToolbar(EDIT_IDS, () => editContentEl);
editContentEl.addEventListener('input', () => autoGrow(editContentEl, 280));

function openEditModal(m) {
  currentEditMessage = m;
  const isText = m.content_type === 'text';
  editEyebrow.textContent = isText ? 'Edit entry' : 'Edit caption & details';

  // Messages saved before this update may carry old rich-HTML formatting
  // (content_html/caption_html) instead of marker text. We show the
  // plain-text version here for editing — the old per-word formatting
  // isn't editable going forward, but the text itself is preserved.
  editContentEl.value = isText ? (m.content || '') : (m.caption || '');
  autoGrow(editContentEl, 280);

  document.getElementById('editSender').value = m.sender;
  document.getElementById('editTimestamp').value = fromIsoToLocalInput(m.timestamp);
  editModal.classList.remove('hidden');
}
document.getElementById('editCancelBtn').addEventListener('click', () => {
  editModal.classList.add('hidden');
  currentEditMessage = null;
});
document.getElementById('editSaveBtn').addEventListener('click', async () => {
  if (!currentEditMessage) return;
  const body = {
    sender: document.getElementById('editSender').value,
    timestamp: toIso(document.getElementById('editTimestamp').value),
    content: editContentEl.value
  };
  await fetch(`${API}/messages/${currentEditMessage.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  editModal.classList.add('hidden');
  currentEditMessage = null;
  await loadMessages(activeChatId, 'preserve');
  await loadChats();
});

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}
const compactDbBtn = document.getElementById('compactDbBtn');
compactDbBtn.addEventListener('click', async () => {
  const original = compactDbBtn.textContent;
  compactDbBtn.textContent = 'Compacting…';
  compactDbBtn.disabled = true;
  try {
    const res = await fetch(`${API}/db-compact`, { method: 'POST' });
    const data = await res.json();
    compactDbBtn.textContent = data.freed_bytes > 0
      ? `Freed ${formatBytes(data.freed_bytes)}`
      : 'Already compact';
    compactDbBtn.classList.add('done');
  } catch (err) {
    compactDbBtn.textContent = 'Failed — try again';
  }
  compactDbBtn.disabled = false;
  setTimeout(() => { compactDbBtn.textContent = original; compactDbBtn.classList.remove('done'); }, 3000);
});

loadSettings();
loadChats();
