const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../database');

// GET /auth/login
router.get('/login', (req, res) => {
    if (req.session && req.session.user) {
        return res.redirect('/admin/videos');
    }
    res.render('auth/login', { title: 'Đăng nhập', error: null });
});

// POST /auth/login
router.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.render('auth/login', { title: 'Đăng nhập', error: 'Vui lòng nhập đầy đủ thông tin' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username.trim());

    if (!user) {
        return res.render('auth/login', { title: 'Đăng nhập', error: 'Tài khoản không tồn tại hoặc đã bị khoá' });
    }

    if (!bcrypt.compareSync(password, user.password)) {
        return res.render('auth/login', { title: 'Đăng nhập', error: 'Sai mật khẩu' });
    }

    // Save session
    req.session.user = {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role
    };

    res.redirect('/admin/videos');
});

// GET /auth/logout
router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/auth/login');
    });
});

module.exports = router;
