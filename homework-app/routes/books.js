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


const router = express.Router();

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

router.get('/api/books', requireAuth, (req, res) => {
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

router.get('/api/books/:id', requireAuth, (req, res) => {
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

router.post('/api/books', requireRole(['admin', 'parent']), upload.fields([{ name: 'epub', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), (req, res) => {
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

router.delete('/api/books/:id', requireRole(['admin', 'parent']), (req, res) => {
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

router.get('/api/books/:id/progress', requireAuth, (req, res) => {
  const role = req.session.user.role;
  const childId = role === 'child' ? req.session.user.id : req.query.childId ? Number(req.query.childId) : null;
  if (role !== 'child' && (!childId || !hasChildAccess(req.session.user, childId))) {
    return res.status(403).json({ error: 'no_access_to_child' });
  }
  const p = db.prepare('SELECT location, percentage, updated_at FROM reading_progress WHERE book_id=? AND child_id=?').get(req.params.id, childId);
  res.json({ progress: p || null });
});

router.put('/api/books/:id/progress', requireRole('child'), (req, res) => {
  const { location, percentage } = req.body || {};
  db.prepare(
    `INSERT INTO reading_progress (book_id, child_id, location, percentage, updated_at) VALUES (?,?,?,?,datetime('now'))
     ON CONFLICT(book_id, child_id) DO UPDATE SET location=excluded.location, percentage=excluded.percentage, updated_at=excluded.updated_at`
  ).run(req.params.id, req.session.user.id, location || null, Number(percentage) || 0);
  res.json({ ok: true });
});

router.post('/api/books/:id/favorite', requireRole('child'), (req, res) => {
  db.prepare('INSERT OR IGNORE INTO book_favorites (book_id, child_id) VALUES (?,?)').run(req.params.id, req.session.user.id);
  res.json({ ok: true });
});
router.delete('/api/books/:id/favorite', requireRole('child'), (req, res) => {
  db.prepare('DELETE FROM book_favorites WHERE book_id=? AND child_id=?').run(req.params.id, req.session.user.id);
  res.json({ ok: true });
});

// ---------- заметки по книге (выделенный текст + комментарий) ----------
router.get('/api/books/:id/notes', requireAuth, (req, res) => {
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

router.post('/api/books/:id/notes', requireRole('child'), (req, res) => {
  const { cfiRange, excerpt, comment, color } = req.body || {};
  if (!cfiRange || !excerpt) return res.status(400).json({ error: 'cfiRange_excerpt_required' });
  const info = db
    .prepare('INSERT INTO book_notes (book_id, child_id, cfi_range, excerpt, comment, color) VALUES (?,?,?,?,?,?)')
    .run(req.params.id, req.session.user.id, cfiRange, excerpt.slice(0, 2000), (comment || '').slice(0, 2000) || null, color || '#ffe066');
  res.json({ ok: true, noteId: info.lastInsertRowid });
});

router.patch('/api/books/:id/notes/:noteId', requireRole('child'), (req, res) => {
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

router.delete('/api/books/:id/notes/:noteId', requireRole('child'), (req, res) => {
  db.prepare('DELETE FROM book_notes WHERE id=? AND book_id=? AND child_id=?').run(req.params.noteId, req.params.id, req.session.user.id);
  res.json({ ok: true });
});


module.exports = router;
