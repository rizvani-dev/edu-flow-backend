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

// All routes require authentication
router.use(authenticateToken);

// GET /api/announcements
router.get('/', getAnnouncements);

// POST /api/announcements
router.post('/', addAnnouncement);

// DELETE /api/announcements/:id
router.delete('/:id', deleteAnnouncement);   // ← This is correct

module.exports = router;