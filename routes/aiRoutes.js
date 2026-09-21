const express = require('express');
const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');
const { aiRateLimiter } = require('../services/ai/aiRateLimiter');
const {
  chat,
  freeModels,
  quizGenerator,
  studentPrediction,
  studentPerformance,
  topAchievers,
} = require('../controllers/aiController');

const router = express.Router();

router.use(authenticateToken);
router.use(checkRole(['admin', 'teacher', 'student', 'super_admin']));
router.use(aiRateLimiter);

router.get('/free-models', freeModels);
router.post('/chat', chat);
router.post('/quiz', checkRole(['admin', 'teacher']), quizGenerator);
router.post('/student-prediction', studentPrediction);
router.post('/student-prediction/:studentId', studentPrediction);
router.post('/student-performance', studentPerformance);
router.post('/student-performance/:studentId', studentPerformance);
router.get('/top-achievers', checkRole(['admin', 'teacher']), topAchievers);

module.exports = router;
