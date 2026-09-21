const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
  const authHeader = String(req.headers.authorization || '');
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];

  if (!token) return res.status(401).json({ message: 'Access token required' });

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ message: 'Authentication is not configured on the server' });
  }

  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid token' });
    req.user = user;
    next();
  });
};

module.exports = authenticateToken;
