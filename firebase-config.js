// ค่า Firebase ของโปรเจกต์ร้าน (จุกจิกการค้า) — ใส่หลังสร้างโปรเจกต์
// ค่าพวกนี้ไม่ใช่ความลับ — ความปลอดภัยมาจาก Firestore Rules (ไฟล์ firestore.rules)
export const firebaseConfig = null;

// เจ้าของร้าน (ใส่ uid หลังล็อกอินครั้งแรก)
export const ownerUid = "";
// true = ใช้ได้เฉพาะเจ้าของร้าน (เฟส 3 จะเพิ่มลูกจ้างพร้อมระบบอนุมัติ)
export const privateApp = true;
export const inviteOnly = false;
