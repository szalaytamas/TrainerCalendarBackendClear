/**
 * Egyszeri teszt-script: beállít egy `booking` konfigot egy edző user-doksijába,
 * hogy a publikus foglaló oldal (foglalas.trainercalendar.hu/<slug>) tesztelhető
 * legyen az Android app build előtt.
 *
 * Futtatás (a backend-clean-again mappából):
 *   node src/scripts/setTestBooking.js <uid> [slug]
 *
 * Példa:
 *   node src/scripts/setTestBooking.js A93ZSsgrqtQRhFABzBL1kboFcfe2 teszt-edzo
 *
 * A user-doksiban legyen `subscription.manualPro = true` (vagy aktív Pro),
 * különben a backend Pro-gate elrejti az oldalt.
 */

const path = require("path");
const fs = require("fs");
const envPath = path.resolve(__dirname, "../../.env");
require("dotenv").config({ path: envPath, override: true });

const admin = require("firebase-admin");

let credential;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const keyPath = path.resolve(path.dirname(envPath), process.env.GOOGLE_APPLICATION_CREDENTIALS);
  credential = admin.credential.cert(JSON.parse(fs.readFileSync(keyPath, "utf8")));
} else {
  const local = path.resolve(__dirname, "../../fitnessapp-48d34-firebase-adminsdk-fbsvc-9d59facf30.json");
  if (fs.existsSync(local)) {
    credential = admin.credential.cert(JSON.parse(fs.readFileSync(local, "utf8")));
  } else {
    console.error("❌ Nincs Firebase credential (FIREBASE_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS / SA json fájl).");
    process.exit(1);
  }
}

admin.initializeApp({ credential });
const db = admin.firestore();

const uid = process.argv[2];
const slug = (process.argv[3] || "teszt-edzo").toLowerCase();

if (!uid) {
  console.error("Használat: node src/scripts/setTestBooking.js <uid> [slug]");
  process.exit(1);
}

const booking = {
  enabled: true,
  slug,
  displayName: "Teszt Edző",
  bio: "Személyi edzés — teszt foglalási oldal.",
  slotMinutes: 60,
  bufferMinutes: 0,
  minNoticeHours: 12,
  cancelWindowHours: 24,
  maxAdvanceDays: 30,
  autoConfirm: false,
  serviceTypes: [],
  workingHours: {
    mon: [{ start: "09:00", end: "17:00" }],
    tue: [{ start: "09:00", end: "17:00" }],
    wed: [{ start: "09:00", end: "17:00" }],
    thu: [{ start: "09:00", end: "17:00" }],
    fri: [{ start: "09:00", end: "16:00" }],
  },
};

(async () => {
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    console.error(`❌ Nincs ilyen user-doksi: users/${uid}`);
    process.exit(1);
  }
  const data = snap.data();
  const proOk = data.subscription && (data.subscription.manualPro === true || data.subscription.tier === "pro");
  await ref.set({ booking }, { merge: true });

  console.log("✅ booking beállítva a következő doksin:", uid);
  console.log("   slug:", slug);
  console.log("   subscription.manualPro / pro:", proOk ? "OK" : "⚠️ HIÁNYZIK — a Pro-gate elrejti az oldalt");
  console.log("");
  console.log("Teszt URL-ek:");
  console.log(`   backend:  https://trainercalendarbackendclear-0hv5.onrender.com/api/public/t/${slug}`);
  console.log(`   web:      https://trainercalendar-web.vercel.app/${slug}`);
  process.exit(0);
})().catch((e) => {
  console.error("❌ Hiba:", e.message);
  process.exit(1);
});
