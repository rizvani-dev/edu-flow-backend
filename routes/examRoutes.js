const express = require('express');
const router = express.Router();
const {
  createExam,
  getTeacherExams,
  getExamDetailsForTeacher,
  getExamResults,
  getExamForStudent,
  submitExam,
  deleteExam
} = require('../controllers/examController');
const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');

router.use(authenticateToken);

// Teacher routes
router.get('/my-exams', checkRole(['teacher']), getTeacherExams);
router.post('/create', checkRole(['teacher']), createExam);
router.get('/:examId/details', checkRole(['teacher']), getExamDetailsForTeacher);
router.get('/:examId/results', checkRole(['teacher']), getExamResults);
router.delete('/:examId', checkRole(['teacher']), deleteExam);

// Student routes
router.get('/:examId', checkRole(['student']), getExamForStudent);
router.post('/:examId/submit', checkRole(['student']), submitExam);

module.exports = router;