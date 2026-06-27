const express = require("express");
const admin = require("firebase-admin");
const multer = require("multer");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const db = admin.firestore();
const bucket = admin.storage().bucket();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.post("/:guestId/upload-photo", verifyToken, upload.single("profileImage"), async (req, res) => {
  try {
    const { guestId } = req.params;

    if (!req.file || req.file.size === 0) {
      return res.status(400).json({ error: "Nincs feltöltött fájl, vagy a fájl üres!" });
    }

    const fileName = `guests/${guestId}/${Date.now()}_${req.file.originalname}`;
    const file = bucket.file(fileName);

    const stream = file.createWriteStream({
      metadata: { contentType: req.file.mimetype },
    });

    stream.on("error", (err) => {
      res.status(500).json({ error: err.message });
    });

    stream.on("finish", async () => {
      await file.makePublic();
      const fileUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
      await db.collection("guests").doc(guestId).update({ profileImage: fileUrl });
      res.status(200).json({ message: "Image uploaded successfully", imageUrl: fileUrl });
    });

    stream.end(req.file.buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/", verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection("guests").where("user_id", "==", req.userId).get();
    const guests = [];
    snapshot.forEach((doc) => {
      guests.push({ id: doc.id, ...doc.data() });
    });
    res.json(guests);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:guestId", verifyToken, async (req, res) => {
  try {
    const { guestId } = req.params;
    const guestDoc = await db.collection("guests").doc(guestId).get();

    if (!guestDoc.exists) {
      return res.status(404).json({ error: "Guest not found" });
    }
    if (guestDoc.data().user_id !== req.userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    res.status(200).json({ id: guestId, ...guestDoc.data() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/", verifyToken, async (req, res) => {
  try {
    const { name, email, phone, notes } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Name is required." });
    }
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }

    const newGuest = {
      user_id: req.userId,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      phone: phone || "",
      notes: notes || "",
      isActive: true
    };

    const docRef = await db.collection("guests").add(newGuest);
    res.status(201).json({ id: docRef.id, message: "Guest created successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:guestId/appointments", verifyToken, async (req, res) => {
  try {
    const guestId = req.params.guestId;
    const guestRef = db.collection("guests").doc(guestId);
    const doc = await guestRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Guest not found" });
    }
    if (doc.data().user_id !== req.userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const snapshot = await db.collection("appointments")
      .where("guest_id", "==", guestId)
      .get();

    const appointments = [];
    snapshot.forEach(doc => appointments.push({ id: doc.id, ...doc.data() }));
    appointments.sort((a, b) => a.date.localeCompare(b.date));

    res.json({ guestId, guestName: doc.data().name, appointments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/:id", verifyToken, async (req, res) => {
  try {
    const guestId = req.params.id;
    const { name, email, phone, notes } = req.body;

    if (email && !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }

    const guestRef = db.collection("guests").doc(guestId);
    const doc = await guestRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Guest not found" });
    }
    if (doc.data().user_id !== req.userId) {
      return res.status(403).json({ error: "Unauthorized to update this guest" });
    }

    const updatedGuest = {
      name: name ? name.trim() : doc.data().name,
      email: email ? email.trim().toLowerCase() : doc.data().email,
      phone: phone !== undefined ? phone : doc.data().phone,
      notes: notes !== undefined ? notes : doc.data().notes,
    };

    await guestRef.update(updatedGuest);
    res.json({ message: "Guest updated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/:id/restore", verifyToken, async (req, res) => {
  try {
    const guestId = req.params.id;
    const guestRef = db.collection("guests").doc(guestId);
    const doc = await guestRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Guest not found" });
    }
    if (doc.data().user_id !== req.userId) {
      return res.status(403).json({ error: "Unauthorized to restore this guest" });
    }

    await guestRef.update({ isActive: true });
    res.json({ message: "Guest restored successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const guestId = req.params.id;
    const guestRef = db.collection("guests").doc(guestId);
    const doc = await guestRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Guest not found" });
    }
    if (doc.data().user_id !== req.userId) {
      return res.status(403).json({ error: "Unauthorized to delete this guest" });
    }

    await guestRef.update({ isActive: false });
    res.json({ message: "Guest deactivated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
