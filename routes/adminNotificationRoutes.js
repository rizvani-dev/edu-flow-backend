const express = require('express');
const router = express.Router();

const { getNotifications, markAsRead, markTypeRead } = require('../controllers/notificationController');
const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');

router.use(authenticateToken);
router.use(checkRole(['admin']));

router.get('/', getNotifications);
router.put('/:id/read', markAsRead);
router.put('/read-type/:type/:relatedUserId', markTypeRead);

module.exports = router;
