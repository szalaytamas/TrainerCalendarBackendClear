const express = require("express");
const admin = require("firebase-admin");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const db = admin.firestore();

router.get("/", verifyToken, async (req, res) => {
  try {
    const userRef = db.collection("users").doc(req.userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(userDoc.data());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/", verifyToken, async (req, res) => {
  try {
    const { forename, lastname, email, password } = req.body;
    const userRef = db.collection("users").doc(req.userId);
    const updateData = {};

    if (forename) updateData.forename = forename;
    if (lastname) updateData.lastname = lastname;
    if (email) updateData.email = email;

    if (Object.keys(updateData).length > 0) {
      await userRef.update(updateData);
    }

    const authUpdates = {};
    if (email) authUpdates.email = email;
    if (password) authUpdates.password = password;
    if (forename || lastname) {
      authUpdates.displayName = `${forename || ""} ${lastname || ""}`.trim();
    }

    if (Object.keys(authUpdates).length > 0) {
      await admin.auth().updateUser(req.userId, authUpdates);
    }

    res.json({ message: "User updated successfully" });
  } catch (error) {
    console.error("❌ Error updating user:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
