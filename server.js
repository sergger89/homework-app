const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const db = require('./db');
const { UPLOADS_DIR } = require('./db');
const { gradeTask, validateAssignment } = require('./grading');

const MAX_ATTEMPTS = 3;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
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
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'jsonfile') {
      return cb(null, true); // проверим content-type на стороне парсинга
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
function refreshSessionUser(req) {
  const u = db.prepare('SELECT id, role, display_name, avatar_path FROM users WHERE id=?').get(req.session.user.id);
  if (u) req.session.user = { id: u.id, role: u.role, name: u.display_name, avatarPath: u.avatar_path };
  return req.session.user;
}

// ---------- public settings (favicon и т.п.), доступно без логина ----------
app.get('/api/settings', (req, res) => {
  const row = db.prepare("SELECT value FROM app_settings WHERE key='favicon_path'").get();
  res.json({ faviconUrl: row ? row.value : null });
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
function stripAnswer(type, data) {
  const clean = { ...data };
  switch (type) {
    case 'choice_single': delete clean.correctIndex; break;
    case 'choice_multiple': delete clean.correctIndices; break;
    case 'open_text': delete clean.acceptedAnswers; delete clean.caseSensitive; break;
    case 'open_number': delete clean.correctValue; delete clean.tolerance; break;
    case 'matching': delete clean.correctPairs; break;
    case 'cloze': clean.blanks = (clean.blanks || []).map(() => ({})); break;
  }
  delete clean.explanation;
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
      submittedAt: s.submitted_at,
    }));
    const last = subs[subs.length - 1] || null;
    const locked = subs.length >= MAX_ATTEMPTS || !!(last && last.isCorrect === true);
    const attemptsLeft = Math.max(0, MAX_ATTEMPTS - subs.length);

    if (role !== 'child') {
      // родителю/админу — всегда полные данные с эталонными ответами и всей историей попыток
      return { id: t.id, type: t.type, ...data, attempts: subs, attemptsLeft, locked };
    }

    if (locked || (last && last.isCorrect === true)) {
      return { id: t.id, type: t.type, ...data, attempts: subs, attemptsLeft, locked };
    }
    // ещё есть попытки и ответ пока не верный/не финальный — не показываем эталон
    return { id: t.id, type: t.type, ...stripAnswer(t.type, data), attempts: subs, attemptsLeft, locked };
  });

  res.json({
    assignment: { id: assignment.id, subject: assignment.subject, title: assignment.title, reward: assignment.reward },
    tasks: tasksOut,
  });
});

// ---------- submit answer (child only, до MAX_ATTEMPTS попыток) ----------
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
  if (existing.length >= MAX_ATTEMPTS) return res.status(409).json({ error: 'no_attempts_left' });

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

  const attemptsLeft = Math.max(0, MAX_ATTEMPTS - attemptNumber);
  const locked = attemptNumber >= MAX_ATTEMPTS || isCorrect === true;

  let correct;
  if (locked || isCorrect === true) {
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
    explanation: locked || isCorrect === true ? data.explanation || null : null,
    correct,
    attemptNumber,
    attemptsLeft,
    locked,
  });
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
  db.prepare('UPDATE submissions SET is_correct=?, manually_graded=1 WHERE id=?').run(isCorrect ? 1 : 0, last.id);
  res.json({ ok: true });
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

  res.json({ bySubject, recent, attemptsByTask });
});

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Homework app listening on port ${PORT}`);
});
