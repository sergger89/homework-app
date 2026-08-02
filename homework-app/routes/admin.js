const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { UPLOADS_DIR } = require('../db');
const upload = require('../lib/upload');
const {
  requireAuth, requireRole, hasChildAccess, deleteUploadedFile,
  getCoinBalance, awardCoinsForTaskIfNeeded, getSilverBalance, awardSilverForTaskIfNeeded,
  awardTaskCurrencies, getCurrentHunger, getHungerDecayHours, setHungerDecayHours, feedMascot,
  getExtraAttempts, refreshSessionUser, stripAnswer, getSubmissions,
  REGULAR_ATTEMPTS, TOTAL_ATTEMPTS, COINS_PER_TASK, SILVER_PER_TASK,
  DEFAULT_HUNGER_DECAY_HOURS, ATTEMPT_PACK_SIZE, ATTEMPT_PACK_COST, MIN_PASSWORD_LENGTH,
} = require('../lib/helpers');
const bcrypt = require('bcryptjs');

const router = express.Router();

// ---------- список детей, доступных текущему пользователю ----------
router.get('/api/children', requireRole(['admin', 'parent']), (req, res) => {
  let children;
  if (req.session.user.role === 'admin') {
    children = db.prepare("SELECT id, username, display_name, avatar_path FROM users WHERE role='child' ORDER BY display_name").all();
  } else {
    children = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.avatar_path
         FROM users u
         JOIN parent_child pc ON pc.child_id = u.id
         WHERE pc.parent_id = ?
         ORDER BY u.display_name`
      )
      .all(req.session.user.id);
  }
  res.json({ children });
});

router.post('/api/children', requireRole(['admin', 'parent']), (req, res) => {
  const { username, password, displayName, parentId } = req.body || {};
  if (!username || !password || !displayName) {
    return res.status(400).json({ error: 'username_password_displayName_required' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  const existing = db.prepare('SELECT 1 FROM users WHERE username=?').get(username);
  if (existing) return res.status(409).json({ error: 'username_taken' });

  const insertUser = db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)');
  const insertLink = db.prepare('INSERT INTO parent_child (parent_id, child_id, granted_by) VALUES (?,?,?)');

  const tx = db.transaction(() => {
    const info = insertUser.run(username, bcrypt.hashSync(password, 10), 'child', displayName);
    const childId = info.lastInsertRowid;
    if (req.session.user.role === 'parent') {
      insertLink.run(req.session.user.id, childId, 'creator');
    } else if (req.session.user.role === 'admin' && parentId) {
      insertLink.run(parentId, childId, 'admin');
    }
    return childId;
  });

  const childId = tx();
  res.json({ ok: true, childId });
});

// ---------- управление пользователями (только admin) ----------
router.get('/api/admin/users', requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id, username, role, display_name, avatar_path, created_at FROM users ORDER BY role, display_name').all();
  const links = db
    .prepare(
      `SELECT pc.parent_id, pc.child_id, pc.granted_by, p.display_name as parent_name, c.display_name as child_name
       FROM parent_child pc JOIN users p ON p.id = pc.parent_id JOIN users c ON c.id = pc.child_id`
    )
    .all();
  res.json({ users, links });
});

router.post('/api/admin/users', requireRole('admin'), (req, res) => {
  const { username, password, displayName, role, parentId } = req.body || {};
  if (!username || !password || !displayName || !['parent', 'child', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  const existing = db.prepare('SELECT 1 FROM users WHERE username=?').get(username);
  if (existing) return res.status(409).json({ error: 'username_taken' });

  const info = db
    .prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)')
    .run(username, bcrypt.hashSync(password, 10), role, displayName);

  if (role === 'child' && parentId) {
    db.prepare('INSERT INTO parent_child (parent_id, child_id, granted_by) VALUES (?,?,?)').run(parentId, info.lastInsertRowid, 'admin');
  }
  res.json({ ok: true, userId: info.lastInsertRowid });
});

// смена роли пользователя
router.patch('/api/admin/users/:id/role', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const { role } = req.body || {};
  if (!['admin', 'parent', 'child'].includes(role)) return res.status(400).json({ error: 'invalid_role' });

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!user) return res.status(404).json({ error: 'not_found' });

  if (user.role === 'admin' && role !== 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'cannot_demote_last_admin' });
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
    // если пользователь перестал быть ребёнком - убираем его из всех parent_child как ребёнка
    if (user.role === 'child' && role !== 'child') {
      db.prepare('DELETE FROM parent_child WHERE child_id=?').run(id);
    }
    // если пользователь перестал быть родителем - убираем его как родителя из всех связей
    if (user.role === 'parent' && role !== 'parent') {
      db.prepare('DELETE FROM parent_child WHERE parent_id=?').run(id);
    }
  });
  tx();
  res.json({ ok: true });
});

// сброс пароля любого пользователя (админ)
router.post('/api/admin/users/:id/password', requireRole('admin'), (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: 'password_too_short' });
  const info = db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// смена отображаемого имени - только админ (по запросу пользователя, не самообслуживание)
router.post('/api/admin/users/:id/name', requireRole('admin'), (req, res) => {
  const { displayName } = req.body || {};
  if (!displayName || !displayName.trim()) return res.status(400).json({ error: 'display_name_required' });
  const info = db.prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName.trim(), req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

router.post('/api/admin/links', requireRole('admin'), (req, res) => {
  const { parentId, childId } = req.body || {};
  if (!parentId || !childId) return res.status(400).json({ error: 'parentId_childId_required' });
  db.prepare('INSERT OR IGNORE INTO parent_child (parent_id, child_id, granted_by) VALUES (?,?,?)').run(parentId, childId, 'admin');
  res.json({ ok: true });
});

router.delete('/api/admin/links', requireRole('admin'), (req, res) => {
  const { parentId, childId } = req.body || {};
  if (!parentId || !childId) return res.status(400).json({ error: 'parentId_childId_required' });
  db.prepare('DELETE FROM parent_child WHERE parent_id=? AND child_id=?').run(parentId, childId);
  res.json({ ok: true });
});

router.delete('/api/admin/users/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (user && user.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'cannot_delete_last_admin' });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  if (user && user.avatar_path) deleteUploadedFile(user.avatar_path);
  res.json({ ok: true });
});

router.post('/api/admin/favicon', requireRole('admin'), upload.single('favicon'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const relPath = `/uploads/${req.file.filename}`;
  const old = db.prepare("SELECT value FROM app_settings WHERE key='favicon_path'").get();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('favicon_path', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(relPath);
  if (old?.value) deleteUploadedFile(old.value);
  res.json({ ok: true, faviconUrl: relPath });
});


module.exports = router;
