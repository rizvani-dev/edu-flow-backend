const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { normalizeStoredMediaPath } = require('../utils/media');

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const error = new Error('JWT_SECRET environment variable is not defined.');
    error.statusCode = 500;
    error.publicMessage = 'Authentication is not configured on the server.';
    throw error;
  }

  return secret;
};

const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  try {
    const query = `
      SELECT u.*, c.name as class_name, s.name as school_name, s.logo_url as school_logo_url
      FROM users u 
      LEFT JOIN classes c ON u.class_id = c.id
      LEFT JOIN schools s ON u.school_id = s.id
      WHERE u.email = $1`;

    const { rows } = await pool.query(query, [email]);
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email, 
        role: user.role,
        class_id: user.class_id,
        school_id: user.school_id
      },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        class_id: user.class_id,
        class_name: user.class_name,
        school_name: user.school_name,
        school_logo_url: normalizeStoredMediaPath(user.school_logo_url),
        profile_image: normalizeStoredMediaPath(user.profile_image),
        bio: user.bio
      }
    });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.publicMessage || 'Server error',
    });
  }
};

// Only for initial setup
const registerAdmin = async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [name, email, hashedPassword, 'admin']
    );
    res.status(201).json({ success: true, message: 'Admin created', user: rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { login, registerAdmin };
