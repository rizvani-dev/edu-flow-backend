const express = require('express');
const router = express.Router();

const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');
const { uploadChat } = require('../middleware/storageUpload');
const {
  sendTeacherMessage,
  getTeacherMessages,
  deleteMessagesBulk,
} = require('../controllers/chatController');
const {
  getConversationMessages,
  sendConversationMessage,
} = require('../controllers/conversationController');

router.use(authenticateToken);
router.use(checkRole(['teacher']));

router.post('/chat-upload', uploadChat.single('file'), (req, res) => {
  if (!req.file?.path) {
    return res.status(400).json({
      success: false,
      message: 'File is required',
    });
  }

  return res.json({
    success: true,
    url: req.file.path,
    file: req.file,
  });
});

router.post('/bulk-delete', deleteMessagesBulk);
router.post('/conversation/:userId', uploadChat.single('file'), sendConversationMessage);
router.get('/conversation/:userId', getConversationMessages);
router.post('/:studentId', uploadChat.single('file'), sendTeacherMessage);
router.get('/:studentId', getTeacherMessages);

module.exports = router;
