const express = require('express');
const router = express.Router();

// Import Controller
const { 
  addAnnouncement, 
  getAnnouncements, 
  deleteAnnouncement 
} = require('../controllers/announcementsController');

// Import Middleware
const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');

// All routes require authentication
router.use(authenticateToken);

// GET /api/announcements
router.get('/', getAnnouncements);

// POST /api/announcements
router.post('/', checkRole(['admin', 'teacher']), addAnnouncement);

// DELETE /api/announcements/:id
router.delete('/:id', checkRole(['admin', 'teacher']), deleteAnnouncement);

module.exports = router;
