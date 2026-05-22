const express = require('express');
const router = express.Router();

// Import Controllers
const { addOrUpdateResult, getResults } = require('../controllers/resultsController');

// Import Middleware
const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');

// Protect all results routes
router.use(authenticateToken);

// Teacher can add/update results
router.post('/', addOrUpdateResult);

// Both Teacher and Student can view results (restrictions inside controller)
router.get('/', getResults);

module.exports = router;