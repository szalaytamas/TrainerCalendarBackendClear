const express = require("express");
const admin = require("firebase-admin");

const router = express.Router();
const db = admin.firestore();

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

router.post("/", verifyToken, async (req, res) => {
  try {
      const { client_name, date, notes, guest_id } = req.body;

      if (!client_name || !date) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const newAppointment = {
        user_id: req.userId,
        client_name,
        date,
        notes: notes || "",
        guest_id: guest_id || null,
        attended: false
      };

      if (guest_id) {
          const userPackageRef = db.collection("userPackages").doc(guest_id);
          const userPackageDoc = await userPackageRef.get();

          if (userPackageDoc.exists) {
              const userPackages = userPackageDoc.data().packages || [];

              // 🔹 Először keressünk olyan aktív bérletet, amelynek van fennmaradó alkalma
              let activePackage = userPackages.find(pkg => pkg.remainingSessions > 0);

              // 🔹 Ha nincs ilyen, de van "unlimited" bérlet, akkor azt használjuk
              if (!activePackage) {
                  activePackage = userPackages.find(pkg => pkg.packageId === "unlimited");
              }

              if (activePackage) {
                  newAppointment.packageId = activePackage.id;
              } else {
                  console.warn(`⚠️ Vendégnek nincs aktív bérlete. PackageId NEM lesz beállítva.`);
              }
          }
      }

      const docRef = await db.collection("appointments").add(newAppointment);
      res.status(201).json({ id: docRef.id, message: "Appointment created", guest_id: guest_id || null });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

router.get("/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const snapshot = await db.collection("appointments").where("user_id", "==", userId).get();

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
      client_name: client_name !== undefined ? client_name : doc.data().client_name,
      date: date !== undefined ? date : doc.data().date,
      notes: notes !== undefined ? notes : doc.data().notes,
      guest_id: guest_id !== undefined ? guest_id : doc.data().guest_id,
      attended: attended !== undefined ? attended : doc.data().attended,
      packageId: guest_id ? (packageId !== undefined ? packageId : doc.data().packageId) : null
    };

    await appointmentRef.update(updatedAppointment);
    res.json({ message: "Appointment updated successfully", attended: updatedAppointment.attended });

  } catch (error) {
    console.error("🔥 Error updating appointment:", error);
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

    const guestId = doc.data().guest_id;

        if (guestId) {
          const guestRef = db.collection("guests").doc(guestId);
          const guestDoc = await guestRef.get();

          if (guestDoc.exists) {
            let appointments = guestDoc.data().appointments || [];
            appointments = appointments.filter(date => date !== doc.data().date);
            await guestRef.update({ appointments });
          }
        }

    await appointmentRef.delete();
    res.json({ message: "Appointment deleted successfully" });
  } catch (error) {
    console.error("🔥 Error deleting appointment:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
