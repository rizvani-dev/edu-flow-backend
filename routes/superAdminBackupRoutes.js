const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const superAdminBackupController = require('../controllers/superAdminController');
const authenticateToken = require('../middleware/authMiddleware'); // Assuming this exists
const checkRole = require('../middleware/roleMiddleware'); // Assuming this exists

const backupDirectory = path.join(__dirname, '..', 'uploads', 'backups');
fs.mkdirSync(backupDirectory, { recursive: true });

const upload = multer({
  dest: backupDirectory,
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    if (extension === '.json' && ['application/json', 'text/json', 'application/octet-stream'].includes(mime)) {
      return callback(null, true);
    }
    return callback(new Error('Backup must be a JSON file'));
  },
});

const withUploadCleanup = (handler) => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (error) {
    next(error);
  } finally {
    if (req.file?.path) {
      await fs.promises.unlink(req.file.path).catch(() => {});
    }
  }
};

// All routes here should be protected by super_admin role
router.use(authenticateToken, checkRole(['super_admin']));

// Export routes
router.get('/backup/export/full', superAdminBackupController.exportFullBackup);
router.get('/backup/export/:schoolId', superAdminBackupController.exportSchoolBackup);

// Import routes
// For import, the masterKey is sent in the request body along with the file
router.post('/backup/import/full', upload.single('backup'), withUploadCleanup(superAdminBackupController.importFullBackup));
router.post('/backup/import/:schoolId', upload.single('backup'), withUploadCleanup(superAdminBackupController.importSchoolBackup));

module.exports = router;
