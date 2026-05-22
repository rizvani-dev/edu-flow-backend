const pool = require('../config/db');
const { getConversationMessages, sendConversationMessage } = require('./conversationController');

// Student sends message (text + file) to their teacher
const sendStudentMessage = async (req, res) => {
  const studentId = req.user.id;
  const teacherRes = await pool.query(`SELECT teacher_id FROM users WHERE id = $1`, [studentId]);
  const teacherId = teacherRes.rows[0]?.teacher_id;

  if (!teacherId) {
    return res.status(400).json({
      success: false,
      message: 'You are not assigned to any teacher.',
    });
  }

  req.params.userId = teacherId;
  await sendConversationMessage(req, res);
};

// Get student's chat history with their teacher
const getStudentMessages = async (req, res) => {
  const studentId = req.user.id;
  const teacherRes = await pool.query(`SELECT teacher_id FROM users WHERE id = $1`, [studentId]);
  const teacherId = teacherRes.rows[0]?.teacher_id;

  if (!teacherId) {
    return res.status(400).json({ success: false, message: "You are not assigned to any teacher." });
  }

  req.params.userId = teacherId;
  await getConversationMessages(req, res);
};

module.exports = { 
  sendStudentMessage,
  getStudentMessages
};
