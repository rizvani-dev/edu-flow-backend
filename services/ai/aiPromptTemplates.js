const EDU_FLOW_SYSTEM_PROMPT = `
You are Edu Flow AI, an assistant for a school management SaaS.
Be practical, concise, school-safe, and supportive. Never invent grades, fees,
attendance, or identities that are not present in the provided data.
Return structured sections with clear recommendations for admins, teachers,
students, and parents. When answering chat-style requests, format the response
in clean Markdown with a short title, useful headings, concise paragraphs, and
bullet points when appropriate.
`;

const stringifyContext = (context = {}) => JSON.stringify(context, null, 2).slice(0, 12000);

const templates = {
  chat: ({ message, context }) => [
    { role: 'system', content: EDU_FLOW_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `User question:\n${message}\n\nAvailable Edu Flow context:\n${stringifyContext(context)}\n\nUse the school name from context when relevant, keep the workflow specific to the active role, and do not mix teacher, admin, and student responsibilities.`,
    },
  ],

  studentPerformance: ({ student, attendance, results, fees, remarks }) => [
    { role: 'system', content: EDU_FLOW_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `
Analyze this student and return only valid JSON using this shape:
{
  "summary": "short summary",
  "progressPercent": 0,
  "confidencePercent": 0,
  "strengths": ["..."],
  "weaknesses": ["..."],
  "riskAlerts": ["..."],
  "achievementInsights": ["..."],
  "monthlyComparison": {
    "trend": "improving | stable | declining",
    "attendanceChange": "short text",
    "marksChange": "short text",
    "feeChange": "short text"
  },
  "predictions": {
    "futurePerformance": "short text",
    "examProbability": "short text",
    "attendanceTrend": "short text",
    "feePaymentProbability": "short text",
    "academicGrowth": "short text"
  },
  "recommendations": ["..."],
  "parentNote": "short parent friendly note"
}

Student:
${stringifyContext(student)}

Attendance:
${stringifyContext(attendance)}

Results:
${stringifyContext(results)}

Fees:
${stringifyContext(fees)}

Teacher remarks:
${stringifyContext(remarks)}
`,
    },
  ],

  studentPrediction: ({ student, attendance, results, fees, remarks }) => [
    { role: 'system', content: EDU_FLOW_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `
Predict this student's likely near-term outcomes and return only valid JSON:
{
  "confidencePercent": 0,
  "overallOutlook": "short text",
  "cards": [
    {
      "title": "Future performance",
      "value": "High | Medium | Low",
      "confidencePercent": 0,
      "insight": "short explanation",
      "suggestion": "short improvement suggestion"
    }
  ],
  "riskLevel": "low | moderate | high",
  "topOpportunities": ["..."]
}

Cards must cover:
- Student future performance
- Exam probability
- Attendance trends
- Fee payment probability
- Academic growth
- Risk level / top achiever chance

Student:
${stringifyContext(student)}

Attendance:
${stringifyContext(attendance)}

Results:
${stringifyContext(results)}

Fees:
${stringifyContext(fees)}

Teacher remarks:
${stringifyContext(remarks)}
`,
    },
  ],

  quizGenerator: ({ className, subject, difficulty, topic, chapter, questionCount, examType }) => [
    { role: 'system', content: EDU_FLOW_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Generate a structured AI Exam as a valid JSON array of Multiple Choice Questions.
Return ONLY the JSON array. Each object in the array must follow this exact shape:
{
  "question": "The text of the question",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "answer": 0
}
The "answer" field must be the 0-based index of the correct option in the "options" array.

Class: ${className || 'Not specified'}
Subject: ${subject || 'General'}
Difficulty: ${difficulty || 'medium'}
Topic: ${topic || 'Mixed'}
Chapter: ${chapter || 'Not specified'}
Number of MCQs: ${questionCount || 10}
Ensure the questions are challenging and relevant to the subject.
`,
    },
  ],

  achievers: ({ students }) => [
    { role: 'system', content: EDU_FLOW_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `
Create premium AI achievement cards for these students and return only valid JSON:
{
  "cards": [
    {
      "studentId": 0,
      "category": "Top Performer | Most Improved | Best Attendance | Best Discipline | Highest Marks | Academic Risk",
      "rank": "#1",
      "achievementPercent": 0,
      "title": "short title",
      "description": "premium concise description",
      "schoolNote": "short school note"
    }
  ],
  "summary": "short dashboard summary"
}

Students:
${stringifyContext(students)}
`,
    },
  ],
};

module.exports = {
  EDU_FLOW_SYSTEM_PROMPT,
  templates,
};
