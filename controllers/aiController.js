const pool = require('../config/db');
const aiService = require('../services/ai/aiService');
const { withAiCache } = require('../services/ai/aiCacheLayer');
const { closeSse, sendSse, writeSseHeaders } = require('../services/ai/aiStreamingHandler');
const { normalizeStoredMediaPath } = require('../utils/media');

const parseStructuredInsight = (text, fallback = {}) => aiService.extractJsonBlock(text) || fallback;

const getScopedStudentContext = async ({ studentId, user }) => {
  const values = [studentId, user.school_id];
  const scope =
    user.role === 'student'
      ? 'AND u.id = $3'
      : user.role === 'teacher'
        ? 'AND u.teacher_id = $3'
        : '';

  if (scope) values.push(user.id);

  const studentResult = await pool.query(
    `SELECT u.id, u.name, u.email, u.bio, u.profile_image, c.name AS class_name, t.name AS teacher_name
     FROM users u
     LEFT JOIN classes c ON c.id = u.class_id
     LEFT JOIN users t ON t.id = u.teacher_id
     WHERE u.id = $1 AND u.school_id = $2 AND u.role = 'student' ${scope}`,
    values
  );

  if (!studentResult.rows.length) return null;

  const [attendance, results, fees] = await Promise.all([
    pool.query(
      `SELECT date, status, remarks
       FROM attendance
       WHERE student_id = $1 AND school_id = $2
       ORDER BY date DESC
       LIMIT 90`,
      [studentId, user.school_id]
    ),
    pool.query(
      `SELECT subject, marks, created_at
       FROM results
       WHERE student_id = $1 AND school_id = $2
       ORDER BY created_at DESC
       LIMIT 100`,
      [studentId, user.school_id]
    ),
    pool.query(
      `SELECT month, year, amount, status, due_date, remarks
       FROM fees
       WHERE student_id = $1 AND school_id = $2
       ORDER BY year DESC, month DESC
       LIMIT 24`,
      [studentId, user.school_id]
    ),
  ]);

  return {
    student: studentResult.rows[0],
    attendance: attendance.rows,
    results: results.rows,
    fees: fees.rows,
  };
};

const chat = async (req, res) => {
  const { message, context = {}, stream = false } = req.body;
  if (!message?.trim()) {
    return res.status(400).json({ success: false, message: 'Message is required' });
  }

  const payload = {
    role: req.user.role,
    school_id: req.user.school_id,
    message,
    context,
  };
  const messages = aiService.templates.chat({ message, context: payload });

  try {
    if (stream) {
      writeSseHeaders(res);
      await aiService.stream({
        messages,
        onToken: (token) => sendSse(res, 'token', { token }),
      });
      return closeSse(res);
    }

    const result = await withAiCache('chat', payload, () => aiService.complete({ messages }));
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('AI chat error:', error);
    return res.status(500).json({ success: false, message: error.message || 'AI chat failed' });
  }
};

const studentPerformance = async (req, res) => {
  const studentId = Number(req.params.studentId || req.body.studentId || req.user.id);
  if (!studentId) {
    return res.status(400).json({ success: false, message: 'Student id is required' });
  }

  try {
    const context = await getScopedStudentContext({ studentId, user: req.user });
    if (!context) {
      return res.status(404).json({ success: false, message: 'Student not found or access denied' });
    }

    const messages = aiService.templates.studentPerformance({
      ...context,
      remarks: req.body.remarks || [],
    });
    const result = await withAiCache(`student-performance:${studentId}`, context, () => aiService.complete({ messages }));
    const structuredInsight = parseStructuredInsight(result.text, {
      summary: result.text,
      strengths: [],
      weaknesses: [],
      riskAlerts: [],
      achievementInsights: [],
      monthlyComparison: {},
      predictions: {},
      recommendations: [],
      parentNote: '',
      progressPercent: 0,
      confidencePercent: 0,
    });

    return res.json({
      success: true,
      context,
      insight: result.text,
      structuredInsight,
      model: result.model,
    });
  } catch (error) {
    console.error('AI performance error:', error);
    return res.status(500).json({ success: false, message: error.message || 'AI analysis failed' });
  }
};

const studentPrediction = async (req, res) => {
  const studentId = Number(req.params.studentId || req.body.studentId || req.user.id);
  if (!studentId) {
    return res.status(400).json({ success: false, message: 'Student id is required' });
  }

  try {
    const context = await getScopedStudentContext({ studentId, user: req.user });
    if (!context) {
      return res.status(404).json({ success: false, message: 'Student not found or access denied' });
    }

    const messages = aiService.templates.studentPrediction({
      ...context,
      remarks: req.body.remarks || [],
    });
    const result = await withAiCache(`student-prediction:${studentId}`, context, () =>
      aiService.complete({ messages, maxTokens: 1600 })
    );

    const prediction = parseStructuredInsight(result.text, {
      confidencePercent: 0,
      overallOutlook: result.text,
      cards: [],
      riskLevel: 'moderate',
      topOpportunities: [],
    });

    return res.json({
      success: true,
      context,
      insight: result.text,
      prediction,
      model: result.model,
    });
  } catch (error) {
    console.error('AI prediction error:', error);
    return res.status(500).json({ success: false, message: error.message || 'AI prediction failed' });
  }
};

const quizGenerator = async (req, res) => {
  try {
    const body = req.body || {};
    const messages = aiService.templates.quizGenerator(body);
    const result = await withAiCache('quiz', body, () => aiService.complete({ messages, maxTokens: 2500 }));
    const parsed = aiService.extractJsonBlock(result.text);
    
    return res.json({ 
      success: true, 
      quiz: parsed || result.text, 
      isParsed: !!parsed,
      model: result.model 
    });
  } catch (error) {
    console.error('AI quiz error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Quiz generation failed' });
  }
};

const topAchievers = async (req, res) => {
  const schoolId = req.user.school_id;
  const teacherClause = req.user.role === 'teacher' ? 'AND u.teacher_id = $2' : '';
  const params = req.user.role === 'teacher' ? [schoolId, req.user.id] : [schoolId];

  try {
    const { rows } = await pool.query(
      `SELECT
         u.id,
         u.name,
         u.profile_image,
         c.name AS class_name,
         ROUND(AVG(r.marks), 2)::float AS average_marks,
         COUNT(r.id)::int AS result_count,
         ROUND(
           (COUNT(a.id) FILTER (WHERE a.status IN ('present', 'late'))::numeric
           / NULLIF(COUNT(a.id) FILTER (WHERE a.status <> 'holiday'), 0)) * 100,
           2
         )::float AS attendance_percentage
       FROM users u
       LEFT JOIN classes c ON c.id = u.class_id
       LEFT JOIN results r ON r.student_id = u.id AND r.school_id = u.school_id
       LEFT JOIN attendance a ON a.student_id = u.id AND a.school_id = u.school_id
       WHERE u.school_id = $1 AND u.role = 'student' ${teacherClause}
       GROUP BY u.id, c.name
       ORDER BY average_marks DESC NULLS LAST, attendance_percentage DESC NULLS LAST
       LIMIT 12`,
      params
    );

    const messages = aiService.templates.achievers({ students: rows });
    const result = await withAiCache(`achievers:${schoolId}:${req.user.role}:${req.user.id}`, rows, () =>
      aiService.complete({ messages, maxTokens: 1300 })
    );
    const parsed = parseStructuredInsight(result.text, { cards: [], summary: result.text });

    // Enrich AI cards with actual student data from database to ensure Name/ID/Image are shown
    const enrichedCards = (parsed.cards || []).map(card => {
      // Try to find student by any ID variation returned by AI
      const rawId = card.studentId || card.id || card.student_id;
      let student = rows.find(s => Number(s.id) === Number(rawId));

      // Fallback: If ID is 0 or not found, try matching by student name
      if (!student && (card.title || card.name)) {
        const targetName = String(card.title || card.name).toLowerCase();
        student = rows.find(s => s.name?.toLowerCase().includes(targetName));
      }

      if (!student) return card;
      return {
        ...card,
        studentId: student.id || rawId,
        title: student.name || card.title || card.name, 
        profileImage: student.profile_image ? normalizeStoredMediaPath(student.profile_image) : card.profileImage,
        className: card.className || student.class_name,
        attendancePercent: card.attendancePercent ?? student.attendance_percentage,
        resultPercent: card.resultPercent ?? student.average_marks,
        feePercent: card.feePercent ?? 100, // Default if not analyzed
      };
    });

    return res.json({
      success: true,
      students: rows,
      insight: result.text,
      cards: enrichedCards,
      summary: parsed.summary || '',
      model: result.model,
    });
  } catch (error) {
    console.error('AI achievers error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Top achiever analysis failed' });
  }
};

const freeModels = async (req, res) => {
  try {
    const models = await withAiCache('free-models', { source: 'openrouter' }, () => aiService.listFreeModels(), 60 * 60 * 12);
    return res.json({
      success: true,
      defaultModel: aiService.DEFAULT_FREE_MODEL,
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        context_length: model.context_length,
      })).slice(0, 50),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to load free models' });
  }
};

module.exports = {
  chat,
  freeModels,
  quizGenerator,
  studentPrediction,
  studentPerformance,
  topAchievers,
};
