const express = require('express');
const router = express.Router();

const authenticateToken = require('../middleware/authMiddleware');
const checkRole = require('../middleware/roleMiddleware');
const {
  sendAdminMessage,
  getAdminMessages,
  broadcastToClass,
  deleteMessagesBulk,
} = require('../controllers/chatController');
const { uploadChat } = require('../middleware/storageUpload');

router.use(authenticateToken);
router.use(checkRole(['admin']));

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
router.post('/broadcast', broadcastToClass);
router.post('/:userId', uploadChat.single('file'), sendAdminMessage);
router.get('/:userId', getAdminMessages);


module.exports = router;
