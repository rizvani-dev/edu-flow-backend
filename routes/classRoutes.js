const express = require('express');
const router = express.Router();
const { getClasses, createClass } = require('../controllers/classController');
const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');

router.get('/', getClasses);
router.post('/', authenticateToken, checkRole(['admin']), createClass);

module.exports = router;
