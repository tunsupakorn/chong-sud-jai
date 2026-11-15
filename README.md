# 🐣 จุกจิก JukJik

แอปจดรายรับรายจ่ายส่วนตัว อ่านสลิปและใบแจ้งยอดบัตรเครดิตด้วย Gemini ซิงก์ทุกเครื่องด้วย Firebase
ไม่ต้องติดตั้งอะไรบนคอม ไม่ต้องผ่าน App Store — เปิดผ่านเว็บแล้ว "เพิ่มไปยังหน้าจอโฮม" ใช้ได้เหมือนแอปจริง

| ฟีเจอร์ | |
|---|---|
| จดเอง (เงินสด/โอน/บัตร) | ✅ |
| อ่านสลิปทุกธนาคาร เลือกหลายรูปพร้อมกัน กันบันทึกซ้ำ | ✅ |
| อ่านใบแจ้งยอดบัตรเครดิต PDF (แยกดอกเบี้ย/เงินคืน) | ✅ |
| สรุปรายวัน/รายเดือน/ตามหมวด/ช่องทาง | ✅ |
| งบรายเดือน + บอกว่าใช้ได้วันละเท่าไหร่ | ✅ |
| ซิงก์มือถือ/แท็บเล็ตทุกเครื่อง ใช้ออฟไลน์ได้ | ✅ (ต้องตั้งค่า Firebase) |
| สำรอง JSON / ส่งออก CSV (เปิดใน Excel ได้) | ✅ |
| โหมดมืด | ✅ |

---

## ขั้นที่ 1 — เอาขึ้น GitHub Pages (ได้ลิงก์ใช้งาน)

1. ไปที่ github.com › ปุ่ม **New** (สร้าง repository) › ตั้งชื่อ `jukjik` › เลือก **Public** › Create
2. ในหน้า repo กด **uploading an existing file** › ลากไฟล์ทั้งหมดในโฟลเดอร์นี้ (รวมโฟลเดอร์ `icons`) ใส่ › **Commit changes**
3. ไปที่ **Settings › Pages** › Source: **Deploy from a branch** › Branch: `main` / `(root)` › Save
4. รอ 1–2 นาที จะได้ลิงก์ `https://<ชื่อผู้ใช้>.github.io/jukjik/`
5. เปิดลิงก์บนมือถือ
   - **iPhone/iPad:** Safari › ปุ่มแชร์ › *เพิ่มไปยังหน้าจอโฮม*
   - **Android:** Chrome › ⋮ › *ติดตั้งแอป*

> ถึงตรงนี้ใช้งานได้แล้ว แต่ข้อมูลจะอยู่ในเครื่องใครเครื่องมัน ทำขั้นที่ 3 เพื่อซิงก์

## ขั้นที่ 2 — Gemini API key (สำหรับอ่านสลิป, ฟรี)

1. เข้า **aistudio.google.com/apikey** ด้วยบัญชี Google › **Create API key**
2. คัดลอก key › ในแอปไปที่ **ตั้งค่า › Gemini** › วาง › กด **ทดสอบ key**
3. ทำซ้ำในแต่ละเครื่อง (key เก็บในเครื่องเท่านั้น ไม่ขึ้น GitHub)

> แพ็กเกจ Gemini Pro ที่จ่ายรายเดือนใช้ในแชท ส่วนแอปใช้ API key แยก ซึ่งมีโควตาฟรีพอสำหรับใช้ส่วนตัว
> ค่าเริ่มต้นคือรุ่น **Flash-Lite** (`gemini-3.8-flash-lite`) เร็วและเบา ถ้าชื่อรุ่นนี้ไม่มีใน key ของคุณ
> หรือ Google เลิกใช้ แอปจะหารุ่นที่ใช้ได้แล้วเปลี่ยนให้อัตโนมัติ
> หรือเปลี่ยนเองได้ในตั้งค่า โดยดูชื่อรุ่นจากหน้า AI Studio

## ขั้นที่ 3 — Firebase (ซิงก์ทุกเครื่อง, ฟรี)

1. เข้า **console.firebase.google.com** › **Create a project** › ตั้งชื่อ `jukjik` (ปิด Google Analytics ได้)
2. **Build › Authentication › Get started** › แท็บ Sign-in method › เปิด **Email/Password** และ **Google**
3. Authentication › **Settings › Authorized domains** › Add domain › ใส่ `<ชื่อผู้ใช้>.github.io`
4. **Build › Firestore Database › Create database** › เลือก location `asia-southeast1` (สิงคโปร์) › Production mode
5. แท็บ **Rules** › ลบของเดิม แล้ววางเนื้อหาจากไฟล์ `firestore.rules` › **Publish**
   (กฎนี้ทำให้แต่ละบัญชีเห็นเฉพาะข้อมูลของตัวเอง)
6. ⚙️ **Project settings › General › Your apps** › กดไอคอน `</>` (Web) › ตั้งชื่อ › Register
   จะได้ก้อน `firebaseConfig = { apiKey: ..., ... }`
7. เอาไปใส่ได้ 2 แบบ:
   - **แนะนำ:** แก้ไฟล์ `firebase-config.js` บน GitHub (กดรูปดินสอ) เปลี่ยน `null` เป็นก้อน config นั้น › Commit
     → ทุกเครื่องได้ค่าอัตโนมัติ
   - หรือวางในแอป: ตั้งค่า › บัญชีและการซิงก์ › *วางค่า Firebase config* (ต้องวางทุกเครื่อง)
8. ในแอป › ตั้งค่า › **สมัครบัญชีใหม่** ด้วยอีเมล (หรือ Google) › เครื่องอื่นแค่ **เข้าสู่ระบบ** บัญชีเดียวกัน
   ถ้ามีรายการที่จดไว้ก่อนล็อกอิน แอปจะถามว่าจะอัปขึ้นบัญชีไหม

> ค่าใน firebase-config.js ไม่ใช่รหัสลับ เปิดเผยบน GitHub ได้ ความปลอดภัยมาจาก Rules ในข้อ 5
> หมายเหตุ iPhone: ถ้า "เข้าสู่ระบบด้วย Google" ไม่ขึ้นตอนเปิดจากหน้าจอโฮม ให้ใช้อีเมล/รหัสผ่านแทน

## ขั้นที่ 4 — Google Sheet (สำเนาข้อมูลไว้ดู, ไม่บังคับ)

Firebase ยังเป็นที่เก็บหลัก ส่วน Google Sheet เป็นสำเนาที่อัปเดตอัตโนมัติ ไว้ดู ทำสูตร หรือทำกราฟ
โค้ดสคริปต์อยู่ในโฟลเดอร์ `apps-script/`

1. สร้าง Sheet และสคริปต์ด้วย [clasp](https://github.com/google/clasp):
   `npx @google/clasp login` แล้ว `npx @google/clasp create-script --type sheets --title "จุกจิก JukJik" --rootDir apps-script`
   (ถ้า clasp เขียนทับ `apps-script/appsscript.json` ให้คืนค่าไฟล์จาก git ก่อน)
2. `npx @google/clasp push --force` แล้ว `npx @google/clasp create-deployment` จะได้ deployment id
3. เปิดหน้าแก้ไขสคริปต์ เลือกฟังก์ชัน `setup` แล้วกด **เรียกใช้** จากนั้นกด **อนุญาต** สิทธิ์
4. ลิงก์ web app คือ `https://script.google.com/macros/s/<deployment id>/exec` วางในแอปที่ **ตั้งค่า › 📗 Google Sheet** แล้วกด **เชื่อมต่อ**
5. แก้โค้ดสคริปต์ภายหลัง: `clasp push --force` แล้ว `clasp update-deployment <deployment id>` (ลิงก์เดิมใช้ต่อได้)

> ไม่ต้องเอาลิงก์ web app ไปไว้ใน GitHub แอปจะจับคู่กับสคริปต์ด้วยรหัสลับตอนกดเชื่อมต่อครั้งแรก
> ถ้าต้องการจับคู่ใหม่ ให้รันฟังก์ชัน `resetPairing` ในหน้าแก้ไขสคริปต์

## ขั้นที่ 5 — สั่งผ่าน LINE OA (ไม่บังคับ)

ลูกค้าแอดไลน์ร้าน › กดเมนูด้านล่างแชท › เลือกน้ำ › เลือก **รับเลย** หรือ **นัดเวลารับ** › จ่าย **พร้อมเพย์** (QR ยอดพอดี) หรือ **เงินสดตอนรับ**
ออเดอร์เด้งเข้าแอปที่ 🛒 ขาย › **ออเดอร์ LINE** พร้อมเสียงเตือน กด *รับออเดอร์ › ทำเสร็จ (LINE แจ้งลูกค้าเอง) › รับเงิน/ส่งมอบ*
ส่งมอบแล้วยอดขายลงบัญชีอัตโนมัติ (นับในรายงานหน้าขาย ปิดยอด และ Google Sheet เหมือนบิลหน้าร้าน)

```
ลูกค้า LINE ── LIFF (liff/ บน GitHub Pages) ──┐
LINE Platform ── webhook ─────────────────────┼──► Cloudflare Worker (worker/, ฟรี) ──► Firestore ◄── แอป POS อ่านออเดอร์สด
แอป POS ── กดปุ่มรับ/เสร็จ/รับเงิน ────────────┘        └──► LINE push "น้ำพร้อมแล้ว"
```
ใช้ Firebase แผนฟรี (Spark) ต่อได้ ไม่ต้องผูกบัตร

### 5.1 สร้างบัญชี LINE
1. **manager.line.biz** › สร้าง LINE Official Account ของร้าน
2. ตั้งค่า › **Messaging API** › เปิดใช้งาน (สร้าง Provider ใหม่ชื่อร้าน)
3. **developers.line.biz** › เลือก Provider › channel Messaging API:
   - แท็บ Basic settings: คัดลอก **Channel secret**
   - คัดลอก **Channel ID** ด้วย (Worker ออก access token อายุสั้นเองจาก ID + secret ไม่ต้อง issue long-lived token)
4. Provider เดียวกัน › **Create a new channel › LINE Login** (ประเภท Web app) › คัดลอก **Channel ID**
5. ใน LINE Login channel › แท็บ **LIFF** › Add:
   - Size: **Full** · Endpoint URL: `https://tunsupakorn.github.io/jukjik-kaa/liff/index.html`
   - Scopes: `openid`, `profile`, `chat_message.write` · Bot link feature: **On (Aggressive)** แล้วเลือกบัญชี OA ของร้าน
   - คัดลอก **LIFF ID** (เช่น `2001234567-AbCdEfGh`)

### 5.2 Deploy Cloudflare Worker (ฟรี ไม่ต้องผูกบัตร)
1. สมัคร **dash.cloudflare.com** (อีเมลอย่างเดียว) › Workers & Pages › เลือกชื่อ subdomain `*.workers.dev`
2. **Service account ของ Firebase:** Firebase Console › ⚙️ Project settings › **Service accounts** › **Generate new private key** › ได้ไฟล์ JSON
   (ไฟล์นี้คือกุญแจเข้าฐานข้อมูล **ห้าม** commit หรือส่งในแชท)
3. บนคอม: `cd worker && npm install && npm test` › `npx wrangler login` › `npx wrangler deploy`
   จะได้ URL เช่น `https://jukjik-kaa-line.<ชื่อบัญชี>.workers.dev`
4. ใส่ค่าลับ 2 ตัว (Cloudflare dashboard › Worker › Settings › **Variables and Secrets** › Add › Type: Secret หรือใช้คำสั่ง):
   - `LINE_CHANNEL_SECRET` = Channel secret ของ Messaging API channel: `npx wrangler secret put LINE_CHANNEL_SECRET`
   - `FIREBASE_SERVICE_ACCOUNT` = เนื้อหาไฟล์ JSON ทั้งไฟล์: `npx wrangler secret put FIREBASE_SERVICE_ACCOUNT < ไฟล์.json`
5. ใส่ URL ของ Worker:
   - `liff/config.js` › `API_BASE` และ `LIFF_ID`
   - `firebase-config.js` › `lineApi`
   - `worker/wrangler.toml` › `LIFF_ID` แล้ว `npx wrangler deploy` อีกครั้ง
6. Messaging API channel › **Webhook URL** = `<URL ของ Worker>/webhook` › Verify › เปิด **Use webhook**
7. commit ขึ้น GitHub

ค่าที่ไม่ใช่ความลับ (Channel ID, อีเมลเจ้าของร้าน, project id) อยู่ใน `worker/wrangler.toml`
แผนฟรีของ Workers ใช้ได้วันละ 100,000 request เกินแล้วแค่หยุดทำงานถึงวันถัดไป ไม่มีบิล

### 5.3 ตั้งค่า OA
- LINE OA Manager › ตอบกลับอัตโนมัติ: **ปิด** "ข้อความตอบกลับอัตโนมัติ" (บอทตอบเอง) แต่เปิด **แชท** ไว้ได้ เจ้าของยังคุยกับลูกค้าเองได้
- **Rich menu** (เมนูด้านล่างแชท) › สร้างปุ่ม: 🥤 สั่งน้ำ = ลิงก์ `https://liff.line.me/<LIFF ID>` · 🧾 คิวของฉัน = ข้อความ `คิว` · ⭐ แต้มสะสม = ข้อความ `แต้ม`
- ในแอป › ⚙️ ตั้งค่า › **💚 สั่งผ่าน LINE OA** › ตั้งเวลาเปิด–ปิด เวลาทำ › **เปิดรับออเดอร์**
- ตั้ง **พร้อมเพย์ร้าน** ไว้ด้วย ลูกค้าถึงเลือกโอนได้

### 5.4 ล็อกอินแอปร้านด้วย LINE (แทน Gmail)
1. LINE Login channel › แท็บ LIFF › **Add** แอปที่ 2: ชื่อ `แอปร้าน` · Size **Full** · Endpoint URL `https://tunsupakorn.github.io/jukjik-kaa/`
   · Scopes **openid**, **profile** · Add friend option **Off** › ใส่ LIFF ID ที่ได้ใน `firebase-config.js` › `ownerLiffId`
2. Firebase Console › Firestore › **Rules** › วางเนื้อหา `firestore.rules` ใหม่ › **Publish** (เพิ่มสิทธิ์ให้บัญชี LINE ของร้าน)
3. เปิดแอป › **💬 เข้าสู่ระบบด้วย LINE** ครั้งแรกจะขึ้นรหัส LINE (`U…`) › ใส่ใน `worker/wrangler.toml` › `OWNER_LINE_IDS`
   (คั่นด้วย , ได้หลายคน) › `npx wrangler deploy` › กดเข้าสู่ระบบด้วย LINE อีกครั้ง
4. Gmail ของเจ้าของร้านยังใช้ได้เหมือนเดิม

### สิ่งที่ควรรู้
- **โควตาข้อความ:** แผนฟรีของ LINE OA ส่ง push ได้จำกัดต่อเดือน (เช็กแพ็กเกจปัจจุบันใน OA Manager) ระบบใช้ push แค่ตอน *น้ำพร้อม* และ *ร้านยกเลิก*
  ส่วนยืนยันออเดอร์ใช้ reply (ฟรี) และหน้า LIFF อัปเดตสถานะคิวเอง ถ้าออเดอร์เยอะจนเกินโควตา ให้อัปแพ็กเกจ OA
- **เช็กเงินโอน:** พร้อมเพย์บัญชีบุคคลไม่มีระบบแจ้งเงินเข้า ลูกค้ากด "โอนแล้ว" แล้วร้านเช็กในแอปธนาคารก่อนกด **✓ เงินเข้าแล้ว**
- ลูกค้ามีออเดอร์ค้างได้ไม่เกิน 2 รายการ และนัดรับได้เฉพาะวันนี้ในเวลาเปิดร้าน ราคาคิดใหม่ที่เซิร์ฟเวอร์จากเมนูร้านทุกครั้ง (ลูกค้าไม่เห็นต้นทุน)
- คีย์เวิร์ดที่บอทตอบ: `เมนู`/`สั่ง` · `คิว`/`สถานะ` · `แต้ม` ข้อความอื่นปล่อยให้ร้านตอบเองในแชท

---

## ไฟล์ในโปรเจกต์

| ไฟล์ | หน้าที่ |
|---|---|
| `index.html` | หน้าหลักของแอป |
| `guide.html` | คู่มือวิธีใช้งานและวิธีติดตั้ง |
| `styles.css` | ธีมสีเหลืองลูกเจี๊ยบ + โหมดมืด |
| `app.js` | หน้าจอทั้งหมด (หน้าหลัก, สรุป, อ่านสลิป, ตั้งค่า) |
| `store.js` | เก็บข้อมูลในเครื่อง / ซิงก์ Firebase |
| `gemini.js` | ส่งสลิป/PDF ให้ Gemini อ่าน |
| `charts.js` | กราฟรายวันและแยกหมวด |
| `sheets.js` | ส่งสำเนาข้อมูลลง Google Sheet |
| `qr.js` | อ่าน QR บนสลิปในเครื่อง (เลขอ้างอิงธนาคาร กันสลิปซ้ำ) |
| `apps-script/` | สคริปต์ฝั่ง Google Sheet (Apps Script) |
| `liff/` | หน้าสั่งน้ำใน LINE (LIFF) ของลูกค้า |
| `worker/` | Cloudflare Worker: API ของหน้า LIFF, LINE webhook, ปุ่มจัดการออเดอร์ของร้าน (แจ้งลูกค้า/บันทึกยอดขาย) |
| `firebase-config.js` | ค่า Firebase ของคุณ |
| `firestore.rules` | กฎความปลอดภัยฐานข้อมูล |
| `sw.js`, `manifest.webmanifest`, `icons/` | ทำให้ติดตั้งเป็นแอปและใช้ออฟไลน์ได้ |

## อัปเดตแอปภายหลัง
แก้ไฟล์บน GitHub แล้ว Commit — ภายในไม่กี่นาทีทุกเครื่องจะได้เวอร์ชันใหม่ (ปิดแล้วเปิดแอปใหม่)
