const express = require('express');
const router = express.Router();
const multer = require('multer');
const { uploadDoc } = require('../middleware/storageUpload');
const { 
  getStudentFees, 
  getClassFees, 
  updateFeeStatus, 
  editFee,
  uploadFees,
  deleteFee,
  getFeeStats, 
  adminGenerateFees,
  createFeePaymentRequest,
  listFeePaymentRequests,
  reviewFeePaymentRequest
} = require('../controllers/feeController');

const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');

// Attendance/Fee Excel uploads are still local as they are processed then deleted immediately
const excelUpload = multer({ dest: 'uploads/temp/' });

router.use(authenticateToken);

// Student routes
router.get('/my-fees', checkRole(['student']), getStudentFees);
router.post('/payment-requests', checkRole(['student']), uploadDoc.single('screenshot'), createFeePaymentRequest);

// Teacher routes
router.get('/class-fees', checkRole(['teacher']), getClassFees);
router.get('/stats', checkRole(['teacher']), getFeeStats);
router.put('/update/:feeId', checkRole(['teacher']), updateFeeStatus);
router.put('/edit/:feeId', checkRole(['teacher']), editFee);
router.post('/upload', checkRole(['teacher']), excelUpload.single('file'), uploadFees);
router.delete('/:feeId', checkRole(['teacher']), deleteFee);

// Admin routes
router.post('/generate', checkRole(['admin']), adminGenerateFees);
router.get('/payment-requests', checkRole(['admin']), listFeePaymentRequests);
router.put('/payment-requests/:requestId', checkRole(['admin']), reviewFeePaymentRequest);

module.exports = router;
