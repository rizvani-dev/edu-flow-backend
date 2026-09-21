const express = require('express');
const router = express.Router();
const multer = require('multer');
const { uploadDoc } = require('../middleware/storageUpload');
const { 
  getStudentFees,
  getCurrentFee,
  getEligibleMonths,
  getClassFees, 
  createTeacherFeeProposal,
  updateFeeStatus, 
  editFee,
  uploadFees,
  deleteFee,
  getFeeStats, 
  adminGenerateFees,
  getFeeStructure,
  saveFeeStructure,
  createFeePaymentRequest,
  listFeePaymentRequests,
  reviewFeePaymentRequest,
  sendMonthlyFeeReminders,
  downloadFeeReceipt
} = require('../controllers/feeController');

const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');

// Attendance/Fee Excel uploads are still local as they are processed then deleted immediately
const excelUpload = multer({ dest: 'uploads/temp/' });

router.use(authenticateToken);

// Student routes
router.get('/my-fees', checkRole(['student']), getStudentFees);
router.get('/current', checkRole(['student']), getCurrentFee);
router.get('/eligible-months', checkRole(['student']), getEligibleMonths);
router.post('/payment-requests', checkRole(['student']), uploadDoc.single('screenshot'), createFeePaymentRequest);
router.get('/payment-requests/:requestId/receipt', checkRole(['student', 'admin']), downloadFeeReceipt);

// Teacher routes
router.get('/class-fees', checkRole(['teacher']), getClassFees);
router.post('/proposals', checkRole(['teacher']), createTeacherFeeProposal);
router.get('/stats', checkRole(['teacher']), getFeeStats);
router.post('/reminders', checkRole(['teacher', 'admin']), sendMonthlyFeeReminders);

// Admin routes
router.post('/generate', checkRole(['admin']), adminGenerateFees);
router.get('/structure', checkRole(['admin']), getFeeStructure);
router.post('/structure', checkRole(['admin']), saveFeeStructure);
router.put('/update/:feeId', checkRole(['admin']), updateFeeStatus);
router.put('/edit/:feeId', checkRole(['admin']), editFee);
router.post('/upload', checkRole(['admin']), excelUpload.single('file'), uploadFees);
router.delete('/:feeId', checkRole(['admin']), deleteFee);
router.get('/payment-requests', checkRole(['admin', 'teacher']), listFeePaymentRequests);
router.put('/payment-requests/:requestId', checkRole(['admin', 'teacher']), reviewFeePaymentRequest);

module.exports = router;
