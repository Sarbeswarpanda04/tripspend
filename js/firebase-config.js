/* ============================================================
   Firebase initialisation (compat build → shared globals).
   These globals (auth, db, googleProvider) are used by
   store.js and app.js, which are plain classic scripts.

   This app keeps all user data in Firebase Firestore; there is no
   browser-local database or localStorage fallback for trip data.
   ============================================================ */
const firebaseConfig = {
  apiKey: "AIzaSyBPhwmUiPE6NfbS_NxwaK2bkN7zJ_DNvNg",
  authDomain: "trip-spend-app.firebaseapp.com",
  projectId: "trip-spend-app",
  storageBucket: "trip-spend-app.firebasestorage.app",
  messagingSenderId: "1036512430676",
  appId: "1:1036512430676:web:e3fa9616bdc090a05abbc1",
  measurementId: "G-Y9CNZY2K51"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

/* Firebase Auth uses persistent browser storage by default. */

const googleProvider = new firebase.auth.GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });
