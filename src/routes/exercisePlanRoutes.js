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
    const { guest_id, guest_name, workout_day, exercises } = req.body;

    if (!guest_id || !guest_name || !workout_day || !Array.isArray(exercises) || exercises.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

        const guestRef = db.collection("guests").doc(guest_id);
        const guestDoc = await guestRef.get();
        if (!guestDoc.exists) {
          return res.status(404).json({ error: "Guest not found" });
        }
        const guestName = guestDoc.data().name;

    const newPlan = {
      user_id: req.userId,
      guest_id: guest_id,
      guest_name: guestName,
      workout_day: workout_day,
      exercises: exercises.map(exercise => ({
        exercise_name: exercise.exercise_name,
        sets: exercise.sets,
        reps: exercise.reps,
        weight: exercise.weight || null,
        notes: exercise.notes || ""
      })),
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("exercisePlans").add(newPlan);
    const createdPlan = (await docRef.get()).data();
    res.status(201).json({ id: docRef.id, ...createdPlan });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/guest/:guestId", verifyToken, async (req, res) => {
    try {
        const { guestId } = req.params;

        const snapshot = await db.collection("exercisePlans")
            .where("guest_id", "==", guestId)
            .where("user_id", "==", req.userId)
            .get();

        const plans = [];
        snapshot.forEach((doc) => {
            plans.push({ id: doc.id, ...doc.data() });
        });

        res.json(plans);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get("/all/:workoutDay", verifyToken, async (req, res) => {
    try {
        const workoutDay = req.params.workoutDay;

        const snapshot = await db.collection("exercisePlans")
            .where("workout_day", "==", workoutDay)
            .get();

        if (snapshot.empty) {
            return res.json([]);
        }

        const plans = [];
        snapshot.forEach((doc) => {
            plans.push({ id: doc.id, ...doc.data() });
        });

        res.json(plans);
    } catch (error) {
        console.error("🔥 Error fetching all exercise plans:", error);
        res.status(500).json({ error: error.message });
    }
});

router.get("/:guestId/:workoutDay", verifyToken, async (req, res) => {
  try {
    const { guestId, workoutDay } = req.params;

    const snapshot = await db
      .collection("exercisePlans")
      .where("guest_id", "==", guestId)
      .where("user_id", "==", req.userId)
      .where("workout_day", "==", workoutDay)
      .get();

    const plans = [];
    snapshot.forEach((doc) => {
      plans.push({ id: doc.id, ...doc.data() });
    });

    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const planId = req.params.id;
    const planRef = db.collection("exercisePlans").doc(planId);
    const doc = await planRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Exercise plan not found" });
    }

    if (doc.data().user_id !== req.userId) {
      return res.status(403).json({ error: "Unauthorized to view this plan" });
    }

    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


router.put("/:id", verifyToken, async (req, res) => {
  try {
    const planId = req.params.id;
    const { guest_id, workout_day, exercises } = req.body;

    if (!workout_day || !Array.isArray(exercises) || exercises.length === 0) {
          return res.status(400).json({ error: "Missing required fields" });
        }

    const planRef = db.collection("exercisePlans").doc(planId);
    const doc = await planRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Exercise plan not found" });
    }

    if (doc.data().user_id !== req.userId) {
      return res.status(403).json({ error: "Unauthorized to update this plan" });
    }

    const updatedPlan = {
        guest_id: guest_id || doc.data().guest_id,
        workout_day: workout_day || doc.data().workout_day,
        exercises: Array.isArray(exercises) ? exercises : doc.data().exercises,
    };

    await planRef.update(updatedPlan);
    res.json({ message: "Exercise plan updated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const planId = req.params.id;
    const planRef = db.collection("exercisePlans").doc(planId);
    const doc = await planRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Exercise plan not found" });
    }

    if (doc.data().user_id !== req.userId) {
      return res.status(403).json({ error: "Unauthorized to delete this plan" });
    }

    await planRef.delete();
    res.json({ message: "Exercise plan deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
