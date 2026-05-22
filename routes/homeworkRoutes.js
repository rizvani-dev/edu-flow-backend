const express = require('express');
const router = express.Router();
const {
  addHomework,
  getTeacherHomework,
  getStudentHomework,
  updateHomework,
  deleteHomework,
  reactToHomework,
} = require('../controllers/homeworkController');
const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');

// Protect all homework routes
// IMPORTANT: Ensure 'authenticateToken' is a function exported from '../middleware/authMiddleware'
router.use(authenticateToken);

// Teacher routes
router.post('/teacher', checkRole(['teacher']), addHomework);
router.get('/teacher', checkRole(['teacher']), getTeacherHomework);
router.put('/teacher/:homeworkId', checkRole(['teacher']), updateHomework);
router.delete('/teacher/:homeworkId', checkRole(['teacher']), deleteHomework);
router.post('/:homeworkId/react', checkRole(['teacher', 'student']), reactToHomework);

// Student routes
router.get('/student', checkRole(['student']), getStudentHomework);

module.exports = router;
