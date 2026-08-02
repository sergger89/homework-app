const path = require('path');
const multer = require('multer');
const { UPLOADS_DIR } = require('../db');

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

module.exports = upload;
