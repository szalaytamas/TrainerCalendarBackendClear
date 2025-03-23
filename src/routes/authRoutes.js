const express = require("express");
const admin = require("firebase-admin");

const router = express.Router();

router.post("/register", async (req, res) => {
  try {
    const { email, password, forename, lastname, termsAccepted  } = req.body;

    if (!forename || !lastname) {
          return res.status(400).json({ error: "Forename and Lastname are required" });
        }

        if (!termsAccepted) {
              return res.status(400).json({ error: "A regisztrációhoz el kell fogadni az adatvédelmi irányelveket és a felhasználási feltételeket." });
            }

    const user = await admin.auth().createUser({
      email,
      password,
      displayName: `${forename} ${lastname}`
    });

    await admin.firestore().collection("users").doc(user.uid).set({
          forename,
          lastname,
          email,
          termsAccepted: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

    res.status(201).json({ uid: user.uid, message: "User registered" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    return res.status(400).json({ error: "Firebase login should be handled on the client side using Firebase Authentication SDK." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/verify", async (req, res) => {
  try {
    const { token } = req.body;
    const decodedToken = await admin.auth().verifyIdToken(token);
    res.json({ uid: decodedToken.uid });
  } catch (error) {
    res.status(401).json({ error: "Invalid token" });
  }
});

router.post("/logout", async (req, res) => {
  try {
    const { token } = req.body;
    const decodedToken = await admin.auth().verifyIdToken(token);

    await admin.auth().revokeRefreshTokens(decodedToken.uid);

    res.status(200).json({ message: "User logged out (tokens revoked)" });
  } catch (error) {
    res.status(500).json({ error: "Failed to revoke token", details: error.message });
  }
});

module.exports = router;
