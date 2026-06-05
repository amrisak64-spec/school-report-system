// Firebase Configuration - Prabha Gyan Jyoti Public School
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBvi2Px_kwKzzDWM0p1uGb9YKtPrZoEebY",
 authDomain: "prabhagyanjyoti.firebaseapp.com",
projectId: "prabhagyanjyoti",
  storageBucket: "prabhagyanJyoti.firebasestorage.app",
  messagingSenderId: "167332170512",
  appId: "1:167332170512:web:92fe5e1653654adcc4b395"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
