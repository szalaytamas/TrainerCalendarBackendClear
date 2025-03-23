const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const admin = require("firebase-admin");
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "fitnessapp-48d34.firebasestorage.app"
});
console.log("✅ Firebase Service Account betöltve:", serviceAccount.client_email);
console.log("Firebase Storage bucket: ", admin.storage().bucket().name);
const bucket = admin.storage().bucket();
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "Backend is running!" });
});

const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const appointmentRoutes = require("./routes/appointmentRoutes");
const guestRoutes = require("./routes/guestRoutes");
const exercisePlanRoutes = require("./routes/exercisePlanRoutes");
const packageRoutes = require("./routes/packageRoutes")

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/guests", guestRoutes);
app.use("/api/exercise-plans", exercisePlanRoutes);
app.use("/api/packages", packageRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🔥 Server is running on port ${PORT}`);
});
