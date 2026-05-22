const express = require('express');
const router = express.Router();

const {
  createUser,
  getAllUsers,
  updateUser,
  deleteUser,
  getDashboardAnalytics,
  getUserDetails,
  getTeacherAttendance,
  getTeacherSalaries,
  addTeacherSalary,
  deleteTeacherSalary,
  updateSalaryStatus,
  createSubscriptionRequest,
} = require('../controllers/adminController');

const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');
const { uploadDoc, uploadProfile } = require('../middleware/storageUpload');

router.use(authenticateToken);
router.use(checkRole(['admin']));

router.get('/dashboard', getDashboardAnalytics);
router.post('/users', uploadProfile.single('profile_image'), createUser);
router.get('/users', getAllUsers);
router.get('/users/:userId', getUserDetails);
router.put('/users/:id', uploadProfile.single('profile_image'), updateUser);
router.delete('/users/:id', deleteUser);

router.get('/teacher-attendance/:teacherId', getTeacherAttendance);
router.get('/teacher-salaries/:teacherId', getTeacherSalaries);
router.post('/teacher-salaries/:teacherId', uploadDoc.single('file'), addTeacherSalary);
router.put('/teacher-salaries/:salaryId/status', updateSalaryStatus);
router.delete('/teacher-salaries/:salaryId', deleteTeacherSalary);
router.post('/subscription-requests', uploadDoc.single('file'), createSubscriptionRequest);

module.exports = router;
