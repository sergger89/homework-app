const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const db = require('./db');
const { UPLOADS_DIR } = require('./db');
const { gradeTask, validateAssignment } = require('./grading');

const REGULAR_ATTEMPTS = 3; // после стольких неверных попыток показываем объяснение и даём бонусную попытку
const TOTAL_ATTEMPTS = 4;   // после неё, если всё ещё неверно, показываем правильный ответ и блокируем
const COINS_PER_TASK = 10;  // фиксированная награда монетками за верно решённое задание

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '15mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'please-change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }, // 30 дней
  })
);

// ---------- file uploads (аватарки, favicon, импорт JSON) ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '';
      cb(null, `${file.fieldname}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 80 * 1024 * 1024 }, // 80MB (с запасом под epub-книги)
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'jsonfile') {
      return cb(null, true); // проверим content-type на стороне парсинга
    }
    if (file.fieldname === 'epub') {
      const ext = path.extname(file.originalname).toLowerCase();
      return cb(null, ext === '.epub');
    }
    const okTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon', 'image/svg+xml'];
    cb(null, okTypes.includes(file.mimetype));
  },
});
app.use('/uploads', express.static(UPLOADS_DIR));

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
function refreshSessionUser(req) {
  const u = db.prepare('SELECT id, role, display_name, avatar_path FROM users WHERE id=?').get(req.session.user.id);
  if (u) req.session.user = { id: u.id, role: u.role, name: u.display_name, avatarPath: u.avatar_path };
  return req.session.user;
}

// ---------- public settings (favicon и т.п.), доступно без логина ----------
app.get('/api/settings', (req, res) => {
  const favicon = db.prepare("SELECT value FROM app_settings WHERE key='favicon_path'").get();
  const mascot = db.prepare("SELECT value FROM app_settings WHERE key='mascot_path'").get();
  res.json({ faviconUrl: favicon ? favicon.value : null, mascotUrl: mascot ? mascot.value : null });
});

// ---------- auth routes ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  req.session.user = { id: user.id, role: user.role, name: user.display_name, avatarPath: user.avatar_path };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post('/api/me/password', requireAuth, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), req.session.user.id);
  res.json({ ok: true });
});

app.post('/api/me/avatar', requireAuth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const relPath = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar_path=? WHERE id=?').run(relPath, req.session.user.id);
  refreshSessionUser(req);
  res.json({ ok: true, avatarPath: relPath });
});

// ---------- список детей, доступных текущему пользователю ----------
app.get('/api/children', requireRole(['admin', 'parent']), (req, res) => {
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

app.post('/api/children', requireRole(['admin', 'parent']), (req, res) => {
  const { username, password, displayName, parentId } = req.body || {};
  if (!username || !password || !displayName) {
    return res.status(400).json({ error: 'username_password_displayName_required' });
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
app.get('/api/admin/users', requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id, username, role, display_name, avatar_path, created_at FROM users ORDER BY role, display_name').all();
  const links = db
    .prepare(
      `SELECT pc.parent_id, pc.child_id, pc.granted_by, p.display_name as parent_name, c.display_name as child_name
       FROM parent_child pc JOIN users p ON p.id = pc.parent_id JOIN users c ON c.id = pc.child_id`
    )
    .all();
  res.json({ users, links });
});

app.post('/api/admin/users', requireRole('admin'), (req, res) => {
  const { username, password, displayName, role, parentId } = req.body || {};
  if (!username || !password || !displayName || !['parent', 'child', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'invalid_input' });
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
app.patch('/api/admin/users/:id/role', requireRole('admin'), (req, res) => {
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
app.post('/api/admin/users/:id/password', requireRole('admin'), (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'password_too_short' });
  const info = db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

app.post('/api/admin/links', requireRole('admin'), (req, res) => {
  const { parentId, childId } = req.body || {};
  if (!parentId || !childId) return res.status(400).json({ error: 'parentId_childId_required' });
  db.prepare('INSERT OR IGNORE INTO parent_child (parent_id, child_id, granted_by) VALUES (?,?,?)').run(parentId, childId, 'admin');
  res.json({ ok: true });
});

app.delete('/api/admin/links', requireRole('admin'), (req, res) => {
  const { parentId, childId } = req.body || {};
  if (!parentId || !childId) return res.status(400).json({ error: 'parentId_childId_required' });
  db.prepare('DELETE FROM parent_child WHERE parent_id=? AND child_id=?').run(parentId, childId);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (user && user.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'cannot_delete_last_admin' });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok: true });
});

app.post('/api/admin/favicon', requireRole('admin'), upload.single('favicon'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const relPath = `/uploads/${req.file.filename}`;
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('favicon_path', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(relPath);
  res.json({ ok: true, faviconUrl: relPath });
});

// ---------- helper: убрать правильные ответы из задания перед отправкой ребёнку ----------
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

// ---------- assignment library (parent/admin) ----------
app.get('/api/assignments/library', requireRole(['admin', 'parent']), (req, res) => {
  const assignments =
    req.session.user.role === 'admin'
      ? db.prepare('SELECT * FROM assignments ORDER BY created_at DESC').all()
      : db.prepare('SELECT * FROM assignments WHERE created_by=? ORDER BY created_at DESC').all(req.session.user.id);

  const result = assignments.map((a) => {
    const taskCount = db.prepare('SELECT COUNT(*) c FROM tasks WHERE assignment_id=?').get(a.id).c;
    const assignedTo = db
      .prepare(
        `SELECT ac.child_id, u.display_name, ac.hidden, ac.reward_given
         FROM assignment_children ac JOIN users u ON u.id = ac.child_id
         WHERE ac.assignment_id=?`
      )
      .all(a.id);
    return {
      id: a.id,
      subject: a.subject,
      title: a.title,
      reward: a.reward,
      taskCount,
      createdAt: a.created_at,
      assignedTo,
    };
  });
  res.json({ assignments: result });
});

app.post('/api/assignments/:id/assign', requireRole(['admin', 'parent']), (req, res) => {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id=?').get(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'not_found' });
  if (req.session.user.role !== 'admin' && assignment.created_by !== req.session.user.id) {
    return res.status(403).json({ error: 'not_owner' });
  }
  const { childIds } = req.body || {};
  if (!Array.isArray(childIds) || childIds.length === 0) return res.status(400).json({ error: 'childIds_required' });
  for (const cid of childIds) {
    if (!hasChildAccess(req.session.user, cid)) return res.status(403).json({ error: `no_access_to_child_${cid}` });
  }
  const insert = db.prepare('INSERT OR IGNORE INTO assignment_children (assignment_id, child_id) VALUES (?,?)');
  const unhide = db.prepare('UPDATE assignment_children SET hidden=0 WHERE assignment_id=? AND child_id=?');
  const tx = db.transaction(() => {
    for (const cid of childIds) {
      insert.run(assignment.id, cid);
      unhide.run(assignment.id, cid);
    }
  });
  tx();
  res.json({ ok: true });
});

app.patch('/api/assignments/:id/visibility', requireRole(['admin', 'parent']), (req, res) => {
  const { childId, hidden } = req.body || {};
  if (!childId) return res.status(400).json({ error: 'childId_required' });
  if (!hasChildAccess(req.session.user, childId)) return res.status(403).json({ error: 'no_access_to_child' });
  const info = db
    .prepare('UPDATE assignment_children SET hidden=? WHERE assignment_id=? AND child_id=?')
    .run(hidden ? 1 : 0, req.params.id, childId);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

app.post('/api/assignments/:id/reset', requireRole(['admin', 'parent']), (req, res) => {
  const { childId } = req.body || {};
  if (!childId) return res.status(400).json({ error: 'childId_required' });
  if (!hasChildAccess(req.session.user, childId)) return res.status(403).json({ error: 'no_access_to_child' });
  db.prepare(
    `DELETE FROM submissions WHERE child_id=? AND task_id IN (SELECT id FROM tasks WHERE assignment_id=?)`
  ).run(childId, req.params.id);
  db.prepare('UPDATE assignment_children SET reward_given=0 WHERE assignment_id=? AND child_id=?').run(req.params.id, childId);
  res.json({ ok: true });
});

app.patch('/api/assignments/:id/reward', requireRole(['admin', 'parent']), (req, res) => {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id=?').get(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'not_found' });
  if (req.session.user.role !== 'admin' && assignment.created_by !== req.session.user.id) {
    return res.status(403).json({ error: 'not_owner' });
  }
  const { reward } = req.body || {};
  db.prepare('UPDATE assignments SET reward=? WHERE id=?').run(reward || null, req.params.id);
  res.json({ ok: true });
});

app.post('/api/assignments/:id/reward-given', requireRole(['admin', 'parent']), (req, res) => {
  const { childId, given } = req.body || {};
  if (!childId) return res.status(400).json({ error: 'childId_required' });
  if (!hasChildAccess(req.session.user, childId)) return res.status(403).json({ error: 'no_access_to_child' });
  db.prepare('UPDATE assignment_children SET reward_given=? WHERE assignment_id=? AND child_id=?').run(
    given ? 1 : 0, req.params.id, childId
  );
  res.json({ ok: true });
});

// ---------- assignments (child view / parent view) ----------
app.get('/api/assignments', requireAuth, (req, res) => {
  const role = req.session.user.role;
  const childId = role === 'child' ? req.session.user.id : req.query.childId ? Number(req.query.childId) : null;

  if (role !== 'child' && !childId) return res.status(400).json({ error: 'childId_required' });
  if (role !== 'child' && !hasChildAccess(req.session.user, childId)) return res.status(403).json({ error: 'no_access_to_child' });

  const hiddenFilter = role === 'child' ? 'AND ac.hidden = 0' : '';
  const assignments = db
    .prepare(
      `SELECT a.*, ac.hidden, ac.reward_given FROM assignments a
       JOIN assignment_children ac ON ac.assignment_id = a.id
       WHERE ac.child_id = ? ${hiddenFilter}
       ORDER BY a.created_at DESC`
    )
    .all(childId);

  const result = assignments.map((a) => {
    const tasks = db.prepare('SELECT id FROM tasks WHERE assignment_id = ?').all(a.id);
    let doneCount = 0;
    let correctCount = 0;
    for (const t of tasks) {
      const subs = getSubmissions(t.id, childId);
      if (subs.length > 0) {
        doneCount++;
        const last = subs[subs.length - 1];
        if (last.is_correct) correctCount++;
      }
    }
    return {
      id: a.id,
      subject: a.subject,
      title: a.title,
      reward: a.reward,
      rewardGiven: !!a.reward_given,
      hidden: !!a.hidden,
      createdAt: a.created_at,
      totalTasks: tasks.length,
      doneTasks: doneCount,
      correctTasks: correctCount,
    };
  });
  res.json({ assignments: result });
});

app.get('/api/assignments/:id', requireAuth, (req, res) => {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id=?').get(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'not_found' });

  const role = req.session.user.role;
  const childId = role === 'child' ? req.session.user.id : req.query.childId ? Number(req.query.childId) : null;

  const link = childId
    ? db.prepare('SELECT * FROM assignment_children WHERE assignment_id=? AND child_id=?').get(assignment.id, childId)
    : null;

  if (role === 'child') {
    if (!link || link.hidden) return res.status(403).json({ error: 'not_assigned' });
  } else {
    if (!childId || !hasChildAccess(req.session.user, childId) || !link) {
      return res.status(403).json({ error: 'no_access' });
    }
  }

  const tasks = db.prepare('SELECT * FROM tasks WHERE assignment_id=? ORDER BY order_index').all(assignment.id);

  const tasksOut = tasks.map((t) => {
    const data = JSON.parse(t.data);
    const subs = getSubmissions(t.id, childId).map((s) => ({
      attemptNumber: s.attempt_number,
      answer: JSON.parse(s.answer),
      isCorrect: s.is_correct === null ? null : !!s.is_correct,
      manuallyGraded: !!s.manually_graded,
      flaggedForReview: !!s.flagged_for_review,
      submittedAt: s.submitted_at,
    }));
    const last = subs[subs.length - 1] || null;
    const locked = subs.length >= TOTAL_ATTEMPTS || !!(last && last.isCorrect === true);
    const attemptsLeft = Math.max(0, TOTAL_ATTEMPTS - subs.length);
    // после 3 неверных попыток показываем объяснение (но не сам ответ) и даём бонусную попытку
    const explanationRevealed = !locked && subs.length >= REGULAR_ATTEMPTS && last && last.isCorrect === false;

    if (role !== 'child') {
      // родителю/админу — всегда полные данные с эталонными ответами и всей историей попыток
      return { id: t.id, type: t.type, ...data, attempts: subs, attemptsLeft, locked };
    }

    if (locked) {
      return { id: t.id, type: t.type, ...data, attempts: subs, attemptsLeft, locked };
    }
    // ещё есть попытки: эталонный ответ не показываем, но объяснение — можем (после 3-й неверной)
    return { id: t.id, type: t.type, ...stripAnswer(t.type, data, { revealExplanation: explanationRevealed }), attempts: subs, attemptsLeft, locked };
  });

  res.json({
    assignment: { id: assignment.id, subject: assignment.subject, title: assignment.title, reward: assignment.reward },
    tasks: tasksOut,
  });
});

// ---------- submit answer (child only, 3 обычные + 1 бонусная попытка) ----------
app.post('/api/tasks/:id/submit', requireRole('child'), (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });

  const link = db
    .prepare('SELECT * FROM assignment_children WHERE assignment_id=? AND child_id=?')
    .get(task.assignment_id, req.session.user.id);
  if (!link || link.hidden) return res.status(403).json({ error: 'not_assigned' });

  const existing = getSubmissions(task.id, req.session.user.id);
  const lastCorrect = existing.length > 0 && existing[existing.length - 1].is_correct === 1;
  if (lastCorrect) return res.status(409).json({ error: 'already_correct' });
  if (existing.length >= TOTAL_ATTEMPTS) return res.status(409).json({ error: 'no_attempts_left' });

  const data = JSON.parse(task.data);
  const { answer } = req.body || {};
  const { isCorrect } = gradeTask({ type: task.type, ...data }, answer);
  const attemptNumber = existing.length + 1;
  const isManual = isCorrect === null;
  // для заданий с ручной проверкой разрешаем только одну попытку до оценки родителем
  if (isManual && existing.length >= 1) {
    return res.status(409).json({ error: 'awaiting_manual_review' });
  }

  const isCorrectValue = isCorrect === null ? null : (isCorrect ? 1 : 0);
  db.prepare(
    'INSERT INTO submissions (task_id, child_id, attempt_number, answer, is_correct) VALUES (?,?,?,?,?)'
  ).run(task.id, req.session.user.id, attemptNumber, JSON.stringify(answer), isCorrectValue);

  let coinsEarned = 0;
  if (isCorrect === true) {
    awardCoinsForTaskIfNeeded(task.id, req.session.user.id);
    coinsEarned = COINS_PER_TASK;
  }

  const attemptsLeft = Math.max(0, TOTAL_ATTEMPTS - attemptNumber);
  const locked = attemptNumber >= TOTAL_ATTEMPTS || isCorrect === true;
  // после 3-й неверной попытки показываем объяснение и даём бонусную (4-ю) попытку,
  // но правильный ответ пока не раскрываем
  const explanationOnly = !locked && attemptNumber >= REGULAR_ATTEMPTS && isCorrect === false;

  let correct;
  if (locked) {
    switch (task.type) {
      case 'choice_single': correct = data.correctIndex; break;
      case 'choice_multiple': correct = data.correctIndices; break;
      case 'open_text': correct = data.acceptedAnswers; break;
      case 'open_number': correct = data.correctValue; break;
      case 'matching': correct = data.correctPairs; break;
      case 'cloze': correct = data.blanks.map((b) => b.acceptedAnswers[0]); break;
    }
  }

  res.json({
    isCorrect,
    explanation: locked || explanationOnly ? data.explanation || null : null,
    bonusAttemptGranted: explanationOnly,
    correct,
    attemptNumber,
    attemptsLeft,
    locked,
    coinsEarned,
    coinBalance: getCoinBalance(req.session.user.id),
  });
});

// ребёнок просит родителя перепроверить его последний ответ вручную (даже если тот уже
// проверен автоматически) - например, если ребёнок не согласен с автопроверкой
app.post('/api/tasks/:id/flag-review', requireRole('child'), (req, res) => {
  const subs = getSubmissions(req.params.id, req.session.user.id);
  if (subs.length === 0) return res.status(400).json({ error: 'no_submission_yet' });
  const last = subs[subs.length - 1];
  if (last.manually_graded) return res.status(409).json({ error: 'already_graded' });
  db.prepare('UPDATE submissions SET flagged_for_review=1 WHERE id=?').run(last.id);
  res.json({ ok: true });
});

// ручная проверка/переоценка задания родителем или админом (для needsManualReview или в целом коррекция)
app.post('/api/tasks/:id/grade', requireRole(['admin', 'parent']), (req, res) => {
  const { childId, isCorrect } = req.body || {};
  if (!childId || typeof isCorrect !== 'boolean') return res.status(400).json({ error: 'childId_isCorrect_required' });
  if (!hasChildAccess(req.session.user, childId)) return res.status(403).json({ error: 'no_access_to_child' });

  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });

  const subs = getSubmissions(task.id, childId);
  if (subs.length === 0) return res.status(400).json({ error: 'no_submission_yet' });
  const last = subs[subs.length - 1];
  db.prepare('UPDATE submissions SET is_correct=?, manually_graded=1, flagged_for_review=0 WHERE id=?').run(isCorrect ? 1 : 0, last.id);
  if (isCorrect) awardCoinsForTaskIfNeeded(task.id, childId);
  res.json({ ok: true });
});

// список всех ответов, ожидающих внимания родителя/админа (across всех доступных детей):
// задания на ручную проверку (needsManualReview) + вручную отмеченные ребёнком "перепроверь"
app.get('/api/parent/pending-review', requireRole(['admin', 'parent']), (req, res) => {
  const childrenRows =
    req.session.user.role === 'admin'
      ? db.prepare("SELECT id, display_name FROM users WHERE role='child'").all()
      : db
          .prepare(
            `SELECT u.id, u.display_name FROM users u
             JOIN parent_child pc ON pc.child_id = u.id WHERE pc.parent_id = ?`
          )
          .all(req.session.user.id);
  const childIds = childrenRows.map((c) => c.id);
  if (childIds.length === 0) return res.json({ items: [] });

  const placeholders = childIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT s.id as submission_id, s.task_id, s.child_id, s.answer, s.is_correct, s.flagged_for_review,
              s.submitted_at, tk.type as task_type, tk.data as task_data,
              a.id as assignment_id, a.title as assignment_title, a.subject as subject
       FROM submissions s
       JOIN tasks tk ON tk.id = s.task_id
       JOIN assignments a ON a.id = tk.assignment_id
       WHERE s.manually_graded = 0
         AND (s.is_correct IS NULL OR s.flagged_for_review = 1)
         AND s.child_id IN (${placeholders})
         AND s.id = (SELECT MAX(id) FROM submissions s2 WHERE s2.task_id = s.task_id AND s2.child_id = s.child_id)
       ORDER BY s.submitted_at DESC`
    )
    .all(...childIds);

  const childNameById = Object.fromEntries(childrenRows.map((c) => [c.id, c.display_name]));
  const items = rows.map((r) => {
    const data = JSON.parse(r.task_data);
    return {
      submissionId: r.submission_id,
      taskId: r.task_id,
      childId: r.child_id,
      childName: childNameById[r.child_id],
      assignmentId: r.assignment_id,
      assignmentTitle: r.assignment_title,
      subject: r.subject,
      taskType: r.task_type,
      prompt: data.prompt || data.promptTemplate || '',
      answer: JSON.parse(r.answer),
      awaitingType: r.is_correct === null ? 'manual_review' : 'flagged_by_child',
      submittedAt: r.submitted_at,
    };
  });
  res.json({ items });
});


// ---------- import assignment (в библиотеку; можно сразу назначить detям через childIds) ----------
function importAssignmentHandler(req, res, assignmentBody) {
  const { childIds, ...assignment } = assignmentBody || {};
  const errors = validateAssignment(assignment);
  const targetChildIds = Array.isArray(childIds) ? childIds : [];
  for (const cid of targetChildIds) {
    if (!hasChildAccess(req.session.user, cid)) errors.push(`нет доступа к ребёнку с id=${cid}`);
  }
  if (errors.length) return res.status(400).json({ errors });

  const insertAssignment = db.prepare('INSERT INTO assignments (subject, title, reward, created_by) VALUES (?,?,?,?)');
  const insertTask = db.prepare('INSERT INTO tasks (assignment_id, order_index, type, data) VALUES (?,?,?,?)');
  const insertLink = db.prepare('INSERT OR IGNORE INTO assignment_children (assignment_id, child_id) VALUES (?,?)');

  const tx = db.transaction((a) => {
    const info = insertAssignment.run(a.subject, a.title, a.reward || null, req.session.user.id);
    a.tasks.forEach((t, i) => {
      const { type, ...rest } = t;
      insertTask.run(info.lastInsertRowid, i, type, JSON.stringify(rest));
    });
    for (const cid of targetChildIds) insertLink.run(info.lastInsertRowid, cid);
    return info.lastInsertRowid;
  });

  const id = tx(assignment);
  res.json({ ok: true, assignmentId: id });
}

app.post('/api/assignments/import', requireRole(['admin', 'parent']), (req, res) => {
  importAssignmentHandler(req, res, req.body);
});

// импорт из загруженного .json файла
app.post('/api/assignments/import-file', requireRole(['admin', 'parent']), upload.single('jsonfile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  let parsed;
  try {
    const raw = fs.readFileSync(req.file.path, 'utf-8');
    parsed = JSON.parse(raw);
  } catch (e) {
    return res.status(400).json({ errors: ['Файл не является корректным JSON'] });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
  let childIds = [];
  if (req.body.childIds) {
    try { childIds = JSON.parse(req.body.childIds); } catch (e) { childIds = []; }
  }
  parsed.childIds = childIds;
  importAssignmentHandler(req, res, parsed);
});

// обновить содержимое задания (например, добавили объяснения), сохраняя прогресс детей:
// задания сопоставляются по порядковому индексу в массиве tasks; если новых заданий
// больше - лишние добавляются; если меньше - лишние (вместе с ответами по ним) удаляются.
app.put('/api/assignments/:id', requireRole(['admin', 'parent']), (req, res) => {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id=?').get(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'not_found' });
  if (req.session.user.role !== 'admin' && assignment.created_by !== req.session.user.id) {
    return res.status(403).json({ error: 'not_owner' });
  }
  const body = req.body || {};
  const errors = validateAssignment(body);
  if (errors.length) return res.status(400).json({ errors });

  const existingTasks = db
    .prepare('SELECT id FROM tasks WHERE assignment_id=? ORDER BY order_index')
    .all(assignment.id);

  const updateAssignment = db.prepare('UPDATE assignments SET subject=?, title=?, reward=? WHERE id=?');
  const updateTask = db.prepare('UPDATE tasks SET type=?, data=? WHERE id=?');
  const insertTask = db.prepare('INSERT INTO tasks (assignment_id, order_index, type, data) VALUES (?,?,?,?)');
  const deleteTask = db.prepare('DELETE FROM tasks WHERE id=?');

  const tx = db.transaction(() => {
    updateAssignment.run(body.subject, body.title, body.reward || null, assignment.id);
    body.tasks.forEach((t, i) => {
      const { type, ...rest } = t;
      if (existingTasks[i]) {
        updateTask.run(type, JSON.stringify(rest), existingTasks[i].id);
      } else {
        insertTask.run(assignment.id, i, type, JSON.stringify(rest));
      }
    });
    // лишние старые задания (если новый список короче) удаляются вместе с ответами по ним
    for (let i = body.tasks.length; i < existingTasks.length; i++) {
      deleteTask.run(existingTasks[i].id);
    }
  });
  tx();
  res.json({ ok: true, tasksChanged: body.tasks.length !== existingTasks.length });
});

app.delete('/api/assignments/:id', requireRole(['admin', 'parent']), (req, res) => {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id=?').get(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'not_found' });
  if (req.session.user.role !== 'admin' && assignment.created_by !== req.session.user.id) {
    return res.status(403).json({ error: 'not_owner' });
  }
  db.prepare('DELETE FROM assignments WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- progress (parent/admin, для конкретного ребёнка) ----------
app.get('/api/progress', requireRole(['admin', 'parent']), (req, res) => {
  const childId = req.query.childId ? Number(req.query.childId) : null;
  if (!childId) return res.status(400).json({ error: 'childId_required' });
  if (!hasChildAccess(req.session.user, childId)) return res.status(403).json({ error: 'no_access_to_child' });

  const bySubject = db
    .prepare(
      `SELECT a.subject as subject,
              COUNT(DISTINCT tk.id) as totalTasks,
              COUNT(DISTINCT CASE WHEN s.attempt_number IS NOT NULL THEN tk.id END) as doneTasks,
              COUNT(DISTINCT CASE WHEN s.is_correct=1 THEN tk.id END) as correctTasks
       FROM assignments a
       JOIN assignment_children ac ON ac.assignment_id = a.id AND ac.child_id = ?
       JOIN tasks tk ON tk.assignment_id = a.id
       LEFT JOIN submissions s ON s.task_id = tk.id AND s.child_id = ?
       GROUP BY a.subject`
    )
    .all(childId, childId);

  const recent = db
    .prepare(
      `SELECT s.submitted_at, s.is_correct, s.attempt_number, a.subject, a.title, a.id as assignment_id, tk.id as task_id
       FROM submissions s
       JOIN tasks tk ON tk.id = s.task_id
       JOIN assignments a ON a.id = tk.assignment_id
       WHERE s.child_id = ?
       ORDER BY s.submitted_at DESC
       LIMIT 30`
    )
    .all(childId);

  const completedTodayRow = db
    .prepare(
      `SELECT COUNT(DISTINCT s.task_id) as count
       FROM submissions s
       WHERE s.child_id = ? AND date(s.submitted_at) = date('now')`
    )
    .get(childId);

  // количество попыток по каждому заданию (для отображения в панели прогресса)
  const attemptsByTask = db
    .prepare(
      `SELECT tk.id as task_id, a.id as assignment_id, a.title, COUNT(s.id) as attempts,
              MAX(CASE WHEN s.is_correct=1 THEN 1 ELSE 0 END) as solved
       FROM tasks tk
       JOIN assignments a ON a.id = tk.assignment_id
       JOIN assignment_children ac ON ac.assignment_id = a.id AND ac.child_id = ?
       LEFT JOIN submissions s ON s.task_id = tk.id AND s.child_id = ?
       GROUP BY tk.id
       HAVING attempts > 0
       ORDER BY a.title`
    )
    .all(childId, childId);

  res.json({ bySubject, recent, attemptsByTask, completedToday: completedTodayRow.count });
});

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- черновик (рисование) по заданию ----------
app.get('/api/tasks/:id/draft', requireAuth, (req, res) => {
  const role = req.session.user.role;
  const childId = role === 'child' ? req.session.user.id : req.query.childId ? Number(req.query.childId) : null;
  if (role !== 'child' && !hasChildAccess(req.session.user, childId)) {
    return res.status(403).json({ error: 'no_access_to_child' });
  }
  const row = db.prepare('SELECT strokes FROM drafts WHERE task_id=? AND child_id=?').get(req.params.id, childId);
  res.json({ strokes: row ? JSON.parse(row.strokes) : [] });
});

app.put('/api/tasks/:id/draft', requireRole('child'), (req, res) => {
  const { strokes } = req.body || {};
  if (!Array.isArray(strokes)) return res.status(400).json({ error: 'strokes_array_required' });
  db.prepare(
    `INSERT INTO drafts (task_id, child_id, strokes, updated_at) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(task_id, child_id) DO UPDATE SET strokes=excluded.strokes, updated_at=excluded.updated_at`
  ).run(req.params.id, req.session.user.id, JSON.stringify(strokes));
  res.json({ ok: true });
});

// ---------- книжная полка (epub) ----------
function visibleBookFilter(user) {
  // возвращает { where, params } для отбора книг, видимых пользователю
  if (user.role === 'admin') return { where: '1=1', params: [] };
  if (user.role === 'parent') {
    return { where: '(b.uploaded_by = ? OR u.role = \'admin\')', params: [user.id] };
  }
  // child: книги от админа (глобальные) + от любого из своих родителей
  return {
    where: `(u.role = 'admin' OR b.uploaded_by IN (SELECT parent_id FROM parent_child WHERE child_id = ?))`,
    params: [user.id],
  };
}

app.get('/api/books', requireAuth, (req, res) => {
  const { where, params } = visibleBookFilter(req.session.user);
  const childId = req.session.user.role === 'child' ? req.session.user.id : req.query.childId ? Number(req.query.childId) : null;
  if (childId && req.session.user.role !== 'child' && !hasChildAccess(req.session.user, childId)) {
    return res.status(403).json({ error: 'no_access_to_child' });
  }
  const books = db
    .prepare(
      `SELECT b.*, u.display_name as uploader_name, u.role as uploader_role
       FROM books b LEFT JOIN users u ON u.id = b.uploaded_by
       WHERE ${where} ORDER BY b.created_at DESC`
    )
    .all(...params);

  const result = books.map((b) => {
    let progress = null;
    let isFavorite = false;
    if (childId) {
      const p = db.prepare('SELECT location, percentage, updated_at FROM reading_progress WHERE book_id=? AND child_id=?').get(b.id, childId);
      progress = p || null;
      isFavorite = !!db.prepare('SELECT 1 FROM book_favorites WHERE book_id=? AND child_id=?').get(b.id, childId);
    }
    return {
      id: b.id, title: b.title, author: b.author, coverPath: b.cover_path, filePath: b.file_path,
      uploadedBy: b.uploader_name, canManage: req.session.user.role === 'admin' || b.uploaded_by === req.session.user.id,
      progress, isFavorite,
    };
  });
  res.json({ books: result });
});

app.get('/api/books/:id', requireAuth, (req, res) => {
  const { where, params } = visibleBookFilter(req.session.user);
  const childId = req.session.user.role === 'child' ? req.session.user.id : req.query.childId ? Number(req.query.childId) : null;
  const book = db
    .prepare(
      `SELECT b.*, u.display_name as uploader_name
       FROM books b LEFT JOIN users u ON u.id = b.uploaded_by
       WHERE b.id=? AND (${where})`
    )
    .get(req.params.id, ...params);
  if (!book) return res.status(404).json({ error: 'not_found' });
  let progress = null, isFavorite = false;
  if (childId) {
    progress = db.prepare('SELECT location, percentage, updated_at FROM reading_progress WHERE book_id=? AND child_id=?').get(book.id, childId) || null;
    isFavorite = !!db.prepare('SELECT 1 FROM book_favorites WHERE book_id=? AND child_id=?').get(book.id, childId);
  }
  res.json({
    book: {
      id: book.id, title: book.title, author: book.author, coverPath: book.cover_path, filePath: book.file_path,
      uploadedBy: book.uploader_name, progress, isFavorite,
    },
  });
});

app.post('/api/books', requireRole(['admin', 'parent']), upload.fields([{ name: 'epub', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), (req, res) => {
  const epubFile = req.files && req.files.epub && req.files.epub[0];
  if (!epubFile) return res.status(400).json({ error: 'no_file' });
  const coverFile = req.files && req.files.cover && req.files.cover[0];
  const { title, author } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title_required' });

  const info = db
    .prepare('INSERT INTO books (title, author, file_path, cover_path, uploaded_by) VALUES (?,?,?,?,?)')
    .run(title, author || null, `/uploads/${epubFile.filename}`, coverFile ? `/uploads/${coverFile.filename}` : null, req.session.user.id);
  res.json({ ok: true, bookId: info.lastInsertRowid });
});

app.delete('/api/books/:id', requireRole(['admin', 'parent']), (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id=?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'not_found' });
  if (req.session.user.role !== 'admin' && book.uploaded_by !== req.session.user.id) {
    return res.status(403).json({ error: 'not_owner' });
  }
  db.prepare('DELETE FROM books WHERE id=?').run(req.params.id);
  const filePath = path.join(UPLOADS_DIR, path.basename(book.file_path));
  fs.unlink(filePath, () => {});
  if (book.cover_path) fs.unlink(path.join(UPLOADS_DIR, path.basename(book.cover_path)), () => {});
  res.json({ ok: true });
});

app.get('/api/books/:id/progress', requireAuth, (req, res) => {
  const role = req.session.user.role;
  const childId = role === 'child' ? req.session.user.id : req.query.childId ? Number(req.query.childId) : null;
  if (role !== 'child' && (!childId || !hasChildAccess(req.session.user, childId))) {
    return res.status(403).json({ error: 'no_access_to_child' });
  }
  const p = db.prepare('SELECT location, percentage, updated_at FROM reading_progress WHERE book_id=? AND child_id=?').get(req.params.id, childId);
  res.json({ progress: p || null });
});

app.put('/api/books/:id/progress', requireRole('child'), (req, res) => {
  const { location, percentage } = req.body || {};
  db.prepare(
    `INSERT INTO reading_progress (book_id, child_id, location, percentage, updated_at) VALUES (?,?,?,?,datetime('now'))
     ON CONFLICT(book_id, child_id) DO UPDATE SET location=excluded.location, percentage=excluded.percentage, updated_at=excluded.updated_at`
  ).run(req.params.id, req.session.user.id, location || null, Number(percentage) || 0);
  res.json({ ok: true });
});

app.post('/api/books/:id/favorite', requireRole('child'), (req, res) => {
  db.prepare('INSERT OR IGNORE INTO book_favorites (book_id, child_id) VALUES (?,?)').run(req.params.id, req.session.user.id);
  res.json({ ok: true });
});
app.delete('/api/books/:id/favorite', requireRole('child'), (req, res) => {
  db.prepare('DELETE FROM book_favorites WHERE book_id=? AND child_id=?').run(req.params.id, req.session.user.id);
  res.json({ ok: true });
});

// ---------- заметки по книге (выделенный текст + комментарий) ----------
app.get('/api/books/:id/notes', requireAuth, (req, res) => {
  const role = req.session.user.role;
  const childId = role === 'child' ? req.session.user.id : req.query.childId ? Number(req.query.childId) : null;
  if (role !== 'child' && (!childId || !hasChildAccess(req.session.user, childId))) {
    return res.status(403).json({ error: 'no_access_to_child' });
  }
  const notes = db
    .prepare('SELECT * FROM book_notes WHERE book_id=? AND child_id=? ORDER BY created_at DESC')
    .all(req.params.id, childId);
  res.json({
    notes: notes.map((n) => ({
      id: n.id, cfiRange: n.cfi_range, excerpt: n.excerpt, comment: n.comment, color: n.color, createdAt: n.created_at,
    })),
  });
});

app.post('/api/books/:id/notes', requireRole('child'), (req, res) => {
  const { cfiRange, excerpt, comment, color } = req.body || {};
  if (!cfiRange || !excerpt) return res.status(400).json({ error: 'cfiRange_excerpt_required' });
  const info = db
    .prepare('INSERT INTO book_notes (book_id, child_id, cfi_range, excerpt, comment, color) VALUES (?,?,?,?,?,?)')
    .run(req.params.id, req.session.user.id, cfiRange, excerpt.slice(0, 2000), (comment || '').slice(0, 2000) || null, color || '#ffe066');
  res.json({ ok: true, noteId: info.lastInsertRowid });
});

app.patch('/api/books/:id/notes/:noteId', requireRole('child'), (req, res) => {
  const note = db.prepare('SELECT * FROM book_notes WHERE id=? AND book_id=? AND child_id=?').get(req.params.noteId, req.params.id, req.session.user.id);
  if (!note) return res.status(404).json({ error: 'not_found' });
  const { comment, color } = req.body || {};
  db.prepare('UPDATE book_notes SET comment=?, color=? WHERE id=?').run(
    comment !== undefined ? (comment || null) : note.comment,
    color || note.color,
    note.id
  );
  res.json({ ok: true });
});

app.delete('/api/books/:id/notes/:noteId', requireRole('child'), (req, res) => {
  db.prepare('DELETE FROM book_notes WHERE id=? AND book_id=? AND child_id=?').run(req.params.noteId, req.params.id, req.session.user.id);
  res.json({ ok: true });
});

// ---------- обработка ошибок загрузки файлов (multer) и прочих сбоев ----------
// без этого multer/Express при слишком большом файле или сетевом сбое отдавали бы HTML-страницу
// с ошибкой вместо понятного JSON, и фронтенд не мог показать пользователю причину.
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'file_too_large' });
    }
    return res.status(400).json({ error: 'upload_error', detail: err.message });
  }
  if (err) {
    console.error('Необработанная ошибка:', err);
    return res.status(500).json({ error: 'server_error' });
  }
  next();
});

// ---------- монеты и магазин наград ----------
app.get('/api/me/coins', requireAuth, (req, res) => {
  const childId = req.session.user.role === 'child' ? req.session.user.id : req.query.childId ? Number(req.query.childId) : null;
  if (req.session.user.role !== 'child' && (!childId || !hasChildAccess(req.session.user, childId))) {
    return res.status(403).json({ error: 'no_access_to_child' });
  }
  res.json({ balance: getCoinBalance(childId) });
});

function visibleShopFilter(user) {
  if (user.role === 'admin') return { where: '1=1', params: [] };
  if (user.role === 'parent') {
    return { where: '(si.created_by = ? OR u.role = \'admin\')', params: [user.id] };
  }
  return {
    where: `(u.role = 'admin' OR si.created_by IN (SELECT parent_id FROM parent_child WHERE child_id = ?))`,
    params: [user.id],
  };
}

app.get('/api/shop/items', requireAuth, (req, res) => {
  const { where, params } = visibleShopFilter(req.session.user);
  const activeFilter = req.session.user.role === 'child' ? 'AND si.active = 1' : '';
  const items = db
    .prepare(
      `SELECT si.*, u.display_name as creator_name FROM shop_items si
       LEFT JOIN users u ON u.id = si.created_by
       WHERE ${where} ${activeFilter}
       ORDER BY si.cost ASC`
    )
    .all(...params);
  res.json({
    items: items.map((i) => ({
      id: i.id, name: i.name, description: i.description, cost: i.cost, icon: i.icon, active: !!i.active,
      createdBy: i.creator_name, canManage: req.session.user.role === 'admin' || i.created_by === req.session.user.id,
    })),
  });
});

app.post('/api/shop/items', requireRole(['admin', 'parent']), (req, res) => {
  const { name, description, cost, icon } = req.body || {};
  if (!name || !Number.isFinite(Number(cost)) || Number(cost) <= 0) {
    return res.status(400).json({ error: 'name_and_positive_cost_required' });
  }
  const info = db
    .prepare('INSERT INTO shop_items (name, description, cost, icon, created_by) VALUES (?,?,?,?,?)')
    .run(name, description || null, Math.round(Number(cost)), icon || '🎁', req.session.user.id);
  res.json({ ok: true, itemId: info.lastInsertRowid });
});

app.patch('/api/shop/items/:id', requireRole(['admin', 'parent']), (req, res) => {
  const item = db.prepare('SELECT * FROM shop_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  if (req.session.user.role !== 'admin' && item.created_by !== req.session.user.id) {
    return res.status(403).json({ error: 'not_owner' });
  }
  const { name, description, cost, icon, active } = req.body || {};
  db.prepare('UPDATE shop_items SET name=?, description=?, cost=?, icon=?, active=? WHERE id=?').run(
    name ?? item.name,
    description !== undefined ? description : item.description,
    cost !== undefined ? Math.round(Number(cost)) : item.cost,
    icon || item.icon,
    active !== undefined ? (active ? 1 : 0) : item.active,
    item.id
  );
  res.json({ ok: true });
});

app.delete('/api/shop/items/:id', requireRole(['admin', 'parent']), (req, res) => {
  const item = db.prepare('SELECT * FROM shop_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  if (req.session.user.role !== 'admin' && item.created_by !== req.session.user.id) {
    return res.status(403).json({ error: 'not_owner' });
  }
  db.prepare('DELETE FROM shop_items WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/shop/purchase', requireRole('child'), (req, res) => {
  const { itemId } = req.body || {};
  const item = db.prepare('SELECT * FROM shop_items WHERE id=? AND active=1').get(itemId);
  if (!item) return res.status(404).json({ error: 'item_not_found' });

  try {
    const purchaseId = db.transaction(() => {
      const balance = getCoinBalance(req.session.user.id);
      if (balance < item.cost) throw new Error('insufficient_funds');
      const info = db
        .prepare('INSERT INTO shop_purchases (item_id, child_id, item_name_snapshot, cost_at_purchase, status) VALUES (?,?,?,?,?)')
        .run(item.id, req.session.user.id, item.name, item.cost, 'pending');
      db.prepare(
        "INSERT INTO coin_transactions (child_id, amount, reason, related_type, related_id) VALUES (?,?,?,?,?)"
      ).run(req.session.user.id, -item.cost, 'purchase', 'shop_purchase', info.lastInsertRowid);
      return info.lastInsertRowid;
    })();
    res.json({ ok: true, purchaseId, balance: getCoinBalance(req.session.user.id) });
  } catch (e) {
    if (e.message === 'insufficient_funds') return res.status(400).json({ error: 'insufficient_funds' });
    res.status(500).json({ error: 'purchase_failed' });
  }
});

app.get('/api/shop/purchases', requireAuth, (req, res) => {
  const childId = req.session.user.role === 'child' ? req.session.user.id : req.query.childId ? Number(req.query.childId) : null;
  if (req.session.user.role !== 'child' && (!childId || !hasChildAccess(req.session.user, childId))) {
    return res.status(403).json({ error: 'no_access_to_child' });
  }
  const purchases = db
    .prepare('SELECT * FROM shop_purchases WHERE child_id=? ORDER BY created_at DESC')
    .all(childId);
  res.json({
    purchases: purchases.map((p) => ({
      id: p.id, itemName: p.item_name_snapshot, cost: p.cost_at_purchase, status: p.status,
      createdAt: p.created_at, fulfilledAt: p.fulfilled_at,
    })),
  });
});

app.post('/api/shop/purchases/:id/fulfill', requireRole(['admin', 'parent']), (req, res) => {
  const purchase = db.prepare('SELECT * FROM shop_purchases WHERE id=?').get(req.params.id);
  if (!purchase) return res.status(404).json({ error: 'not_found' });
  if (!hasChildAccess(req.session.user, purchase.child_id)) return res.status(403).json({ error: 'no_access_to_child' });
  db.prepare("UPDATE shop_purchases SET status='fulfilled', fulfilled_at=datetime('now') WHERE id=?").run(purchase.id);
  res.json({ ok: true });
});

app.post('/api/admin/mascot', requireRole('admin'), upload.single('mascot'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const relPath = `/uploads/${req.file.filename}`;
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('mascot_path', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(relPath);
  res.json({ ok: true, mascotUrl: relPath });
});

app.listen(PORT, () => {
  console.log(`Homework app listening on port ${PORT}`);
});
