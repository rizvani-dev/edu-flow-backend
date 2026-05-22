const express = require('express');
const router = express.Router();
const multer = require('multer');
const superAdminBackupController = require('../controllers/superAdminController');
const authenticateToken = require('../middleware/authMiddleware'); // Assuming this exists
const checkRole = require('../middleware/roleMiddleware'); // Assuming this exists

// Multer configuration for file uploads
const upload = multer({ dest: 'uploads/backups/' }); // Store backups temporarily

// All routes here should be protected by super_admin role
router.use(authenticateToken, checkRole(['super_admin']));

// Export routes
router.get('/backup/export/full', superAdminBackupController.exportFullBackup);
router.get('/backup/export/:schoolId', superAdminBackupController.exportSchoolBackup);

// Import routes
// For import, the masterKey is sent in the request body along with the file
router.post('/backup/import/full', upload.single('backup'), superAdminBackupController.importFullBackup);
router.post('/backup/import/:schoolId', upload.single('backup'), superAdminBackupController.importSchoolBackup);

module.exports = router;
