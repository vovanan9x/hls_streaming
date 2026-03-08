const { getDb } = require('../database');

/**
 * Middleware: Require login
 */
function requireAuth(req, res, next) {
    if (req.session && req.session.user) {
        // Attach user to res.locals for templates
        res.locals.currentUser = req.session.user;
        return next();
    }
    res.redirect('/auth/login');
}

/**
 * Middleware: Require administrator role
 */
function requireAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'administrator') {
        return next();
    }
    return res.status(403).render('admin/forbidden', {
        title: 'Không có quyền truy cập',
        currentUser: req.session ? req.session.user : null
    });
}

/**
 * Middleware: Require at least uploader role (both uploader and administrator)
 */
function requireUploader(req, res, next) {
    if (req.session && req.session.user &&
        (req.session.user.role === 'uploader' || req.session.user.role === 'administrator')) {
        return next();
    }
    return res.status(403).render('admin/forbidden', {
        title: 'Không có quyền truy cập',
        currentUser: req.session ? req.session.user : null
    });
}

module.exports = { requireAuth, requireAdmin, requireUploader };
