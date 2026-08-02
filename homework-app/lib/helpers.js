// Общие хелперы, используемые в нескольких группах роутов (auth/admin/assignments/shop/books).
// Вынесены в отдельный модуль при разбивке server.js на части - раньше все жили в одном
// огромном файле, теперь доступны через require('../lib/helpers') из любого роут-модуля.
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { UPLOADS_DIR } = require('../db');

const REGULAR_ATTEMPTS = 3; // после стольких неверных попыток показываем объяснение и даём бонусную попытку
const TOTAL_ATTEMPTS = 4;   // после неё, если всё ещё неверно, показываем правильный ответ и блокируем
const COINS_PER_TASK = 10;  // фиксированная награда монетками за верно решённое задание
const SILVER_PER_TASK = 10; // столько же серебряных монет за то же задание (на еду для маскота)
const DEFAULT_HUNGER_DECAY_HOURS = 4; // по умолчанию: со 100% до 0% за 4 часа без кормления (родитель может менять)
const ATTEMPT_PACK_SIZE = 3; // сколько доп. попыток покупается за раз
const ATTEMPT_PACK_COST = 1; // цена в золотых монетах за пачку доп. попыток
const MIN_PASSWORD_LENGTH = 6; // было 4 - слишком слабо

// Удаляет файл, ранее загруженный через /uploads (аватарка, обложка книги и т.п.), когда
// связанная запись в БД удаляется - иначе файлы оставались бы на диске бесконечно ("осиротевшие").
// Принимает путь вида "/uploads/имя-файла.ext" (как хранится в БД). Намеренно проверяем, что
// после разрешения пути (path.resolve, убирает "..") результат всё ещё внутри UPLOADS_DIR -
// на случай, если в поле путь придёт что-то неожиданное, не удаляем ничего за пределами папки.
function deleteUploadedFile(storedPath) {
  if (!storedPath || !storedPath.startsWith('/uploads/')) return;
  const filename = storedPath.replace('/uploads/', '');
  const fullPath = path.resolve(UPLOADS_DIR, filename);
  if (!fullPath.startsWith(path.resolve(UPLOADS_DIR))) return; // защита от выхода за пределы папки
  fs.unlink(fullPath, (err) => {
    if (err && err.code !== 'ENOENT') console.error('Не удалось удалить файл', fullPath, err.message);
  });
}

// ---------- auth helpers ----------
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'not_authenticated' });
  next();
}
function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    if (!req.session.user || !allowed.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}
function hasChildAccess(user, childId) {
  if (!childId) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'parent') return false;
  const row = db.prepare('SELECT 1 FROM parent_child WHERE parent_id=? AND child_id=?').get(user.id, childId);
  return !!row;
}

function getCoinBalance(childId) {
  const row = db.prepare('SELECT COALESCE(SUM(amount),0) as balance FROM coin_transactions WHERE child_id=?').get(childId);
  return row.balance;
}

// начисляем монеты за верно решённое задание - идемпотентно (не начислим второй раз за то же
// задание, даже если родитель потом несколько раз меняет оценку туда-обратно)
function awardCoinsForTaskIfNeeded(taskId, childId) {
  const existing = db
    .prepare("SELECT 1 FROM coin_transactions WHERE child_id=? AND related_type='task' AND related_id=?")
    .get(childId, taskId);
  if (existing) return;
  db.prepare(
    "INSERT INTO coin_transactions (child_id, amount, reason, related_type, related_id) VALUES (?,?,?,?,?)"
  ).run(childId, COINS_PER_TASK, 'task_correct', 'task', taskId);
}

function getSilverBalance(childId) {
  const row = db.prepare('SELECT COALESCE(SUM(amount),0) as balance FROM silver_transactions WHERE child_id=?').get(childId);
  return row.balance;
}

// серебро начисляется за то же самое событие (верно решённое задание), тем же способом
function awardSilverForTaskIfNeeded(taskId, childId) {
  const existing = db
    .prepare("SELECT 1 FROM silver_transactions WHERE child_id=? AND related_type='task' AND related_id=?")
    .get(childId, taskId);
  if (existing) return;
  db.prepare(
    "INSERT INTO silver_transactions (child_id, amount, reason, related_type, related_id) VALUES (?,?,?,?,?)"
  ).run(childId, SILVER_PER_TASK, 'task_correct', 'task', taskId);
}

// начисляем обе валюты сразу - используется во всех местах, где раньше начислялись только монеты
function awardTaskCurrencies(taskId, childId) {
  awardCoinsForTaskIfNeeded(taskId, childId);
  awardSilverForTaskIfNeeded(taskId, childId);
}

// голод маскота "протухает" со временем - считаем на лету от последнего сохранённого значения,
// а не фоновой задачей
function getCurrentHunger(childId) {
  const row = db.prepare('SELECT hunger, decay_hours, updated_at FROM mascot_hunger WHERE child_id=?').get(childId);
  if (!row) return 100;
  const decayHours = row.decay_hours || DEFAULT_HUNGER_DECAY_HOURS;
  const hoursSince = (Date.now() - new Date(row.updated_at + 'Z').getTime()) / 3600000;
  return Math.max(0, Math.min(100, row.hunger - (100 / decayHours) * Math.max(0, hoursSince)));
}

function getHungerDecayHours(childId) {
  const row = db.prepare('SELECT decay_hours FROM mascot_hunger WHERE child_id=?').get(childId);
  return row ? row.decay_hours : DEFAULT_HUNGER_DECAY_HOURS;
}

function setHungerDecayHours(childId, decayHours) {
  const current = getCurrentHunger(childId);
  db.prepare(
    `INSERT INTO mascot_hunger (child_id, hunger, decay_hours, updated_at) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(child_id) DO UPDATE SET decay_hours=excluded.decay_hours, hunger=excluded.hunger, updated_at=excluded.updated_at`
  ).run(childId, current, decayHours);
}

function feedMascot(childId, restoreAmount) {
  const current = getCurrentHunger(childId);
  const next = Math.max(0, Math.min(100, current + restoreAmount));
  db.prepare(
    `INSERT INTO mascot_hunger (child_id, hunger, updated_at) VALUES (?,?,datetime('now'))
     ON CONFLICT(child_id) DO UPDATE SET hunger=excluded.hunger, updated_at=excluded.updated_at`
  ).run(childId, next);
  return next;
}

function getExtraAttempts(taskId, childId) {
  const row = db.prepare('SELECT extra_attempts FROM attempt_purchases WHERE task_id=? AND child_id=?').get(taskId, childId);
  return row ? row.extra_attempts : 0;
}
function refreshSessionUser(req) {
  const u = db.prepare('SELECT id, role, display_name, avatar_path FROM users WHERE id=?').get(req.session.user.id);
  if (!u) return null; // пользователя удалили - вызывающий код должен обнулить сессию
  req.session.user = { id: u.id, role: u.role, name: u.display_name, avatarPath: u.avatar_path };
  return req.session.user;
}

// убирает правильные ответы из задания перед отправкой ребёнку (пока есть попытки)
function stripAnswer(type, data, { revealExplanation } = {}) {
  const clean = { ...data };
  switch (type) {
    case 'choice_single': delete clean.correctIndex; break;
    case 'choice_multiple': delete clean.correctIndices; break;
    case 'open_text': delete clean.acceptedAnswers; delete clean.caseSensitive; break;
    case 'open_number': delete clean.correctValue; delete clean.tolerance; break;
    case 'matching': delete clean.correctPairs; break;
    case 'cloze': clean.blanks = (clean.blanks || []).map(() => ({})); break;
  }
  if (!revealExplanation) delete clean.explanation;
  return clean;
}

function getSubmissions(taskId, childId) {
  return db
    .prepare('SELECT * FROM submissions WHERE task_id=? AND child_id=? ORDER BY attempt_number')
    .all(taskId, childId);
}

module.exports = {
  REGULAR_ATTEMPTS,
  TOTAL_ATTEMPTS,
  COINS_PER_TASK,
  SILVER_PER_TASK,
  DEFAULT_HUNGER_DECAY_HOURS,
  ATTEMPT_PACK_SIZE,
  ATTEMPT_PACK_COST,
  MIN_PASSWORD_LENGTH,
  deleteUploadedFile,
  requireAuth,
  requireRole,
  hasChildAccess,
  getCoinBalance,
  awardCoinsForTaskIfNeeded,
  getSilverBalance,
  awardSilverForTaskIfNeeded,
  awardTaskCurrencies,
  getCurrentHunger,
  getHungerDecayHours,
  setHungerDecayHours,
  feedMascot,
  getExtraAttempts,
  refreshSessionUser,
  stripAnswer,
  getSubmissions,
};
