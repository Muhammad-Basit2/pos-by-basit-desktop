import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { initializeAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentSingleTabManager, doc, setDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { showToast, toggleLoader } from "./utils.js";

const firebaseConfig = {
  apiKey: "AIzaSyCk1M2mLQDyT2DoJuGOogjZYKOcGnendsU",
  authDomain: "pos-by-basit.firebaseapp.com",
  projectId: "pos-by-basit",
  storageBucket: "pos-by-basit.firebasestorage.app",
  messagingSenderId: "565421098587",
  appId: "1:565421098587:web:0bc1d69f52f3bab647217e",
  measurementId: "G-QH75X9ZVCL",
};

const app = initializeApp(firebaseConfig);
export const auth = initializeAuth(app, { persistence: browserLocalPersistence });
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
});

export const onAuthenticationChange = (callback) => onAuthStateChanged(auth, callback);

export const initializeAuthHandlers = () => {
document.getElementById("login-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  toggleLoader(true, "Signing in...");
  try {
    const email = document.getElementById("login-email").value;
    const pass = document.getElementById("login-password").value;
    await setPersistence(auth, browserLocalPersistence);
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    toggleLoader(false);
  }
});

document
  .getElementById("register-form")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    toggleLoader(true, "Registering Store...");
    try {
      const name = document.getElementById("reg-name").value;
      const shopName = document.getElementById("reg-shop").value;
      const email = document.getElementById("reg-email").value;
      const pass = document.getElementById("reg-password").value;

      const userCred = await createUserWithEmailAndPassword(auth, email, pass);
      const uid = userCred.user.uid;
      const newBizRef = doc(collection(db, "businesses"));

      await setDoc(newBizRef, {
        shopName,
        ownerName: name,
        phone: "",
        address: "",
        tax: 0,
        createdAt: serverTimestamp(),
      });

      await setDoc(doc(db, "users", uid), {
        uid,
        name,
        email,
        businessId: newBizRef.id,
        role: "Admin",
      });

      showToast("Store setup successful!", "success");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      toggleLoader(false);
    }
  });

document.getElementById("show-register")?.addEventListener("click", () => {
  document.getElementById("login-form")?.classList.add("hidden");
  document.getElementById("register-form")?.classList.remove("hidden");
});

document.getElementById("show-login")?.addEventListener("click", () => {
  document.getElementById("register-form")?.classList.add("hidden");
  document.getElementById("login-form")?.classList.remove("hidden");
});

document
  .getElementById("logout-btn")
  ?.addEventListener("click", () => signOut(auth));

// ==========================================================================
};
