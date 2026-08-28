const admin = require("firebase-admin");

// Trainer auth: any valid Firebase ID token. Sets req.userId.
const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split("Bearer ")[1];
  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.userId = decodedToken.uid;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

// Guest-portal auth: requires a verified email (email-link sign-in gives this).
// Sets req.guestUid and req.guestEmail (lowercased).
const verifyGuestToken = async (req, res, next) => {
  const token = req.headers.authorization?.split("Bearer ")[1];
  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (!decoded.email || decoded.email_verified !== true) {
      return res.status(403).json({ error: "Verified email required" });
    }
    req.guestUid = decoded.uid;
    req.guestEmail = String(decoded.email).toLowerCase();
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

module.exports = { verifyToken, verifyGuestToken };
