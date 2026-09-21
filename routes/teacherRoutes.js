const express = require('express');
const router = express.Router();

const { uploadProfile } = require('../middleware/storageUpload');

// Import Controller
const { 
  getMyStudents, 
  addStudent, 
  updateStudent, 
  deleteStudent, 
  updateProfile,
  getMySalaries,
  getMySalaryById,
  confirmSalaryReceived,
  rejectSalaryReceived,
  downloadSalarySlip
} = require('../controllers/teacherController');

// Import Middleware
const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');

// Protect all teacher routes
router.use(authenticateToken);
router.use(checkRole(['teacher']));

// Teacher Routes
router.get('/students', getMyStudents);                    // Get students in my class
router.post('/students', uploadProfile.single('profile_image'), addStudent);                      // Add student to my class
router.put('/students/:id', uploadProfile.single('profile_image'), updateStudent);                // Update student
router.delete('/students/:id', deleteStudent);             // Delete student

// Profile update with image upload
router.put('/profile', uploadProfile.single('profile_image'), updateProfile);

// Salary (teacher confirms received & downloads slip)
router.get('/salaries', getMySalaries);
router.get('/salaries/:salaryId', getMySalaryById);
router.get('/salaries/:salaryId/slip', downloadSalarySlip);
router.put('/salaries/:salaryId/confirm', confirmSalaryReceived);
router.put('/salaries/:salaryId/reject', rejectSalaryReceived);

module.exports = router;
