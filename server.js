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
function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).json({ error: 'forbidden' });
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

// список детей (нужен родителю для выбора, чей прогресс смотреть)
app.get('/api/children', requireRole('parent'), (req, res) => {
  const children = db.prepare("SELECT id, username, display_name FROM users WHERE role='child'").all();
  res.json({ children });
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

// ---------- assignments (child view) ----------
app.get('/api/assignments', requireAuth, (req, res) => {
  const assignments = db
    .prepare('SELECT * FROM assignments ORDER BY created_at DESC')
    .all();

  const childId = req.session.user.role === 'child' ? req.session.user.id : req.query.childId;

  const result = assignments.map((a) => {
    const tasks = db
      .prepare('SELECT id FROM tasks WHERE assignment_id = ?')
      .all(a.id);
    let doneCount = 0;
    let correctCount = 0;
    if (childId) {
      for (const t of tasks) {
        const sub = db
          .prepare('SELECT * FROM submissions WHERE task_id=? AND child_id=?')
          .get(t.id, childId);
        if (sub) {
          doneCount++;
          if (sub.is_correct) correctCount++;
        }
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

  const tasks = db
    .prepare('SELECT * FROM tasks WHERE assignment_id=? ORDER BY order_index')
    .all(assignment.id);

  const childId = req.session.user.role === 'child' ? req.session.user.id : req.query.childId;

  const tasksOut = tasks.map((t) => {
    const data = JSON.parse(t.data);
    const sub = childId
      ? db.prepare('SELECT * FROM submissions WHERE task_id=? AND child_id=?').get(t.id, childId)
      : null;

    if (req.session.user.role === 'parent') {
      // родителю показываем всё, включая правильные ответы и последний ответ ребёнка
      return {
        id: t.id,
        type: t.type,
        ...data,
        submission: sub ? { answer: JSON.parse(sub.answer), isCorrect: sub.is_correct === null ? null : !!sub.is_correct } : null,
      };
    }

    // ребёнку: если уже отвечал — показываем результат + объяснение, иначе прячем ответы
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

  res.json({ assignment: { id: assignment.id, subject: assignment.subject, title: assignment.title }, tasks: tasksOut });
});

// ---------- submit answer (child only) ----------
app.post('/api/tasks/:id/submit', requireRole('child'), (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });

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

// ---------- import assignment (parent only) ----------
app.post('/api/assignments/import', requireRole('parent'), (req, res) => {
  const assignment = req.body;
  const errors = validateAssignment(assignment);
  if (errors.length) return res.status(400).json({ errors });

  const insertAssignment = db.prepare(
    'INSERT INTO assignments (subject, title) VALUES (?,?)'
  );
  const insertTask = db.prepare(
    'INSERT INTO tasks (assignment_id, order_index, type, data) VALUES (?,?,?,?)'
  );

  const tx = db.transaction((a) => {
    const info = insertAssignment.run(a.subject, a.title);
    a.tasks.forEach((t, i) => {
      const { type, ...rest } = t;
      insertTask.run(info.lastInsertRowid, i, type, JSON.stringify(rest));
    });
    return info.lastInsertRowid;
  });

  const id = tx(assignment);
  res.json({ ok: true, assignmentId: id });
});

app.delete('/api/assignments/:id', requireRole('parent'), (req, res) => {
  db.prepare('DELETE FROM assignments WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- progress (parent only) ----------
app.get('/api/progress', requireRole('parent'), (req, res) => {
  const childId = req.query.childId;
  if (!childId) return res.status(400).json({ error: 'childId_required' });

  const bySubject = db
    .prepare(
      `SELECT a.subject as subject,
              COUNT(DISTINCT tk.id) as totalTasks,
              COUNT(DISTINCT s.id) as doneTasks,
              SUM(CASE WHEN s.is_correct=1 THEN 1 ELSE 0 END) as correctTasks
       FROM assignments a
       JOIN tasks tk ON tk.assignment_id = a.id
       LEFT JOIN submissions s ON s.task_id = tk.id AND s.child_id = ?
       GROUP BY a.subject`
    )
    .all(childId);

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
