const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { pool } = require('../db');
const { signToken } = require('../utils/jwt');

const router = express.Router();

const HANDLE_REGEX = /^[a-z0-9_]{3,20}$/;

router.post(
  '/register',
  [
    body('handle')
      .trim()
      .toLowerCase()
      .matches(HANDLE_REGEX)
      .withMessage('handle 3-20 karakter, küçük harf/rakam/alt çizgi olmalı'),
    body('displayName').trim().isLength({ min: 1, max: 60 }),
    body('password').isLength({ min: 8, max: 128 }).withMessage('Şifre en az 8 karakter olmalı'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { handle, displayName, password } = req.body;

    try {
      const existing = await pool.query('SELECT id FROM users WHERE handle = $1', [handle]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Bu kullanıcı adı zaten alınmış.' });
      }

      // Cost factor 12: a deliberate, industry-standard slowdown against
      // brute-force/offline password cracking.
      const passwordHash = await bcrypt.hash(password, 12);

      const result = await pool.query(
        `INSERT INTO users (handle, display_name, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, handle, display_name, avatar_url`,
        [handle, displayName, passwordHash],
      );

      const user = result.rows[0];
      const token = signToken({ sub: user.id, handle: user.handle });

      return res.status(201).json({ token, user: toPublicUser(user) });
    } catch (err) {
      console.error('register error', err);
      return res.status(500).json({ error: 'Kayıt sırasında bir hata oluştu.' });
    }
  },
);

router.post(
  '/login',
  [
    body('handle').trim().toLowerCase().notEmpty(),
    body('password').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'handle ve password zorunludur.' });
    }

    const { handle, password } = req.body;

    try {
      const result = await pool.query(
        'SELECT id, handle, display_name, avatar_url, password_hash FROM users WHERE handle = $1',
        [handle],
      );

      // Same generic error whether the handle doesn't exist or the password
      // is wrong — do not leak which case it was.
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
      }

      const user = result.rows[0];
      const matches = await bcrypt.compare(password, user.password_hash);
      if (!matches) {
        return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
      }

      const token = signToken({ sub: user.id, handle: user.handle });
      return res.json({ token, user: toPublicUser(user) });
    } catch (err) {
      console.error('login error', err);
      return res.status(500).json({ error: 'Giriş sırasında bir hata oluştu.' });
    }
  },
);

function toPublicUser(row) {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  };
}

module.exports = router;
