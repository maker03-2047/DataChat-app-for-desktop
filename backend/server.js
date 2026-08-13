const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'media');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(MEDIA_DIR, 'avatars'), { recursive: true });

// ---------- Database ----------
const db = new Database(path.join(DATA_DIR, 'chat.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  content_type TEXT NOT NULL,     -- text | image | video | audio | file
  content TEXT,                   -- plain-text body (search/back-compat) OR relative media path
  file_name TEXT,
  font_family TEXT DEFAULT 'inherit',
  font_color TEXT DEFAULT '#111111',
  font_size TEXT DEFAULT '15px',
  bold INTEGER DEFAULT 0,
  italic INTEGER DEFAULT 0,
  timestamp TEXT NOT NULL,        -- user-editable display date/time (ISO)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---------- Lightweight migrations (safe to run every boot) ----------
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('chats', 'parent_id', 'TEXT');
ensureColumn('chats', 'pinned', 'INTEGER DEFAULT 0');
ensureColumn('chats', 'sort_order', 'INTEGER DEFAULT 0');
ensureColumn('messages', 'content_html', 'TEXT');       // rich per-word formatting
ensureColumn('messages', 'highlight_color', 'TEXT');    // whole-message default highlight
ensureColumn('messages', 'strikethrough', 'INTEGER DEFAULT 0');
ensureColumn('messages', 'strikethrough_color', 'TEXT');
ensureColumn('messages', 'caption', 'TEXT');            // optional caption for image/video/audio/file
ensureColumn('messages', 'caption_html', 'TEXT');

function uuid() {
  return crypto.randomUUID();
}

function safeUnlink(relOrAbsPath) {
  if (!relOrAbsPath) return;
  const full = path.isAbsolute(relOrAbsPath) ? relOrAbsPath : path.join(MEDIA_DIR, relOrAbsPath);
  try { fs.unlinkSync(full); } catch (err) { /* already gone, ignore */ }
}
function safeRemoveDir(dirPath) {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch (err) { /* already gone, ignore */ }
}

function wouldCreateCycle(chatId, newParentId) {
  let cur = newParentId;
  while (cur) {
    if (cur === chatId) return true;
    const row = db.prepare('SELECT parent_id FROM chats WHERE id = ?').get(cur);
    cur = row ? row.parent_id : null;
  }
  return false;
}

function deleteChatRecursive(chatId) {
  const children = db.prepare('SELECT id FROM chats WHERE parent_id = ?').all(chatId);
  children.forEach(c => deleteChatRecursive(c.id));
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat) return;
  db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
  db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
  if (chat.avatar) safeUnlink(chat.avatar);
  safeRemoveDir(path.join(MEDIA_DIR, chatId));
}

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use('/media', express.static(MEDIA_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Uploads (chat message media) ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const chatId = req.params.chatId;
      let sub = 'files';
      if (file.mimetype.startsWith('image/')) sub = 'images';
      else if (file.mimetype.startsWith('video/')) sub = 'videos';
      else if (file.mimetype.startsWith('audio/')) sub = 'audio';
      const dir = path.join(MEDIA_DIR, chatId, sub);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, uuid() + ext);
    }
  }),
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB
});

const uploadAvatar = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, path.join(MEDIA_DIR, 'avatars'));
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, req.params.id + '-' + Date.now() + ext);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 }
});

// ---------- Settings ----------
app.get('/api/settings', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app_name'").get();
  res.json({ app_name: row ? row.value : 'Keepsake' });
});

app.put('/api/settings', (req, res) => {
  const { app_name } = req.body;
  if (!app_name || !app_name.trim()) return res.status(400).json({ error: 'app_name required' });
  db.prepare("INSERT INTO settings (key, value) VALUES ('app_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(app_name.trim());
  res.json({ app_name: app_name.trim() });
});

function dbFileSize() {
  try { return fs.statSync(path.join(DATA_DIR, 'chat.db')).size; } catch (err) { return 0; }
}

app.get('/api/db-stats', (req, res) => {
  res.json({ size_bytes: dbFileSize() });
});

// Reclaims disk space SQLite has marked as free-but-not-returned after
// deletions. Deleting a message or chat already removes its data for
// good — this just lets the chat.db file itself shrink to match.
app.post('/api/db-compact', (req, res) => {
  const before = dbFileSize();
  db.exec('VACUUM');
  const after = dbFileSize();
  res.json({ before_bytes: before, after_bytes: after, freed_bytes: Math.max(0, before - after) });
});

// ---------- Chats ----------
app.get('/api/chats', (req, res) => {
  const rows = db.prepare(`
    SELECT chats.*, MAX(messages.timestamp) AS last_message_at
    FROM chats LEFT JOIN messages ON messages.chat_id = chats.id
    GROUP BY chats.id
  `).all();
  res.json(rows);
});

app.post('/api/chats', (req, res) => {
  const { name, parent_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  if (parent_id && !db.prepare('SELECT id FROM chats WHERE id = ?').get(parent_id)) {
    return res.status(400).json({ error: 'parent chat not found' });
  }
  const id = uuid();
  db.prepare('INSERT INTO chats (id, name, parent_id) VALUES (?, ?, ?)').run(id, name.trim(), parent_id || null);
  res.json(db.prepare('SELECT * FROM chats WHERE id = ?').get(id));
});

app.put('/api/chats/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const name = (req.body.name ?? existing.name).trim();
  db.prepare('UPDATE chats SET name = ? WHERE id = ?').run(name, req.params.id);
  res.json(db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id));
});

app.put('/api/chats/:id/pin', (req, res) => {
  const existing = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const pinned = req.body.pinned ? 1 : 0;
  let sortOrder = existing.sort_order;
  if (pinned) {
    const max = db.prepare('SELECT MAX(sort_order) AS m FROM chats WHERE pinned = 1 AND parent_id IS ?')
      .get(existing.parent_id);
    sortOrder = (max && max.m != null ? max.m : 0) + 10;
  }
  db.prepare('UPDATE chats SET pinned = ?, sort_order = ? WHERE id = ?').run(pinned, sortOrder, req.params.id);
  res.json(db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id));
});

// Move a chat: change its parent (file it inside another chat, or move to
// top level with parent_id: null), and/or reposition it among pinned siblings.
app.put('/api/chats/:id/move', (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  const parentId = req.body.parent_id ?? null;
  if (parentId === req.params.id) return res.status(400).json({ error: 'a chat cannot be its own parent' });
  if (parentId && wouldCreateCycle(req.params.id, parentId)) {
    return res.status(400).json({ error: 'that would create a loop' });
  }
  if (parentId && !db.prepare('SELECT id FROM chats WHERE id = ?').get(parentId)) {
    return res.status(400).json({ error: 'target chat not found' });
  }

  let sortOrder = chat.sort_order;
  if (req.body.insert_before) {
    const before = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.body.insert_before);
    if (before) {
      const siblings = db.prepare('SELECT * FROM chats WHERE parent_id IS ? AND pinned = 1 ORDER BY sort_order ASC')
        .all(parentId);
      const idx = siblings.findIndex(s => s.id === before.id);
      const insertAt = idx === -1 ? siblings.length : idx;
      siblings.splice(insertAt, 0, { id: req.params.id });
      const stmt = db.prepare('UPDATE chats SET sort_order = ? WHERE id = ?');
      let seen = false;
      siblings.forEach((s, i) => {
        if (s.id === req.params.id) { seen = true; sortOrder = i * 10; return; }
        stmt.run(i * 10, s.id);
      });
      if (!seen) sortOrder = siblings.length * 10;
    }
  }

  db.prepare('UPDATE chats SET parent_id = ?, sort_order = ? WHERE id = ?').run(parentId, sortOrder, req.params.id);
  res.json(db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id));
});

app.post('/api/chats/:id/duplicate', (req, res) => {
  const src = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'not found' });

  const newId = uuid();
  let newAvatar = null;
  if (src.avatar) {
    try {
      const ext = path.extname(src.avatar) || '.png';
      const destRel = path.join('avatars', newId + ext).split(path.sep).join('/');
      fs.copyFileSync(path.join(MEDIA_DIR, src.avatar), path.join(MEDIA_DIR, destRel));
      newAvatar = destRel;
    } catch (err) { /* avatar copy failed, duplicate proceeds without one */ }
  }

  db.prepare('INSERT INTO chats (id, name, avatar, parent_id, pinned, sort_order) VALUES (?, ?, ?, ?, 0, ?)')
    .run(newId, src.name + ' copy', newAvatar, src.parent_id, src.sort_order);

  const msgs = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC').all(req.params.id);
  const insertMsg = db.prepare(`
    INSERT INTO messages (id, chat_id, sender, content_type, content, content_html, file_name, caption, caption_html,
      font_family, font_color, font_size, bold, italic, highlight_color, strikethrough, strikethrough_color, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  msgs.forEach(m => {
    let newContent = m.content;
    if (m.content_type !== 'text') {
      try {
        const sub = path.dirname(m.content).split('/').slice(1).join('/');
        const destDir = path.join(MEDIA_DIR, newId, sub);
        fs.mkdirSync(destDir, { recursive: true });
        const destRel = path.join(newId, sub, path.basename(m.content)).split(path.sep).join('/');
        fs.copyFileSync(path.join(MEDIA_DIR, m.content), path.join(MEDIA_DIR, destRel));
        newContent = destRel;
      } catch (err) { /* file copy failed, message duplicates with a broken link */ }
    }
    insertMsg.run(
      uuid(), newId, m.sender, m.content_type, newContent, m.content_html, m.file_name, m.caption, m.caption_html,
      m.font_family, m.font_color, m.font_size, m.bold, m.italic,
      m.highlight_color, m.strikethrough, m.strikethrough_color, m.timestamp
    );
  });

  res.json(db.prepare('SELECT * FROM chats WHERE id = ?').get(newId));
});

app.delete('/api/chats/:id', (req, res) => {
  deleteChatRecursive(req.params.id);
  res.json({ ok: true });
});

app.post('/api/chats/:id/avatar', uploadAvatar.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const existing = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (existing && existing.avatar) safeUnlink(existing.avatar);
  const rel = path.relative(MEDIA_DIR, req.file.path).split(path.sep).join('/');
  db.prepare('UPDATE chats SET avatar = ? WHERE id = ?').run(rel, req.params.id);
  res.json(db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id));
});

// ---------- Messages ----------
app.get('/api/chats/:chatId/messages', (req, res) => {
  res.json(
    db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC, created_at ASC')
      .all(req.params.chatId)
  );
});

app.post('/api/chats/:chatId/messages', (req, res) => {
  const { sender, content, font_family, font_color, font_size, timestamp } = req.body;
  const plain = (content || '').trim();
  if (!plain) return res.status(400).json({ error: 'content required' });

  const id = uuid();
  const ts = timestamp || new Date().toISOString();
  db.prepare(`
    INSERT INTO messages (id, chat_id, sender, content_type, content, font_family, font_color, font_size, timestamp)
    VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?)
  `).run(
    id, req.params.chatId, sender || 'Me', plain,
    font_family || 'inherit', font_color || '#2E2A22', font_size || '15px',
    ts
  );
  res.json(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
});

app.post('/api/chats/:chatId/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const { sender, timestamp, caption, font_family, font_color, font_size } = req.body;
  const id = uuid();
  const rel = path.relative(MEDIA_DIR, req.file.path).split(path.sep).join('/');
  let content_type = 'file';
  if (req.file.mimetype.startsWith('image/')) content_type = 'image';
  else if (req.file.mimetype.startsWith('video/')) content_type = 'video';
  else if (req.file.mimetype.startsWith('audio/')) content_type = 'audio';
  const ts = timestamp || new Date().toISOString();
  const captionPlain = (caption || '').trim() || null;

  db.prepare(`
    INSERT INTO messages (id, chat_id, sender, content_type, content, file_name, caption,
      font_family, font_color, font_size, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.params.chatId, sender || 'Me', content_type, rel, req.file.originalname, captionPlain,
    font_family || 'inherit', font_color || '#2E2A22', font_size || '15px',
    ts
  );
  res.json(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
});

app.put('/api/messages/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const { content, font_family, font_color, font_size, timestamp, sender } = req.body;

  const isText = existing.content_type === 'text';
  let plain = existing.content;
  let caption = existing.caption;

  if (content !== undefined) {
    if (isText) plain = content;
    else caption = content || null;
  }

  db.prepare(`
    UPDATE messages SET
      content = ?, caption = ?,
      font_family = ?, font_color = ?, font_size = ?,
      timestamp = ?, sender = ?
    WHERE id = ?
  `).run(
    plain, caption,
    font_family ?? existing.font_family,
    font_color ?? existing.font_color,
    font_size ?? existing.font_size,
    timestamp ?? existing.timestamp,
    sender ?? existing.sender,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id));
});

app.delete('/api/messages/:id', (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.id);
  if (msg && msg.content_type !== 'text') safeUnlink(msg.content);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Self-hosted chat running on port ${PORT}`));
