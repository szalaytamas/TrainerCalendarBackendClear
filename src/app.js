const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");
const admin = require("firebase-admin");

dotenv.config();

const credential = admin.credential.cert(
  JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
);

admin.initializeApp({
  credential,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "fitnessapp-48d34.firebasestorage.app"
});

const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : [];

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : false
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts, please try again later." }
});

app.use(express.json());
app.use("/api/", apiLimiter);
app.use("/api/auth", authLimiter);

app.get("/", (req, res) => {
  res.json({ message: "Backend is running!" });
});

const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const appointmentRoutes = require("./routes/appointmentRoutes");
const guestRoutes = require("./routes/guestRoutes");
const exercisePlanRoutes = require("./routes/exercisePlanRoutes");
const packageRoutes = require("./routes/packageRoutes");

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/guests", guestRoutes);
app.use("/api/exercise-plans", exercisePlanRoutes);
app.use("/api/packages", packageRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
