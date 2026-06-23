const express = require("express");
const admin = require("firebase-admin");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const db = admin.firestore();

router.get("/", verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection("packages").get();
    const packages = snapshot.docs.map(doc => ({
      id: doc.id,
      name: doc.data().name,
      sessionCount: doc.data().sessionCount,
      durationDays: doc.data().durationDays,
      description: doc.data().description
    }));
    res.json(packages);
  } catch (err) {
    res.status(500).json({ error: "Hiba a bérletek lekérésekor" });
  }
});

router.post("/", verifyToken, async (req, res) => {
  try {
    const { name, sessionCount, durationDays, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "A bérlet neve kötelező." });
    }
    if (sessionCount === undefined || sessionCount === null || isNaN(Number(sessionCount))) {
      return res.status(400).json({ error: "Az alkalmak száma kötelező szám." });
    }
    if (durationDays === undefined || durationDays === null || isNaN(Number(durationDays))) {
      return res.status(400).json({ error: "Az időtartam (napban) kötelező szám." });
    }

    const newPackage = {
      name: name.trim(),
      sessionCount: Number(sessionCount),
      durationDays: Number(durationDays),
      description: description || ""
    };
    const docRef = await db.collection("packages").add(newPackage);
    res.status(201).json({ id: docRef.id, ...newPackage, message: "Bérlet sikeresen létrehozva!" });
  } catch (err) {
    res.status(500).json({ error: "Hiba a bérlet létrehozásakor" });
  }
});

router.get("/user-packages/:guestId", verifyToken, async (req, res) => {
  try {
    const { guestId } = req.params;
    const userPackageRef = db.collection("userPackages").doc(guestId);
    const userPackageDoc = await userPackageRef.get();

    if (!userPackageDoc.exists) {
      return res.status(404).json({ error: "A vendéghez nem tartozik bérlet." });
    }

    const userPackages = userPackageDoc.data().packages || [];
    const now = admin.firestore.Timestamp.now();
    const activePackages = [];
    const expiredPackages = [];

    userPackages.forEach(pkg => {
      const endDate = pkg.endDate ? pkg.endDate.toDate() : null;
      const isUnlimited = pkg.packageId === "unlimited";
      const isExpiredByDate = endDate && endDate <= now.toDate();

      if (isUnlimited) {
        isExpiredByDate ? expiredPackages.push(pkg) : activePackages.push(pkg);
      } else {
        const isExpiredBySessions = pkg.remainingSessions !== undefined && pkg.remainingSessions <= 0;
        (isExpiredByDate || isExpiredBySessions) ? expiredPackages.push(pkg) : activePackages.push(pkg);
      }
    });

    res.json({ activePackages, expiredPackages });
  } catch (err) {
    res.status(500).json({ error: "Hiba a vendég bérleteinek lekérésekor" });
  }
});

router.put("/user-packages/:guestId", verifyToken, async (req, res) => {
  try {
    const { guestId } = req.params;
    const { attended, packageId } = req.body;

    if (typeof attended !== "boolean" || !packageId) {
      return res.status(400).json({ error: "Hiányzó vagy érvénytelen 'attended' érték" });
    }

    const userPackageRef = db.collection("userPackages").doc(guestId);
    const userPackageDoc = await userPackageRef.get();

    if (!userPackageDoc.exists) {
      return res.status(404).json({ error: "A vendéghez nem tartozik bérlet." });
    }

    let userPackages = userPackageDoc.data().packages || [];
    let updatedPackage = null;

    userPackages = userPackages.map(pkg => {
      if (pkg.id === packageId) {
        const isUnlimited = pkg.packageId === "unlimited";
        const newRemainingSessions = isUnlimited
          ? pkg.remainingSessions
          : attended
            ? Math.max(pkg.remainingSessions - 1, 0)
            : Math.min(pkg.remainingSessions + 1, pkg.sessionCount);
        updatedPackage = { ...pkg, remainingSessions: newRemainingSessions };
        return updatedPackage;
      }
      return pkg;
    });

    if (!updatedPackage) {
      return res.status(404).json({ error: "Bérlet nem található a vendégnél." });
    }

    await userPackageRef.update({ packages: userPackages });
    res.json({ message: "Bérlet frissítve!", updatedPackage });
  } catch (err) {
    res.status(500).json({ error: "Hiba a bérlet frissítésekor" });
  }
});

router.post("/assignPackage", verifyToken, async (req, res) => {
  try {
    const { guestId, packageId } = req.body;

    if (!guestId || !packageId) {
      return res.status(400).json({ error: "guestId és packageId megadása kötelező." });
    }

    const packageRef = db.collection("packages").doc(packageId);
    const packageDoc = await packageRef.get();

    if (!packageDoc.exists) {
      return res.status(404).json({ error: "Bérlet nem található" });
    }

    const packageData = packageDoc.data();
    const startDate = new Date();
    const endDate = packageData.durationDays
      ? new Date(startDate.getTime() + packageData.durationDays * 24 * 60 * 60 * 1000)
      : null;

    const userPackageRef = db.collection("userPackages").doc(guestId);
    const userPackageDoc = await userPackageRef.get();

    const newPackageId = db.collection("userPackages").doc().id;
    const newPackage = {
      id: newPackageId,
      packageId,
      name: packageData.name,
      sessionCount: packageData.sessionCount,
      durationDays: packageData.durationDays,
      description: packageData.description,
      startDate: admin.firestore.Timestamp.fromDate(startDate),
      endDate: endDate ? admin.firestore.Timestamp.fromDate(endDate) : null,
      remainingSessions: packageData.sessionCount
    };

    if (userPackageDoc.exists) {
      await userPackageRef.update({
        packages: admin.firestore.FieldValue.arrayUnion(newPackage)
      });
    } else {
      await userPackageRef.set({ packages: [newPackage] });
    }

    res.json({ message: "Bérlet sikeresen hozzárendelve!", package: newPackage });
  } catch (err) {
    res.status(500).json({ error: "Hiba a bérlet hozzárendelésekor" });
  }
});

router.get("/:packageId", verifyToken, async (req, res) => {
  try {
    const { packageId } = req.params;
    const packageRef = db.collection("packages").doc(packageId);
    const doc = await packageRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Bérlet nem található" });
    }

    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: "Hiba a bérlet lekérésekor" });
  }
});

router.put("/:packageId", verifyToken, async (req, res) => {
  try {
    const { packageId } = req.params;
    const { name, sessionCount, durationDays, description } = req.body;

    const packageRef = db.collection("packages").doc(packageId);
    const doc = await packageRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Bérlet nem található" });
    }

    const updatedPackage = {
      name: name || doc.data().name,
      sessionCount: sessionCount !== undefined ? sessionCount : doc.data().sessionCount,
      durationDays: durationDays !== undefined ? durationDays : doc.data().durationDays,
      description: description || doc.data().description
    };

    await packageRef.update(updatedPackage);
    res.json({ message: "Bérlet sikeresen frissítve!", package: updatedPackage });
  } catch (err) {
    res.status(500).json({ error: "Hiba a bérlet frissítésekor" });
  }
});

router.delete("/:packageId", verifyToken, async (req, res) => {
  try {
    const { packageId } = req.params;
    const packageRef = db.collection("packages").doc(packageId);
    const doc = await packageRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Bérlet nem található" });
    }

    await packageRef.delete();
    res.json({ message: "Bérlet sikeresen törölve!" });
  } catch (err) {
    res.status(500).json({ error: "Hiba a bérlet törlésekor" });
  }
});

module.exports = router;
