const express = require("express");
const admin = require("firebase-admin");
const multer = require("multer");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const db = admin.firestore();
const bucket = admin.storage().bucket();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Csak JPEG, PNG vagy WEBP formátum engedélyezett."));
  }
});

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

router.post("/upload-photo", verifyToken, (req, res, next) => {
  upload.single("profileImage")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file || req.file.size === 0) {
      return res.status(400).json({ error: "Nincs feltöltött fájl, vagy a fájl üres!" });
    }

    const crypto = require("crypto");
    const token = crypto.randomUUID();
    const fileName = `users/${req.userId}/profile.jpg`;
    const file = bucket.file(fileName);

    await file.save(req.file.buffer, {
      metadata: {
        contentType: "image/jpeg",
        cacheControl: "public, max-age=31536000",
        metadata: { firebaseStorageDownloadTokens: token },
      },
    });

    const encodedPath = encodeURIComponent(fileName);
    const fileUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${token}`;
    await db.collection("users").doc(req.userId).update({ profileImage: fileUrl });

    res.status(200).json({ message: "Image uploaded successfully", imageUrl: fileUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/photo", verifyToken, async (req, res) => {
  try {
    const file = bucket.file(`users/${req.userId}/profile.jpg`);
    const [exists] = await file.exists();
    if (exists) await file.delete();

    await db.collection("users").doc(req.userId).update({ profileImage: null });

    res.json({ message: "Kép sikeresen törölve" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
