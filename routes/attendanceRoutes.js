const express = require('express');
const router = express.Router();
const multer = require('multer');

const {
  uploadAttendance,
  createManualAttendance,
  getAllAttendance,
  editAttendance,
  getAttendanceSummary,
  exportAttendance,
  deleteAttendance
} = require('../controllers/attendanceController');

const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');

const upload = multer({ dest: 'uploads/attendance/' });

router.post('/upload', authenticateToken, checkRole(['admin','teacher']), upload.single('file'), uploadAttendance);
router.post('/manual', authenticateToken, checkRole(['teacher']), createManualAttendance);

router.get('/', authenticateToken, getAllAttendance);

router.get('/summary', authenticateToken, checkRole(['student']), getAttendanceSummary);

router.get('/export', authenticateToken, exportAttendance);

router.put('/:id', authenticateToken, checkRole(['admin','teacher']), editAttendance);


router.delete('/:id', authenticateToken, checkRole(['admin','teacher']), deleteAttendance);

module.exports = router;
