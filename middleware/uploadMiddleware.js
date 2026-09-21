const multer = require('multer');
const path = require('path');

// ================= STORAGE =================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/chat/'); // make sure this folder exists
  },
  filename: (req, file, cb) => {
    const uniqueSuffix =
      Date.now() + '-' + Math.round(Math.random() * 1e9);

    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

// ================= FILE FILTER =================
const fileFilter = (req, file, cb) => {
  const allowedTypes =
    /jpeg|jpg|png|gif|webp|pdf|mp4|webm|ogg|mp3|wav|m4a|aac/;

  const extname = allowedTypes.test(
    path.extname(file.originalname).toLowerCase()
  );

  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error('Only images, PDF, video, and audio files are allowed!'));
  }
};

// ================= UPLOAD =================
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter,
});

module.exports = upload;