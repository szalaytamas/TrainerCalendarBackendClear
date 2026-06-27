const express = require("express");
const admin = require("firebase-admin");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const db = admin.firestore();

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/;

router.post("/", verifyToken, async (req, res) => {
  try {
    const { client_name, date, notes, guest_id } = req.body;

    if (!client_name || !client_name.trim()) {
      return res.status(400).json({ error: "Client name is required." });
    }
    if (!date || !ISO_DATE_REGEX.test(date)) {
      return res.status(400).json({ error: "Valid date is required (ISO format)." });
    }

    const newAppointment = {
      user_id: req.userId,
      client_name: client_name.trim(),
      date,
      notes: notes || "",
      guest_id: guest_id || null,
      attended: false
    };

    if (guest_id) {
      const packagesSnapshot = await db.collection("userPackages").doc(guest_id)
        .collection("packages").get();

      if (!packagesSnapshot.empty) {
        let activePackage = null;
        packagesSnapshot.forEach(doc => {
          const pkg = doc.data();
          if (!activePackage && pkg.remainingSessions > 0) {
            activePackage = { ...pkg, id: doc.id };
          }
        });
        if (!activePackage) {
          packagesSnapshot.forEach(doc => {
            const pkg = doc.data();
            if (!activePackage && pkg.packageId === "unlimited") {
              activePackage = { ...pkg, id: doc.id };
            }
          });
        }
        if (activePackage) {
          newAppointment.packageId = activePackage.id;
        }
      }
    }

    const docRef = await db.collection("appointments").add(newAppointment);
    res.status(201).json({ id: docRef.id, message: "Appointment created", guest_id: guest_id || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:userId", verifyToken, async (req, res) => {
  try {
    const userId = req.params.userId;

    if (req.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const { from, to } = req.query;

    let query = db.collection("appointments").where("user_id", "==", userId);
    if (from) query = query.where("date", ">=", from);
    if (to)   query = query.where("date", "<=", to);
    query = query.orderBy("date", "asc").limit(500);

    const snapshot = await query.get();

    const appointments = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      appointments.push({
        id: doc.id,
        user_id: data.user_id,
        guest_id: data.guest_id || null,
        client_name: data.client_name,
        date: data.date,
        notes: data.notes,
        attended: data.hasOwnProperty("attended") ? data.attended : false,
        packageId: data.packageId || null
      });
    });

    res.json(appointments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/:id", verifyToken, async (req, res) => {
  try {
    const appointmentId = req.params.id;
    const { client_name, date, notes, guest_id, attended, packageId } = req.body;

    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const doc = await appointmentRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    if (doc.data().user_id !== req.userId) {
      return res.status(403).json({ error: "Unauthorized to update this appointment" });
    }

    const updatedAppointment = {
      client_name: client_name !== undefined ? client_name.trim() : doc.data().client_name,
      date: date !== undefined ? date : doc.data().date,
      notes: notes !== undefined ? notes : doc.data().notes,
      guest_id: guest_id !== undefined ? guest_id : doc.data().guest_id,
      attended: attended !== undefined ? attended : doc.data().attended,
      packageId: guest_id ? (packageId !== undefined ? packageId : doc.data().packageId) : null
    };

    await appointmentRef.update(updatedAppointment);
    res.json({ message: "Appointment updated successfully", attended: updatedAppointment.attended });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const appointmentId = req.params.id;
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const doc = await appointmentRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    if (doc.data().user_id !== req.userId) {
      return res.status(403).json({ error: "Unauthorized to delete this appointment" });
    }

    await appointmentRef.delete();
    res.json({ message: "Appointment deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
