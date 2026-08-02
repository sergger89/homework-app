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

// ---------- покупки, ожидающие выдачи, по всем детям родителя/админа (для значка-уведомления) ----------
router.get('/api/parent/pending-fulfillment', requireRole(['admin', 'parent']), (req, res) => {
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
      `SELECT id, child_id, item_name_snapshot, cost_at_purchase, created_at FROM shop_purchases
       WHERE status='pending' AND child_id IN (${placeholders})
       ORDER BY created_at DESC`
    )
    .all(...childIds);
  const childNameById = Object.fromEntries(childrenRows.map((c) => [c.id, c.display_name]));
  const items = rows.map((r) => ({
    purchaseId: r.id,
    childId: r.child_id,
    childName: childNameById[r.child_id],
    itemName: r.item_name_snapshot,
    cost: r.cost_at_purchase,
    createdAt: r.created_at,
  }));
  res.json({ items });
});



// ---------- монеты и магазин наград ----------
router.get('/api/me/coins', requireAuth, (req, res) => {
  const childId = req.session.user.role === 'child' ? req.session.user.id : req.query.childId ? Number(req.query.childId) : null;
  if (req.session.user.role !== 'child' && (!childId || !hasChildAccess(req.session.user, childId))) {
    return res.status(403).json({ error: 'no_access_to_child' });
  }
  res.json({ balance: getCoinBalance(childId), silverBalance: getSilverBalance(childId) });
});

router.get('/api/me/hunger', requireAuth, (req, res) => {
  const childId = req.session.user.role === 'child' ? req.session.user.id : req.query.childId ? Number(req.query.childId) : null;
  if (req.session.user.role !== 'child' && (!childId || !hasChildAccess(req.session.user, childId))) {
    return res.status(403).json({ error: 'no_access_to_child' });
  }
  res.json({ hunger: getCurrentHunger(childId), decayHours: getHungerDecayHours(childId) });
});

// родитель/админ настраивает, за сколько часов у конкретного ребёнка голод маскота
// падает со 100% до 0% без кормления (по умолчанию - 4 часа)
router.patch('/api/mascot/decay-settings', requireRole(['admin', 'parent']), (req, res) => {
  const { childId, decayHours } = req.body || {};
  if (!childId || !hasChildAccess(req.session.user, childId)) {
    return res.status(403).json({ error: 'no_access_to_child' });
  }
  const hours = Number(decayHours);
  if (!Number.isFinite(hours) || hours <= 0) {
    return res.status(400).json({ error: 'decay_hours_must_be_positive' });
  }
  setHungerDecayHours(childId, hours);
  res.json({ ok: true, decayHours: hours });
});

function visibleShopFilter(user) {
  if (user.role === 'admin') return { where: '1=1', params: [] };
  if (user.role === 'parent') {
    return { where: '(si.created_by IS NULL OR si.created_by = ? OR u.role = \'admin\')', params: [user.id] };
  }
  return {
    where: `(si.created_by IS NULL OR u.role = 'admin' OR si.created_by IN (SELECT parent_id FROM parent_child WHERE child_id = ?))`,
    params: [user.id],
  };
}

router.get('/api/shop/items', requireAuth, (req, res) => {
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
      currency: i.currency, restoreAmount: i.restore_amount,
      createdBy: i.creator_name, canManage: req.session.user.role === 'admin' || i.created_by === req.session.user.id,
    })),
  });
});

router.post('/api/shop/items', requireRole(['admin', 'parent']), (req, res) => {
  const { name, description, cost, icon, currency, restoreAmount } = req.body || {};
  if (!name || !Number.isFinite(Number(cost)) || Number(cost) <= 0) {
    return res.status(400).json({ error: 'name_and_positive_cost_required' });
  }
  const cur = currency === 'silver' ? 'silver' : 'gold';
  const info = db
    .prepare('INSERT INTO shop_items (name, description, cost, icon, currency, restore_amount, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(name, description || null, Math.round(Number(cost)), icon || (cur === 'silver' ? '🍬' : '🎁'), cur,
      cur === 'silver' ? Math.round(Number(restoreAmount) || 10) : null, req.session.user.id);
  res.json({ ok: true, itemId: info.lastInsertRowid });
});

router.patch('/api/shop/items/:id', requireRole(['admin', 'parent']), (req, res) => {
  const item = db.prepare('SELECT * FROM shop_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  if (req.session.user.role !== 'admin' && item.created_by !== req.session.user.id) {
    return res.status(403).json({ error: 'not_owner' });
  }
  const { name, description, cost, icon, active, currency, restoreAmount } = req.body || {};
  if (currency !== undefined && !['gold', 'silver'].includes(currency)) {
    return res.status(400).json({ error: 'invalid_currency' });
  }
  const nextCurrency = currency || item.currency;
  if (nextCurrency === 'silver') {
    const nextRestore = restoreAmount !== undefined ? Number(restoreAmount) : item.restore_amount;
    if (!Number.isFinite(nextRestore) || nextRestore <= 0) {
      return res.status(400).json({ error: 'restore_amount_required_for_silver' });
    }
  }
  db.prepare('UPDATE shop_items SET name=?, description=?, cost=?, icon=?, active=?, currency=?, restore_amount=? WHERE id=?').run(
    name ?? item.name,
    description !== undefined ? description : item.description,
    cost !== undefined ? Math.round(Number(cost)) : item.cost,
    icon || item.icon,
    active !== undefined ? (active ? 1 : 0) : item.active,
    nextCurrency,
    nextCurrency === 'silver' ? (restoreAmount !== undefined ? Math.round(Number(restoreAmount)) : item.restore_amount) : item.restore_amount,
    item.id
  );
  res.json({ ok: true });
});

router.delete('/api/shop/items/:id', requireRole(['admin', 'parent']), (req, res) => {
  const item = db.prepare('SELECT * FROM shop_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  if (req.session.user.role !== 'admin' && item.created_by !== req.session.user.id) {
    return res.status(403).json({ error: 'not_owner' });
  }
  db.prepare('DELETE FROM shop_items WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/api/shop/purchase', requireRole('child'), (req, res) => {
  const { itemId } = req.body || {};
  const item = db.prepare('SELECT * FROM shop_items WHERE id=? AND active=1').get(itemId);
  if (!item) return res.status(404).json({ error: 'item_not_found' });

  if (item.currency === 'silver') {
    // лакомство для маскота - применяется сразу, без участия родителя
    try {
      const result = db.transaction(() => {
        const balance = getSilverBalance(req.session.user.id);
        if (balance < item.cost) throw new Error('insufficient_funds');
        db.prepare(
          "INSERT INTO silver_transactions (child_id, amount, reason, related_type, related_id) VALUES (?,?,?,?,?)"
        ).run(req.session.user.id, -item.cost, 'feed_mascot', 'shop_item', item.id);
        const newHunger = feedMascot(req.session.user.id, item.restore_amount || 10);
        return newHunger;
      })();
      res.json({ ok: true, fed: true, hunger: result, silverBalance: getSilverBalance(req.session.user.id) });
    } catch (e) {
      if (e.message === 'insufficient_funds') return res.status(400).json({ error: 'insufficient_funds' });
      res.status(500).json({ error: 'purchase_failed' });
    }
    return;
  }

  try {
    const purchaseId = db.transaction(() => {
      const balance = getCoinBalance(req.session.user.id);
      if (balance < item.cost) throw new Error('insufficient_funds');
      const info = db
        .prepare('INSERT INTO shop_purchases (item_id, child_id, item_name_snapshot, cost_at_purchase, currency, status) VALUES (?,?,?,?,?,?)')
        .run(item.id, req.session.user.id, item.name, item.cost, 'gold', 'pending');
      db.prepare(
        "INSERT INTO coin_transactions (child_id, amount, reason, related_type, related_id) VALUES (?,?,?,?,?)"
      ).run(req.session.user.id, -item.cost, 'purchase', 'shop_purchase', info.lastInsertRowid);
      return info.lastInsertRowid;
    })();
    res.json({ ok: true, fed: false, purchaseId, balance: getCoinBalance(req.session.user.id) });
  } catch (e) {
    if (e.message === 'insufficient_funds') return res.status(400).json({ error: 'insufficient_funds' });
    res.status(500).json({ error: 'purchase_failed' });
  }
});

router.get('/api/shop/purchases', requireAuth, (req, res) => {
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

router.post('/api/shop/purchases/:id/fulfill', requireRole(['admin', 'parent']), (req, res) => {
  const purchase = db.prepare('SELECT * FROM shop_purchases WHERE id=?').get(req.params.id);
  if (!purchase) return res.status(404).json({ error: 'not_found' });
  if (!hasChildAccess(req.session.user, purchase.child_id)) return res.status(403).json({ error: 'no_access_to_child' });
  db.prepare("UPDATE shop_purchases SET status='fulfilled', fulfilled_at=datetime('now') WHERE id=?").run(purchase.id);
  res.json({ ok: true });
});

router.post('/api/admin/mascot', requireRole('admin'), upload.single('mascot'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const relPath = `/uploads/${req.file.filename}`;
  const old = db.prepare("SELECT value FROM app_settings WHERE key='mascot_path'").get();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('mascot_path', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(relPath);
  if (old?.value) deleteUploadedFile(old.value);
  res.json({ ok: true, mascotUrl: relPath });
});


module.exports = router;
