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
const { gradeTask, validateAssignment } = require('../grading');

const router = express.Router();

// ---------- assignment library (parent/admin) ----------
router.get('/api/assignments/library', requireRole(['admin', 'parent']), (req, res) => {
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

router.post('/api/assignments/:id/assign', requireRole(['admin', 'parent']), (req, res) => {
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

router.patch('/api/assignments/:id/visibility', requireRole(['admin', 'parent']), (req, res) => {
  const { childId, hidden } = req.body || {};
  if (!childId) return res.status(400).json({ error: 'childId_required' });
  if (!hasChildAccess(req.session.user, childId)) return res.status(403).json({ error: 'no_access_to_child' });
  const info = db
    .prepare('UPDATE assignment_children SET hidden=? WHERE assignment_id=? AND child_id=?')
    .run(hidden ? 1 : 0, req.params.id, childId);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

router.post('/api/assignments/:id/reset', requireRole(['admin', 'parent']), (req, res) => {
  const { childId } = req.body || {};
  if (!childId) return res.status(400).json({ error: 'childId_required' });
  if (!hasChildAccess(req.session.user, childId)) return res.status(403).json({ error: 'no_access_to_child' });
  db.prepare(
    `DELETE FROM submissions WHERE child_id=? AND task_id IN (SELECT id FROM tasks WHERE assignment_id=?)`
  ).run(childId, req.params.id);
  db.prepare('UPDATE assignment_children SET reward_given=0 WHERE assignment_id=? AND child_id=?').run(req.params.id, childId);
  res.json({ ok: true });
});

router.patch('/api/assignments/:id/reward', requireRole(['admin', 'parent']), (req, res) => {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id=?').get(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'not_found' });
  if (req.session.user.role !== 'admin' && assignment.created_by !== req.session.user.id) {
    return res.status(403).json({ error: 'not_owner' });
  }
  const { reward } = req.body || {};
  db.prepare('UPDATE assignments SET reward=? WHERE id=?').run(reward || null, req.params.id);
  res.json({ ok: true });
});

router.post('/api/assignments/:id/reward-given', requireRole(['admin', 'parent']), (req, res) => {
  const { childId, given } = req.body || {};
  if (!childId) return res.status(400).json({ error: 'childId_required' });
  if (!hasChildAccess(req.session.user, childId)) return res.status(403).json({ error: 'no_access_to_child' });
  db.prepare('UPDATE assignment_children SET reward_given=? WHERE assignment_id=? AND child_id=?').run(
    given ? 1 : 0, req.params.id, childId
  );
  res.json({ ok: true });
});

// ---------- assignments (child view / parent view) ----------
router.get('/api/assignments', requireAuth, (req, res) => {
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

router.get('/api/assignments/:id', requireAuth, (req, res) => {
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
    const effectiveTotal = TOTAL_ATTEMPTS + getExtraAttempts(t.id, childId);
    const locked = subs.length >= effectiveTotal || !!(last && last.isCorrect === true);
    const attemptsLeft = Math.max(0, effectiveTotal - subs.length);
    // после 3 неверных попыток показываем объяснение (но не сам ответ) и даём бонусную попытку
    const explanationRevealed = !locked && subs.length >= REGULAR_ATTEMPTS && last && last.isCorrect === false;
    const canBuyAttempts = !locked && last && last.isCorrect === false;

    if (role !== 'child') {
      // родителю/админу — всегда полные данные с эталонными ответами и всей историей попыток
      return { id: t.id, type: t.type, ...data, attempts: subs, attemptsLeft, locked };
    }

    if (locked) {
      return { id: t.id, type: t.type, ...data, attempts: subs, attemptsLeft, locked };
    }
    // ещё есть попытки: эталонный ответ не показываем, но объяснение — можем (после 3-й неверной)
    return { id: t.id, type: t.type, ...stripAnswer(t.type, data, { revealExplanation: explanationRevealed }), attempts: subs, attemptsLeft, locked, canBuyAttempts };
  });

  res.json({
    assignment: { id: assignment.id, subject: assignment.subject, title: assignment.title, reward: assignment.reward },
    tasks: tasksOut,
  });
});

// ---------- submit answer (child only, 3 обычные + 1 бонусная попытка) ----------
router.post('/api/tasks/:id/submit', requireRole('child'), (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });

  const link = db
    .prepare('SELECT * FROM assignment_children WHERE assignment_id=? AND child_id=?')
    .get(task.assignment_id, req.session.user.id);
  if (!link || link.hidden) return res.status(403).json({ error: 'not_assigned' });

  const existing = getSubmissions(task.id, req.session.user.id);
  const lastCorrect = existing.length > 0 && existing[existing.length - 1].is_correct === 1;
  if (lastCorrect) return res.status(409).json({ error: 'already_correct' });
  const effectiveTotalAttempts = TOTAL_ATTEMPTS + getExtraAttempts(task.id, req.session.user.id);
  if (existing.length >= effectiveTotalAttempts) return res.status(409).json({ error: 'no_attempts_left' });

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
  let silverEarned = 0;
  if (isCorrect === true) {
    awardTaskCurrencies(task.id, req.session.user.id);
    coinsEarned = COINS_PER_TASK;
    silverEarned = SILVER_PER_TASK;
  }

  const attemptsLeft = Math.max(0, effectiveTotalAttempts - attemptNumber);
  const locked = attemptNumber >= effectiveTotalAttempts || isCorrect === true;
  // после 3-й неверной попытки показываем объяснение и даём бонусную (4-ю и далее, если докупили)
  // попытку, но правильный ответ пока не раскрываем
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
    canBuyAttempts: !locked && isCorrect === false,
    coinsEarned,
    coinBalance: getCoinBalance(req.session.user.id),
    silverEarned,
    silverBalance: getSilverBalance(req.session.user.id),
  });
});

// докупить +3 попытки на конкретное задание за 1 золотую монету - можно несколько раз подряд,
// но только пока задание не заблокировано (правильный ответ ещё не раскрыт)
router.post('/api/tasks/:id/buy-attempts', requireRole('child'), (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });

  const existing = getSubmissions(task.id, req.session.user.id);
  const lastCorrect = existing.length > 0 && existing[existing.length - 1].is_correct === 1;
  const extraSoFar = getExtraAttempts(task.id, req.session.user.id);
  const effectiveTotalAttempts = TOTAL_ATTEMPTS + extraSoFar;
  const locked = lastCorrect || existing.length >= effectiveTotalAttempts;
  if (locked) return res.status(409).json({ error: 'already_locked' });

  try {
    db.transaction(() => {
      const balance = getCoinBalance(req.session.user.id);
      if (balance < ATTEMPT_PACK_COST) throw new Error('insufficient_funds');
      db.prepare(
        "INSERT INTO coin_transactions (child_id, amount, reason, related_type, related_id) VALUES (?,?,?,?,?)"
      ).run(req.session.user.id, -ATTEMPT_PACK_COST, 'buy_attempts', 'task', task.id);
      db.prepare(
        `INSERT INTO attempt_purchases (task_id, child_id, extra_attempts) VALUES (?,?,?)
         ON CONFLICT(task_id, child_id) DO UPDATE SET extra_attempts = extra_attempts + excluded.extra_attempts`
      ).run(task.id, req.session.user.id, ATTEMPT_PACK_SIZE);
    })();
    res.json({
      ok: true,
      coinBalance: getCoinBalance(req.session.user.id),
      attemptsLeft: Math.max(0, TOTAL_ATTEMPTS + extraSoFar + ATTEMPT_PACK_SIZE - existing.length),
    });
  } catch (e) {
    if (e.message === 'insufficient_funds') return res.status(400).json({ error: 'insufficient_funds' });
    res.status(500).json({ error: 'purchase_failed' });
  }
});

// ребёнок просит родителя перепроверить его последний ответ вручную (даже если тот уже
// проверен автоматически) - например, если ребёнок не согласен с автопроверкой
router.post('/api/tasks/:id/flag-review', requireRole('child'), (req, res) => {
  const subs = getSubmissions(req.params.id, req.session.user.id);
  if (subs.length === 0) return res.status(400).json({ error: 'no_submission_yet' });
  const last = subs[subs.length - 1];
  if (last.manually_graded) return res.status(409).json({ error: 'already_graded' });
  db.prepare('UPDATE submissions SET flagged_for_review=1 WHERE id=?').run(last.id);
  res.json({ ok: true });
});

// ручная проверка/переоценка задания родителем или админом (для needsManualReview или в целом коррекция)
router.post('/api/tasks/:id/grade', requireRole(['admin', 'parent']), (req, res) => {
  const { childId, isCorrect } = req.body || {};
  if (!childId || typeof isCorrect !== 'boolean') return res.status(400).json({ error: 'childId_isCorrect_required' });
  if (!hasChildAccess(req.session.user, childId)) return res.status(403).json({ error: 'no_access_to_child' });

  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });

  const subs = getSubmissions(task.id, childId);
  if (subs.length === 0) return res.status(400).json({ error: 'no_submission_yet' });
  const last = subs[subs.length - 1];
  db.prepare('UPDATE submissions SET is_correct=?, manually_graded=1, flagged_for_review=0 WHERE id=?').run(isCorrect ? 1 : 0, last.id);
  if (isCorrect) awardTaskCurrencies(task.id, childId);
  res.json({ ok: true });
});

// список всех ответов, ожидающих внимания родителя/админа (across всех доступных детей):
// задания на ручную проверку (needsManualReview) + вручную отмеченные ребёнком "перепроверь"
router.get('/api/parent/pending-review', requireRole(['admin', 'parent']), (req, res) => {
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
      taskData: data, // полные данные задания (correctIndex/acceptedAnswers/blanks и т.п.) - чтобы родитель видел правильный ответ рядом с ответом ребёнка
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

router.post('/api/assignments/import', requireRole(['admin', 'parent']), (req, res) => {
  importAssignmentHandler(req, res, req.body);
});

// импорт из загруженного .json файла
router.post('/api/assignments/import-file', requireRole(['admin', 'parent']), upload.single('jsonfile'), (req, res) => {
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
router.put('/api/assignments/:id', requireRole(['admin', 'parent']), (req, res) => {
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

router.delete('/api/assignments/:id', requireRole(['admin', 'parent']), (req, res) => {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id=?').get(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'not_found' });
  if (req.session.user.role !== 'admin' && assignment.created_by !== req.session.user.id) {
    return res.status(403).json({ error: 'not_owner' });
  }
  db.prepare('DELETE FROM assignments WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- progress (parent/admin, для конкретного ребёнка) ----------
router.get('/api/progress', requireRole(['admin', 'parent']), (req, res) => {
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


// ---------- черновик (рисование) по заданию ----------
router.get('/api/tasks/:id/draft', requireAuth, (req, res) => {
  const role = req.session.user.role;
  const childId = role === 'child' ? req.session.user.id : req.query.childId ? Number(req.query.childId) : null;
  if (role !== 'child' && !hasChildAccess(req.session.user, childId)) {
    return res.status(403).json({ error: 'no_access_to_child' });
  }
  const row = db.prepare('SELECT strokes FROM drafts WHERE task_id=? AND child_id=?').get(req.params.id, childId);
  res.json({ strokes: row ? JSON.parse(row.strokes) : [] });
});

router.put('/api/tasks/:id/draft', requireRole('child'), (req, res) => {
  const { strokes } = req.body || {};
  if (!Array.isArray(strokes)) return res.status(400).json({ error: 'strokes_array_required' });
  db.prepare(
    `INSERT INTO drafts (task_id, child_id, strokes, updated_at) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(task_id, child_id) DO UPDATE SET strokes=excluded.strokes, updated_at=excluded.updated_at`
  ).run(req.params.id, req.session.user.id, JSON.stringify(strokes));
  res.json({ ok: true });
});


module.exports = router;
