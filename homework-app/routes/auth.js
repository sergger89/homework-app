const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { UPLOADS_DIR } = require('../db');
const upload = require('../lib/upload');
const rateLimit = require('express-rate-limit');
const {
  requireAuth, requireRole, hasChildAccess, deleteUploadedFile,
  getCoinBalance, awardCoinsForTaskIfNeeded, getSilverBalance, awardSilverForTaskIfNeeded,
  awardTaskCurrencies, getCurrentHunger, getHungerDecayHours, setHungerDecayHours, feedMascot,
  getExtraAttempts, refreshSessionUser, stripAnswer, getSubmissions,
  REGULAR_ATTEMPTS, TOTAL_ATTEMPTS, COINS_PER_TASK, SILVER_PER_TASK,
  DEFAULT_HUNGER_DECAY_HOURS, ATTEMPT_PACK_SIZE, ATTEMPT_PACK_COST, MIN_PASSWORD_LENGTH,
} = require('../lib/helpers');
const bcrypt = require('bcryptjs');

// Брутфорс-защита логина - без неё пароль можно было перебирать сколько угодно раз подряд.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 20, // 20 попыток с одного IP за окно - с запасом на опечатки нескольких пользователей за NAT
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_login_attempts' },
});

const router = express.Router();

// ---------- public settings (favicon и т.п.), доступно без логина ----------
router.get('/api/settings', (req, res) => {
  const favicon = db.prepare("SELECT value FROM app_settings WHERE key='favicon_path'").get();
  const mascot = db.prepare("SELECT value FROM app_settings WHERE key='mascot_path'").get();
  res.json({ faviconUrl: favicon ? favicon.value : null, mascotUrl: mascot ? mascot.value : null });
});

// ---------- auth routes ----------
router.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  req.session.user = { id: user.id, role: user.role, name: user.display_name, avatarPath: user.avatar_path };
  res.json({ ok: true, user: req.session.user });
});

router.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  // подтягиваем свежие данные из БД на каждый запрос - имя/роль/аватар могли поменяться
  // (например, админ сменил имя пользователю), а сессия иначе бы хранила устаревший кэш
  const user = refreshSessionUser(req);
  if (!user) { req.session.destroy(() => {}); return res.json({ user: null }); }
  res.json({ user });
});

router.post('/api/me/password', requireAuth, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), req.session.user.id);
  res.json({ ok: true });
});

router.post('/api/me/avatar', requireAuth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const relPath = `/uploads/${req.file.filename}`;
  const old = db.prepare('SELECT avatar_path FROM users WHERE id=?').get(req.session.user.id);
  db.prepare('UPDATE users SET avatar_path=? WHERE id=?').run(relPath, req.session.user.id);
  if (old?.avatar_path) deleteUploadedFile(old.avatar_path);
  refreshSessionUser(req);
  res.json({ ok: true, avatarPath: relPath });
});


module.exports = router;
