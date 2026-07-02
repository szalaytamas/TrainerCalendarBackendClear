/**
 * Admin script: teljes felhasználó törlés GDPR-kompatibilis módon.
 *
 * Használat:
 *   node src/scripts/deleteUser.js <userId>           -- éles törlés
 *   node src/scripts/deleteUser.js <userId> --dry-run -- csak listázza, nem töröl
 *
 * Futtatás helye: backend-clean-again/
 * Előfeltétel: .env fájl (FIREBASE_SERVICE_ACCOUNT_JSON + FIREBASE_STORAGE_BUCKET)
 */

const admin = require("firebase-admin");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const userId = process.argv[2];
const isDryRun = process.argv.includes("--dry-run");

if (!userId) {
  console.error("Használat: node src/scripts/deleteUser.js <userId> [--dry-run]");
  process.exit(1);
}

const credential = admin.credential.cert(
  JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
);
admin.initializeApp({
  credential,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "fitnessapp-48d34.firebasestorage.app",
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

const MODE = isDryRun ? "[DRY-RUN]" : "[TÖRLÉS]";

async function deleteStorageFolder(prefix) {
  const [files] = await bucket.getFiles({ prefix });
  if (files.length === 0) return 0;
  console.log(`  ${MODE} Storage: ${files.length} fájl törlése (${prefix})`);
  if (!isDryRun) {
    await Promise.all(files.map(f => f.delete().catch(() => {})));
  }
  return files.length;
}

async function deleteCollectionDocs(docs, label) {
  if (docs.length === 0) {
    console.log(`  Nincs adat: ${label}`);
    return;
  }
  console.log(`  ${MODE} ${label}: ${docs.length} dokumentum`);
  if (!isDryRun) {
    const BATCH_SIZE = 400;
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = db.batch();
      docs.slice(i, i + BATCH_SIZE).forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
  }
}

async function run() {
  console.log("\n========================================");
  console.log(`Felhasználó törlés: ${userId}`);
  console.log(isDryRun ? "MÓD: DRY-RUN (nem töröl semmit)" : "MÓD: ÉLES TÖRLÉS");
  console.log("========================================\n");

  // 1. Vendégek lekérése (szükséges a többi törléshez)
  console.log("1. Vendégek lekérése...");
  const guestsSnap = await db.collection("guests").where("user_id", "==", userId).get();
  const guestDocs = guestsSnap.docs;
  const guestIds = guestDocs.map(d => d.id);
  console.log(`  Talált vendég: ${guestIds.length} db`);

  // 2. Storage: vendég profilképek törlése
  console.log("\n2. Storage fájlok törlése...");
  let totalStorageFiles = 0;
  for (const guestId of guestIds) {
    const count = await deleteStorageFolder(`guests/${guestId}/`);
    totalStorageFiles += count;
  }
  if (guestIds.length === 0) console.log("  Nincs vendég, nincs Storage fájl.");
  else console.log(`  Összesen ${totalStorageFiles} Storage fájl.`);

  // 3. userPackages subcollection törlése minden vendégnél
  console.log("\n3. Vendég bérletek (userPackages) törlése...");
  let totalUserPackages = 0;
  for (const guestId of guestIds) {
    const pkgSnap = await db.collection("userPackages").doc(guestId).collection("packages").get();
    if (!pkgSnap.empty) {
      console.log(`  ${MODE} userPackages/${guestId}/packages: ${pkgSnap.size} db`);
      if (!isDryRun) {
        const batch = db.batch();
        pkgSnap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        await db.collection("userPackages").doc(guestId).delete().catch(() => {});
      }
      totalUserPackages += pkgSnap.size;
    }
  }
  if (totalUserPackages === 0) console.log("  Nincs vendégbérlet.");

  // 4. Vendégek törlése
  console.log("\n4. Vendégek törlése...");
  await deleteCollectionDocs(guestDocs, "guests");

  // 5. Időpontok törlése
  console.log("\n5. Időpontok törlése...");
  const appSnap = await db.collection("appointments").where("user_id", "==", userId).get();
  await deleteCollectionDocs(appSnap.docs, "appointments");

  // 6. Edzéstervek törlése
  console.log("\n6. Edzéstervek törlése...");
  const planSnap = await db.collection("exercisePlans").where("user_id", "==", userId).get();
  await deleteCollectionDocs(planSnap.docs, "exercisePlans");

  // 7. Felhasználó saját bérletsablonjai törlése (packages ahol ownerId === userId)
  console.log("\n7. Saját bérletsablonok törlése...");
  const ownedPkgSnap = await db.collection("packages").where("ownerId", "==", userId).get();
  await deleteCollectionDocs(ownedPkgSnap.docs, "packages (ownerId)");

  // 8. Felhasználó Firestore profil törlése
  console.log("\n8. Felhasználó Firestore profil törlése...");
  const userRef = db.collection("users").doc(userId);
  const userDoc = await userRef.get();
  if (userDoc.exists) {
    console.log(`  ${MODE} users/${userId} (${userDoc.data().email || "ismeretlen email"})`);
    if (!isDryRun) await userRef.delete();
  } else {
    console.log(`  Nem található: users/${userId}`);
  }

  // 9. Firebase Auth törlése
  console.log("\n9. Firebase Auth fiók törlése...");
  try {
    const authUser = await admin.auth().getUser(userId);
    console.log(`  ${MODE} Auth fiók: ${authUser.email}`);
    if (!isDryRun) await admin.auth().deleteUser(userId);
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      console.log("  Nem található Auth fiók (már törölve vagy soha nem létezett).");
    } else {
      throw e;
    }
  }

  // Összefoglaló
  console.log("\n========================================");
  if (isDryRun) {
    console.log("DRY-RUN KÉSZ — semmi sem törlődött.");
    console.log("Éles törléshez futtasd --dry-run nélkül.");
  } else {
    console.log("TÖRLÉS KÉSZ — minden adat törölve.");
  }
  console.log("  Vendégek:       ", guestIds.length);
  console.log("  Storage fájlok: ", totalStorageFiles);
  console.log("  Vendégbérletek: ", totalUserPackages);
  console.log("  Időpontok:      ", appSnap.size);
  console.log("  Edzéstervek:    ", planSnap.size);
  console.log("  Bérletsablonok: ", ownedPkgSnap.size);
  console.log("========================================\n");
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("\nHIBA:", err.message);
    process.exit(1);
  });
