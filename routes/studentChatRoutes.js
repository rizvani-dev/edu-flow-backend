const express = require('express');
const router = express.Router();

const { sendStudentMessage, getStudentMessages } = require('../controllers/studentChatController');
const { getConversationMessages, sendConversationMessage } = require('../controllers/conversationController');
const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');
const { deleteMessagesBulk } = require('../controllers/chatController');
const { uploadChat } = require('../middleware/storageUpload');

router.use(authenticateToken);
router.use(checkRole(['student']));

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

router.post('/', uploadChat.single('file'), sendStudentMessage);
router.post('/conversation/:userId', uploadChat.single('file'), sendConversationMessage);
router.get('/', getStudentMessages);
router.get('/conversation/:userId', getConversationMessages);
router.post('/bulk-delete', deleteMessagesBulk);

module.exports = router;
