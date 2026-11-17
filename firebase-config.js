// ค่า Firebase ของโปรเจกต์ร้าน (ชงสุดใจ) — ใส่หลังสร้างโปรเจกต์
// ค่าพวกนี้ไม่ใช่ความลับ — ความปลอดภัยมาจาก Firestore Rules (ไฟล์ firestore.rules)
export const firebaseConfig = {
  apiKey: "AIzaSyACvxxO2OQ4mFyG_TzYQnw3-76OEkf19GY",
  authDomain: "jukjik-kaa-4fae.firebaseapp.com",
  projectId: "jukjik-kaa-4fae",
  storageBucket: "jukjik-kaa-4fae.firebasestorage.app",
  messagingSenderId: "919289249687",
  appId: "1:919289249687:web:bdbfdd69e08cbd0aef0ed2"
};

// ผู้ดูแลร้าน: บัญชี Gmail นี้เท่านั้นที่ใช้แอปได้ (ต้องตรงกับ firestore.rules ด้วย)
export const ownerEmail = "tun.supakorn1993@gmail.com";
// ที่เก็บข้อมูลร้าน users/{shopDataUid} (ไม่เปลี่ยนเมื่อเปลี่ยนผู้ดูแล ข้อมูลเดิมจึงอยู่ครบ)
export const shopDataUid = "6aNH4DgIqSfQA9KbOWVcwLc3Jzn1";
export const ownerUid = "";
// true = ใช้ได้เฉพาะเจ้าของร้าน (เฟส 3 จะเพิ่มลูกจ้างพร้อมระบบอนุมัติ)
export const privateApp = true;
export const inviteOnly = false;
// ระบบสั่งผ่าน LINE OA: URL ของ Cloudflare Worker (ได้หลัง deploy โฟลเดอร์ worker/) เช่น https://jukjik-kaa-line.<ชื่อบัญชี>.workers.dev
export const lineApi = "https://jukjik-kaa-line.jukjik-kaa.workers.dev";
// ล็อกอินแอปร้านด้วย LINE: LIFF app ที่ Endpoint URL = หน้าแอปนี้ (ดู README ขั้นที่ 5.4)
export const ownerLiffId = "2012622553-L0dutqep";
// แจ้งเตือนออเดอร์ใหม่ (Web Push): public key ของ VAPID (ไม่ใช่ความลับ · private key อยู่ใน Cloudflare)
export const vapidPublicKey = "BK8FbXvHdOBmlDgHAG9IU5ID_5Qxrsd3NePxDjJM3WZeSJQ8cn-Z3I6KjeS6_EiqtHu-7Sx1K5N6KpWvmPVXqZg";
