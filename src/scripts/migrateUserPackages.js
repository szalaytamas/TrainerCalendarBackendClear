/**
 * Egyszeri migrációs script: userPackages.packages[] array -> subcollection
 *
 * Futtatás (a backend-clean-again mappából):
 *   node src/scripts/migrateUserPackages.js
 */

const path = require("path");
const envPath = path.resolve(__dirname, "../../.env");
require("dotenv").config({ path: envPath, override: true });

const admin = require("firebase-admin");
const fs = require("fs");

let credential;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // A relatív út a .env fájl könyvtárához képest értendő
    const envDir = path.dirname(envPath);
    const keyPath = path.resolve(envDir, process.env.GOOGLE_APPLICATION_CREDENTIALS);
    credential = admin.credential.cert(JSON.parse(fs.readFileSync(keyPath, "utf8")));
} else {
    console.error("❌ Nincs Firebase credential: állítsd be a FIREBASE_SERVICE_ACCOUNT_JSON vagy GOOGLE_APPLICATION_CREDENTIALS env változót.");
    process.exit(1);
}

admin.initializeApp({
    credential,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "fitnessapp-48d34.firebasestorage.app"
});

const db = admin.firestore();

async function migrate() {
    console.log("▶ userPackages migráció indítása...");

    const snapshot = await db.collection("userPackages").get();

    if (snapshot.empty) {
        console.log("✅ Nincs migrálandó dokumentum.");
        process.exit(0);
    }

    let migratedDocs = 0;
    let migratedPackages = 0;

    for (const doc of snapshot.docs) {
        const guestId = doc.id;
        const data = doc.data();
        const packages = data.packages;

        if (!packages || !Array.isArray(packages) || packages.length === 0) {
            console.log(`  ⏭ ${guestId}: nincs packages array, kihagyva`);
            continue;
        }

        console.log(`  → ${guestId}: ${packages.length} bérlet migrálása...`);

        const batch = db.batch();
        const subcollectionRef = db.collection("userPackages").doc(guestId).collection("packages");

        for (const pkg of packages) {
            const docId = pkg.id || subcollectionRef.doc().id;
            batch.set(subcollectionRef.doc(docId), { ...pkg, id: docId });
        }

        await batch.commit();

        await db.collection("userPackages").doc(guestId).update({
            packages: admin.firestore.FieldValue.delete()
        });

        migratedDocs++;
        migratedPackages += packages.length;
        console.log(`  ✅ ${guestId}: ${packages.length} bérlet sikeresen migrálva`);
    }

    console.log(`\n✅ Migráció kész: ${migratedDocs} vendég, ${migratedPackages} bérlet`);
    process.exit(0);
}

migrate().catch(err => {
    console.error("❌ Migráció sikertelen:", err);
    process.exit(1);
});
