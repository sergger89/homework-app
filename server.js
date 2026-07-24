const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { gradeTask, validateAssignment } = require('./grading');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'please-change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }, // 30 дней
  })
);

// ---------- auth helpers ----------
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'not_authenticated' });
  next();
}

// roles: строка ('parent') или массив ролей (['admin','parent'])
function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    if (!req.session.user || !allowed.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

// проверка, что текущий пользователь (parent или admin) имеет доступ к ребёнку childId
function hasChildAccess(user, childId) {
  if (!childId) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'parent') return false;
  const row = db
    .prepare('SELECT 1 FROM parent_child WHERE parent_id=? AND child_id=?')
    .get(user.id, childId);
  return !!row;
}

function requireChildAccess(getChildId) {
  return (req, res, next) => {
    const childId = getChildId(req);
    if (!hasChildAccess(req.session.user, childId)) {
      return res.status(403).json({ error: 'no_access_to_child' });
    }
    next();
  };
}

// ---------- auth routes ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  req.session.user = { id: user.id, role: user.role, name: user.display_name };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// ---------- список детей, доступных текущему пользователю ----------
// admin -> все дети; parent -> только связанные с ним дети
app.get('/api/children', requireRole(['admin', 'parent']), (req, res) => {
  let children;
  if (req.session.user.role === 'admin') {
    children = db.prepare("SELECT id, username, display_name FROM users WHERE role='child' ORDER BY display_name").all();
  } else {
    children = db
      .prepare(
        `SELECT u.id, u.username, u.display_name
         FROM users u
         JOIN parent_child pc ON pc.child_id = u.id
         WHERE pc.parent_id = ?
         ORDER BY u.display_name`
      )
      .all(req.session.user.id);
  }
  res.json({ children });
});

// ---------- создание ребёнка (parent создаёт себе, admin может создать и сразу привязать к родителю) ----------
app.post('/api/children', requireRole(['admin', 'parent']), (req, res) => {
  const { username, password, displayName, parentId } = req.body || {};
  if (!username || !password || !displayName) {
    return res.status(400).json({ error: 'username_password_displayName_required' });
  }
  const existing = db.prepare('SELECT 1 FROM users WHERE username=?').get(username);
  if (existing) return res.status(409).json({ error: 'username_taken' });

  const insertUser = db.prepare(
    'INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)'
  );
  const insertLink = db.prepare(
    'INSERT INTO parent_child (parent_id, child_id, granted_by) VALUES (?,?,?)'
  );

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
  const users = db.prepare('SELECT id, username, role, display_name, created_at FROM users ORDER BY role, display_name').all();
  const links = db
    .prepare(
      `SELECT pc.parent_id, pc.child_id, pc.granted_by, p.display_name as parent_name, c.display_name as child_name
       FROM parent_child pc
       JOIN users p ON p.id = pc.parent_id
       JOIN users c ON c.id = pc.child_id`
    )
    .all();
  res.json({ users, links });
});

// создать любого пользователя (parent или child), с опциональной привязкой parentId для child
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
    db.prepare('INSERT INTO parent_child (parent_id, child_id, granted_by) VALUES (?,?,?)').run(
      parentId, info.lastInsertRowid, 'admin'
    );
  }
  res.json({ ok: true, userId: info.lastInsertRowid });
});

// выдать/отозвать доступ родителя к ребёнку
app.post('/api/admin/links', requireRole('admin'), (req, res) => {
  const { parentId, childId } = req.body || {};
  if (!parentId || !childId) return res.status(400).json({ error: 'parentId_childId_required' });
  db.prepare('INSERT OR IGNORE INTO parent_child (parent_id, child_id, granted_by) VALUES (?,?,?)').run(
    parentId, childId, 'admin'
  );
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
  if (id === req.session.user.id) {
    return res.status(400).json({ error: 'cannot_delete_self' });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok: true });
});

// смена собственного пароля (любая роль)
app.post('/api/me/password', requireAuth, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(
    bcrypt.hashSync(newPassword, 10), req.session.user.id
  );
  res.json({ ok: true });
});

// ---------- helper: убрать правильные ответы из задания перед отправкой ребёнку ----------
function stripAnswer(type, data) {
  const clean = { ...data };
  switch (type) {
    case 'choice_single':
      delete clean.correctIndex;
      break;
    case 'choice_multiple':
      delete clean.correctIndices;
      break;
    case 'open_text':
      delete clean.acceptedAnswers;
      delete clean.caseSensitive;
      break;
    case 'open_number':
      delete clean.correctValue;
      delete clean.tolerance;
      break;
    case 'matching':
      delete clean.correctPairs;
      break;
    case 'cloze':
      clean.blanks = (clean.blanks || []).map(() => ({}));
      break;
  }
  delete clean.explanation; // объяснение отдаём только после ответа
  return clean;
}

// ---------- assignments (child view / parent view) ----------
app.get('/api/assignments', requireAuth, (req, res) => {
  const role = req.session.user.role;
  const childId = role === 'child' ? req.session.user.id : req.query.childId ? Number(req.query.childId) : null;

  if (role !== 'child' && !childId) {
    return res.status(400).json({ error: 'childId_required' });
  }
  if (role !== 'child' && !hasChildAccess(req.session.user, childId)) {
    return res.status(403).json({ error: 'no_access_to_child' });
  }

  const assignments = db
    .prepare(
      `SELECT a.* FROM assignments a
       JOIN assignment_children ac ON ac.assignment_id = a.id
       WHERE ac.child_id = ?
       ORDER BY a.created_at DESC`
    )
    .all(childId);

  const result = assignments.map((a) => {
    const tasks = db.prepare('SELECT id FROM tasks WHERE assignment_id = ?').all(a.id);
    let doneCount = 0;
    let correctCount = 0;
    for (const t of tasks) {
      const sub = db.prepare('SELECT * FROM submissions WHERE task_id=? AND child_id=?').get(t.id, childId);
      if (sub) {
        doneCount++;
        if (sub.is_correct) correctCount++;
      }
    }
    return {
      id: a.id,
      subject: a.subject,
      title: a.title,
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

  // проверка доступа: ребёнок может видеть только своё назначенное задание;
  // родитель/админ — только если ребёнок в их зоне видимости и задание ему назначено
  const assignedToChild = childId
    ? db.prepare('SELECT 1 FROM assignment_children WHERE assignment_id=? AND child_id=?').get(assignment.id, childId)
    : null;

  if (role === 'child') {
    if (!assignedToChild) return res.status(403).json({ error: 'not_assigned' });
  } else {
    if (!childId || !hasChildAccess(req.session.user, childId) || !assignedToChild) {
      return res.status(403).json({ error: 'no_access' });
    }
  }

  const tasks = db.prepare('SELECT * FROM tasks WHERE assignment_id=? ORDER BY order_index').all(assignment.id);

  const tasksOut = tasks.map((t) => {
    const data = JSON.parse(t.data);
    const sub = db.prepare('SELECT * FROM submissions WHERE task_id=? AND child_id=?').get(t.id, childId);

    if (role !== 'child') {
      return {
        id: t.id,
        type: t.type,
        ...data,
        submission: sub ? { answer: JSON.parse(sub.answer), isCorrect: sub.is_correct === null ? null : !!sub.is_correct } : null,
      };
    }

    if (sub) {
      return {
        id: t.id,
        type: t.type,
        ...data,
        submission: { answer: JSON.parse(sub.answer), isCorrect: sub.is_correct === null ? null : !!sub.is_correct },
      };
    }
    return { id: t.id, type: t.type, ...stripAnswer(t.type, data), submission: null };
  });

  res.json({
    assignment: { id: assignment.id, subject: assignment.subject, title: assignment.title },
    tasks: tasksOut,
  });
});

// ---------- submit answer (child only) ----------
app.post('/api/tasks/:id/submit', requireRole('child'), (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });

  const assignedToChild = db
    .prepare('SELECT 1 FROM assignment_children WHERE assignment_id=? AND child_id=?')
    .get(task.assignment_id, req.session.user.id);
  if (!assignedToChild) return res.status(403).json({ error: 'not_assigned' });

  const existing = db
    .prepare('SELECT * FROM submissions WHERE task_id=? AND child_id=?')
    .get(task.id, req.session.user.id);
  if (existing) {
    return res.status(409).json({ error: 'already_submitted' });
  }

  const data = JSON.parse(task.data);
  const { answer } = req.body || {};
  const { isCorrect } = gradeTask({ type: task.type, ...data }, answer);

  const isCorrectValue = isCorrect === null ? null : (isCorrect ? 1 : 0);
  db.prepare(
    'INSERT INTO submissions (task_id, child_id, answer, is_correct) VALUES (?,?,?,?)'
  ).run(task.id, req.session.user.id, JSON.stringify(answer), isCorrectValue);

  // возвращаем эталонные данные, чтобы фронт мог сразу подсветить правильный ответ
  let correct;
  switch (task.type) {
    case 'choice_single': correct = data.correctIndex; break;
    case 'choice_multiple': correct = data.correctIndices; break;
    case 'open_text': correct = data.acceptedAnswers; break;
    case 'open_number': correct = data.correctValue; break;
    case 'matching': correct = data.correctPairs; break;
    case 'cloze': correct = data.blanks.map(b => b.acceptedAnswers[0]); break;
  }

  res.json({ isCorrect, explanation: data.explanation || null, correct });
});

// ---------- import assignment (parent или admin), с явным назначением детям ----------
app.post('/api/assignments/import', requireRole(['admin', 'parent']), (req, res) => {
  const { childIds, ...assignment } = req.body || {};
  const errors = validateAssignment(assignment);
  if (!Array.isArray(childIds) || childIds.length === 0) {
    errors.push('нужно указать хотя бы одного ребёнка в "childIds"');
  } else {
    for (const cid of childIds) {
      if (!hasChildAccess(req.session.user, cid)) {
        errors.push(`нет доступа к ребёнку с id=${cid}`);
      }
    }
  }
  if (errors.length) return res.status(400).json({ errors });

  const insertAssignment = db.prepare(
    'INSERT INTO assignments (subject, title, created_by) VALUES (?,?,?)'
  );
  const insertTask = db.prepare(
    'INSERT INTO tasks (assignment_id, order_index, type, data) VALUES (?,?,?,?)'
  );
  const insertLink = db.prepare(
    'INSERT INTO assignment_children (assignment_id, child_id) VALUES (?,?)'
  );

  const tx = db.transaction((a) => {
    const info = insertAssignment.run(a.subject, a.title, req.session.user.id);
    a.tasks.forEach((t, i) => {
      const { type, ...rest } = t;
      insertTask.run(info.lastInsertRowid, i, type, JSON.stringify(rest));
    });
    for (const cid of childIds) {
      insertLink.run(info.lastInsertRowid, cid);
    }
    return info.lastInsertRowid;
  });

  const id = tx(assignment);
  res.json({ ok: true, assignmentId: id });
});

app.delete('/api/assignments/:id', requireRole(['admin', 'parent']), (req, res) => {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id=?').get(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'not_found' });

  // разрешаем удалить создателю задания или админу
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
  if (!hasChildAccess(req.session.user, childId)) {
    return res.status(403).json({ error: 'no_access_to_child' });
  }

  const bySubject = db
    .prepare(
      `SELECT a.subject as subject,
              COUNT(DISTINCT tk.id) as totalTasks,
              COUNT(DISTINCT s.id) as doneTasks,
              SUM(CASE WHEN s.is_correct=1 THEN 1 ELSE 0 END) as correctTasks
       FROM assignments a
       JOIN assignment_children ac ON ac.assignment_id = a.id AND ac.child_id = ?
       JOIN tasks tk ON tk.assignment_id = a.id
       LEFT JOIN submissions s ON s.task_id = tk.id AND s.child_id = ?
       GROUP BY a.subject`
    )
    .all(childId, childId);

  const recent = db
    .prepare(
      `SELECT s.submitted_at, s.is_correct, a.subject, a.title
       FROM submissions s
       JOIN tasks tk ON tk.id = s.task_id
       JOIN assignments a ON a.id = tk.assignment_id
       WHERE s.child_id = ?
       ORDER BY s.submitted_at DESC
       LIMIT 30`
    )
    .all(childId);

  res.json({ bySubject, recent });
});

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Homework app listening on port ${PORT}`);
});
