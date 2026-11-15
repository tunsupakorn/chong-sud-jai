// ค่า Firebase ของโปรเจกต์ร้าน (จุกจิกการค้า) — ใส่หลังสร้างโปรเจกต์
// ค่าพวกนี้ไม่ใช่ความลับ — ความปลอดภัยมาจาก Firestore Rules (ไฟล์ firestore.rules)
export const firebaseConfig = {
  apiKey: "AIzaSyACvxxO2OQ4mFyG_TzYQnw3-76OEkf19GY",
  authDomain: "jukjik-kaa-4fae.firebaseapp.com",
  projectId: "jukjik-kaa-4fae",
  storageBucket: "jukjik-kaa-4fae.firebasestorage.app",
  messagingSenderId: "919289249687",
  appId: "1:919289249687:web:bdbfdd69e08cbd0aef0ed2"
};

// เจ้าของร้าน (ใส่ uid หลังล็อกอินครั้งแรก)
export const ownerUid = "";
// true = ใช้ได้เฉพาะเจ้าของร้าน (เฟส 3 จะเพิ่มลูกจ้างพร้อมระบบอนุมัติ)
export const privateApp = true;
export const inviteOnly = false;
