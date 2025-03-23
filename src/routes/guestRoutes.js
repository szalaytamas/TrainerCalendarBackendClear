const express = require("express");
const admin = require("firebase-admin");

const router = express.Router();
const db = admin.firestore();

const { Storage } = require("@google-cloud/storage");
const multer = require("multer");
const path = require("path");

const storage = new Storage({
                              keyFilename: "C:/Users/szala/AndroidStudioProjects/FitnessApp/backend/service-account-file.json",
                            });
const bucket = storage.bucket("fitnessapp-48d34.firebasestorage.app");

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // Max 5MB
});

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

router.post("/:guestId/upload-photo", verifyToken, upload.single("profileImage"), async (req, res) => {
    try {
        const { guestId } = req.params;

        if (!req.file || req.file.size === 0) {
                    return res.status(400).json({ error: "Nincs feltöltött fájl, vagy a fájl üres!" });
                }

        const fileName = `guests/${guestId}/${Date.now()}_${req.file.originalname}`;
        const file = bucket.file(fileName);

        const stream = file.createWriteStream({
            metadata: {
                contentType: req.file.mimetype,
            },
        });

         stream.on("error", (err) => {
                    console.error("❌ Hibás fájlfeltöltés:", err);
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

router.get("/:guestId", verifyToken, async (req, res) => {
    try {
        const { guestId } = req.params;
        const guestDoc = await db.collection("guests").doc(guestId).get();

        if (!guestDoc.exists) {
            return res.status(404).json({ error: "Guest not found" });
        }

        res.status(200).json(guestDoc.data());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post("/", verifyToken, async (req, res) => {
  try {
    const { name, email, phone, notes, isActive } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required" });
    }

    const newGuest = {
      user_id: req.userId,
      name,
      email,
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

router.post("/:guestId/appointments", verifyToken, async (req, res) => {
    try {
        const { guestId } = req.params;
        const { date } = req.body;

        if (!date) {
            return res.status(400).json({ error: "Missing appointment date" });
        }

        const guestRef = db.collection("guests").doc(guestId);
        const doc = await guestRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: "Guest not found" });
        }

        await guestRef.update({
            appointments: admin.firestore.FieldValue.arrayUnion(date)
        });

        res.json({ message: "Appointment added to guest successfully" });
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

        const guestData = doc.data();
        const appointments = guestData.appointments || [];

        res.json({
            guestId: guestId,
            guestName: guestData.name,
            appointments: appointments.map(date => ({
                date: date,
                notes: guestData.notes || ""
            }))
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put("/:guestId/update-appointment", verifyToken, async (req, res) => {
    try {
        const { guestId } = req.params;
        const { oldDate, newDate } = req.body;

        if (!oldDate || !newDate) {
            return res.status(400).json({ error: "Missing old or new appointment date" });
        }

        const guestRef = db.collection("guests").doc(guestId);
        const doc = await guestRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: "Guest not found" });
        }

        let appointments = doc.data().appointments || [];

        appointments = appointments.filter(date => date !== oldDate);
        appointments.push(newDate);

        await guestRef.update({ appointments });

        res.json({ message: "Guest appointment updated successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put("/:guestId/remove-appointment", verifyToken, async (req, res) => {
    try {
        const { guestId } = req.params;
        const { date } = req.body;

        if (!date) {
            return res.status(400).json({ error: "Missing appointment date" });
        }

        const guestRef = db.collection("guests").doc(guestId);
        const doc = await guestRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: "Guest not found" });
        }

        let appointments = doc.data().appointments || [];

        appointments = appointments.filter(d => d !== date);

        await guestRef.update({ appointments });

        res.json({ message: "Guest appointment removed successfully" });
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

router.put("/:id", verifyToken, async (req, res) => {
  try {
    const guestId = req.params.id;
    const { name, email, phone, notes } = req.body;

    const guestRef = db.collection("guests").doc(guestId);
    const doc = await guestRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Guest not found" });
    }

    if (doc.data().user_id !== req.userId) {
      return res.status(403).json({ error: "Unauthorized to update this guest" });
    }

    const updatedGuest = {
      name: name || doc.data().name,
      email: email || doc.data().email,
      phone: phone || doc.data().phone,
      notes: notes || doc.data().notes,
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
