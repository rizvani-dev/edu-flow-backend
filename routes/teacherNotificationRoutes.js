// backend/routes/teacherNotificationRoutes.js

const express = require('express');
const router = express.Router();

// Import controller functions (CommonJS style - NO .default)
const { getNotifications, markAsRead, markTypeRead } = require('../controllers/notificationController');

const authenticateToken = require('../middleware/authMiddleware');

// All routes are protected
router.use(authenticateToken);

// Get notifications for the logged-in teacher
router.get('/', getNotifications);

// Mark a notification as read
router.put('/:id/read', markAsRead);

// Mark specific type/user notifications as read
router.put('/read-type/:type/:relatedUserId', markTypeRead);

module.exports = router;