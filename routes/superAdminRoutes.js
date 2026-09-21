const express = require('express');
const router = express.Router();
const multer = require('multer');
const { uploadLogo } = require('../middleware/storageUpload');
const {
  createSchool,
  getAllSchools,
  getSubscriptionRequests,
  reviewSubscriptionRequest,
  updateSchoolSubscription,
  updateAllSchoolSubscriptions,
  updateSchool,
  deleteSchool,
  exportFullBackup,
  exportSchoolBackup,
  importFullBackup,
  importSchoolBackup
} = require('../controllers/superAdminController');
const authenticateToken = require('../middleware/authMiddleware');

// Backup multer config
const backupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isJsonMime = ['application/json', 'text/json'].includes(file.mimetype);
    const isJsonName = file.originalname.toLowerCase().endsWith('.json');

    if (isJsonMime || isJsonName) {
      cb(null, true);
      return;
    }

    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  }
});

const normalizeBackupFile = (req, res, next) => {
  backupUpload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'backup', maxCount: 1 }
  ])(req, res, (error) => {
    if (error) {
      next(error);
      return;
    }

    req.file = req.files?.file?.[0] || req.files?.backup?.[0] || null;
    next();
  });
};

// Middleware to check for Super Admin role
const isSuperAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'super_admin') {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Access denied: Super Admin only' });
  }
};

router.get('/schools', authenticateToken, isSuperAdmin, getAllSchools);
router.get('/subscription-requests', authenticateToken, isSuperAdmin, getSubscriptionRequests);
router.put('/subscription-requests/:requestId/review', authenticateToken, isSuperAdmin, reviewSubscriptionRequest);
router.put('/schools/:schoolId/subscription', authenticateToken, isSuperAdmin, updateSchoolSubscription);
router.put('/schools/subscription-all', authenticateToken, isSuperAdmin, updateAllSchoolSubscriptions);
router.post('/create-school', authenticateToken, isSuperAdmin, createSchool);

router.put('/schools/:id', authenticateToken, isSuperAdmin, uploadLogo.single('logo'), updateSchool);
router.delete('/schools/:id', authenticateToken, isSuperAdmin, deleteSchool);

// Backup and Restore Routes
router.get('/backup/export/full', authenticateToken, isSuperAdmin, exportFullBackup);
router.get('/backup/export/:schoolId', authenticateToken, isSuperAdmin, exportSchoolBackup);
router.post('/backup/import/full', authenticateToken, isSuperAdmin, normalizeBackupFile, importFullBackup);
router.post('/backup/import/:schoolId', authenticateToken, isSuperAdmin, normalizeBackupFile, importSchoolBackup);

module.exports = router;
