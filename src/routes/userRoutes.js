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

    res.json({ ...userDoc.data(), id: userDoc.id });
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

// PUT /api/user/fcm-token   { token }
router.put("/fcm-token", verifyToken, async (req, res) => {
  try {
    const token = String((req.body && req.body.token) || "").trim();
    if (!token) return res.status(400).json({ error: "token kötelező." });
    await db.collection("users").doc(req.userId).set(
      { fcmTokens: admin.firestore.FieldValue.arrayUnion(token) },
      { merge: true }
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/user/fcm-token   { token }   (call on logout)
router.delete("/fcm-token", verifyToken, async (req, res) => {
  try {
    const token = String((req.body && req.body.token) || "").trim();
    if (token) {
      await db.collection("users").doc(req.userId)
        .update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(token) })
        .catch(() => {});
    }
    res.json({ ok: true });
  } catch (error) {
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

const BATCH_SIZE = 400;

async function batchDeleteDocs(docs) {
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    docs.slice(i, i + BATCH_SIZE).forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }
}

router.delete("/account", verifyToken, async (req, res) => {
  const userId = req.userId;
  try {
    // 1. Get all guests
    const guestsSnapshot = await db.collection("guests")
      .where("user_id", "==", userId)
      .get();

    // 2. For each guest: delete Storage files + userPackages subcollection
    await Promise.all(guestsSnapshot.docs.map(async (guestDoc) => {
      const guestId = guestDoc.id;
      const [guestFiles] = await bucket.getFiles({ prefix: `guests/${guestId}/` });
      await Promise.all(guestFiles.map(f => f.delete()));

      const pkgsSnap = await db.collection("userPackages").doc(guestId)
        .collection("packages").get();
      if (!pkgsSnap.empty) await batchDeleteDocs(pkgsSnap.docs);
      await db.collection("userPackages").doc(guestId).delete();
    }));

    // 3. Delete guest documents
    if (!guestsSnapshot.empty) await batchDeleteDocs(guestsSnapshot.docs);

    // 4. Delete appointments
    const apptSnap = await db.collection("appointments")
      .where("user_id", "==", userId).get();
    if (!apptSnap.empty) await batchDeleteDocs(apptSnap.docs);

    // 5. Delete exercise plans
    const plansSnap = await db.collection("exercisePlans")
      .where("user_id", "==", userId).get();
    if (!plansSnap.empty) await batchDeleteDocs(plansSnap.docs);

    // 6. Delete owned package templates
    const pkgSnap = await db.collection("packages")
      .where("ownerId", "==", userId).get();
    if (!pkgSnap.empty) await batchDeleteDocs(pkgSnap.docs);

    // 7. Delete user Storage files (profile image)
    const [userFiles] = await bucket.getFiles({ prefix: `users/${userId}/` });
    await Promise.all(userFiles.map(f => f.delete()));

    // 8. Delete Firestore user profile
    await db.collection("users").doc(userId).delete();

    // 9. Delete Firebase Auth account
    await admin.auth().deleteUser(userId);

    res.json({ message: "Fiók sikeresen törölve" });
  } catch (error) {
    console.error("❌ Error deleting account for user", userId, ":", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
