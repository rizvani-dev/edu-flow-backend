const pool = require('../config/db');
const aiService = require('../services/ai/aiService');
const { del } = require('../services/cacheService');

// Teacher: Create AI Generated Exam
const createExam = async (req, res) => {
  const { title, subject, difficulty, topic, chapter, total_questions, marks, duration_minutes, class_id, questions: customQuestions, creationMode, expiry_days } = req.body;
  const schoolId = req.user.school_id;
  const teacherId = req.user.id;

  if (!title || !subject || !class_id) {
    return res.status(400).json({ success: false, message: "Required fields missing" });
  }

  try {
    let questions = customQuestions;

    // Generate using AI if in AI mode or no custom questions provided
    if (creationMode === 'ai' || !questions || !Array.isArray(questions) || questions.length === 0) {
      const messages = aiService.templates.quizGenerator({
        subject,
        difficulty,
        topic,
        chapter,
        count: total_questions || 10
      });

      const aiResponse = await aiService.complete({ messages, maxTokens: 2500 });
      questions = aiService.extractJsonBlock(aiResponse.text);
    }

    if (!questions || !Array.isArray(questions)) {
      return res.status(500).json({ success: false, message: "AI failed to generate valid quiz structure. Try again." });
    }

    // Calculate Expiry: Default to 7 days if not specified, or use duration as a window
    const expiresAt = new Date(Date.now() + (expiry_days || 7) * 24 * 60 * 60 * 1000);

    // 2. Save to database
    const { rows } = await pool.query(
      `INSERT INTO exams (school_id, teacher_id, class_id, title, subject, difficulty, total_questions, marks, duration_minutes, questions, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [schoolId, teacherId, class_id, title, subject, difficulty, questions.length, marks, duration_minutes, JSON.stringify(questions), expiresAt]
    );

    await del(`student:dashboard:*`);

    res.status(201).json({ success: true, exam: rows[0] });
  } catch (error) {
    console.error("Create Exam Error:", error);
    res.status(500).json({ success: false, message: "Server error creating exam" });
  }
};

// Teacher: Get my created exams
const getTeacherExams = async (req, res) => {
  const teacherId = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM exams WHERE teacher_id = $1 ORDER BY created_at DESC`,
      [teacherId]
    );
    res.json({ success: true, exams: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Teacher: Get exam details
const getExamDetailsForTeacher = async (req, res) => {
  const { examId } = req.params;
  try {
    const { rows } = await pool.query(`SELECT * FROM exams WHERE id = $1`, [examId]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Exam not found" });
    res.json({ success: true, exam: rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Teacher: Delete Exam
const deleteExam = async (req, res) => {
  const { examId } = req.params;
  const teacherId = req.user.id;

  try {
    const { rowCount } = await pool.query(
      "DELETE FROM exams WHERE id = $1 AND teacher_id = $2",
      [examId, teacherId]
    );

    if (rowCount === 0) return res.status(404).json({ success: false, message: "Exam not found or unauthorized" });

    await del(`student:dashboard:*`);
    res.json({ success: true, message: "Exam deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Teacher: Get results for an exam
const getExamResults = async (req, res) => {
  const { examId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT er.*, u.name as student_name
       , u.profile_image as student_image
       FROM exam_results er
       JOIN users u ON u.id = er.student_id
       WHERE er.exam_id = $1
       ORDER BY er.completed_at DESC`,
      [examId]
    );
    res.json({ success: true, results: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Student: Get exam details and questions (answers stripped for security)
const getExamForStudent = async (req, res) => {
  const { examId } = req.params;
  const studentId = req.user.id;

  try {
    const { rows } = await pool.query(
      `SELECT e.*, er.completed_at, er.score
       FROM exams e
       LEFT JOIN exam_results er ON er.exam_id = e.id AND er.student_id = $1
       WHERE e.id = $2`,
      [studentId, examId]
    );

    if (!rows.length) return res.status(404).json({ success: false, message: "Exam not found" });

    let exam = rows[0];
    // Ensure questions are parsed if returned as string
    if (typeof exam.questions === 'string') exam.questions = JSON.parse(exam.questions);

    // Security: Strip correct answers from questions if student hasn't completed it yet
    if (!exam.completed_at && Array.isArray(exam.questions)) {
      exam.questions = exam.questions.map(q => {
        const { answer, ...rest } = q;
        return rest;
      });
    }

    res.json({ success: true, exam });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Student: Submit exam attempt
const submitExam = async (req, res) => {
  const { examId } = req.params;
  const { answers } = req.body;
  const studentId = req.user.id;
  const schoolId = req.user.school_id;

  try {
    const examRes = await pool.query(`SELECT questions, total_questions FROM exams WHERE id = $1`, [examId]);
    if (!examRes.rows.length) return res.status(404).json({ success: false, message: "Exam not found" });

    let exam = examRes.rows[0];
    let questions = exam.questions;
    if (typeof questions === 'string') questions = JSON.parse(questions);

    if (!questions || !Array.isArray(questions)) {
      return res.status(500).json({ success: false, message: "Exam question data is corrupted." });
    }

    // Calculate score
    let correctCount = 0;
    questions.forEach((q, idx) => {
      if (answers[idx] !== undefined && Number(answers[idx]) === Number(q.answer)) {
        correctCount++;
      }
    });

    const score = Math.round((correctCount / exam.total_questions) * 100);

    // Save results
    const { rows } = await pool.query(
      `INSERT INTO exam_results (school_id, exam_id, student_id, score, answers)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (exam_id, student_id) DO UPDATE SET score = EXCLUDED.score, answers = EXCLUDED.answers
       RETURNING *`,
      [schoolId, examId, studentId, score, JSON.stringify(answers)]
    );

    // Clear student dashboard cache to show the new grade immediately
    await del(`student:dashboard:${studentId}`);

    res.json({ success: true, score });
  } catch (error) {
    console.error("Submit Exam Error:", error);
    res.status(500).json({ success: false, message: "Server error submitting exam" });
  }
};

module.exports = {
  createExam,
  getTeacherExams,
  getExamDetailsForTeacher,
  getExamResults,
  getExamForStudent,
  submitExam,
  deleteExam
};