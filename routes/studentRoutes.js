const express = require('express');
const router = express.Router();

// Import Controllers
const { 
  getDashboard, 
  getMyAttendance, 
  getMyResults 
} = require('../controllers/studentController');

// Import Middleware
const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');

// Protect all student routes
router.use(authenticateToken);
router.use(checkRole(['student']));

// Student Routes
router.get('/dashboard', getDashboard);        // Full student dashboard
router.get('/attendance', getMyAttendance);    // Own attendance only
router.get('/results', getMyResults);          // Own results only

module.exports = router;