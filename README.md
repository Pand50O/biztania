# PromptBridge — AI Concierge prototype

เว็บต้นแบบทำงานร่วมกับ Gemini Flash ผ่านหน้าสั่งการและจุด Human-in-the-Loop 2 จุด:

1. เริ่มจากช่องเป้าหมายขนาดใหญ่กลางหน้า
2. HITL 1: Supervisor สรุปเจตนาและสัมภาษณ์ทีละคำถาม ผู้ใช้ตอบหรือขอคำแนะนำได้หลายรอบจน Supervisor พร้อมสรุปแผน
3. Stepper แสดงสถานะตามขั้นจริง: วิเคราะห์เป้าหมาย → ยืนยันแผน → Worker สร้างผลงาน → Supervisor QA
4. Worker สร้างเว็บไซต์พร้อม preview ใน iframe sandbox หรือสร้างไฟล์ CSV, JSON, Markdown, text และ source code พร้อม preview/ดาวน์โหลด
5. HITL 2: ผู้ใช้สั่งแก้เฉพาะจุดผ่าน Supervisor ซึ่งปรับแผนให้ Worker โดยยังใช้เป้าหมายเดิม หรืออนุมัติและดาวน์โหลด artifact
6. Supervisor QA ตรวจ Draft กับเป้าหมาย/แผน และส่งจุดที่ตกหล่นกลับให้ Worker ปรับได้อีกหนึ่งรอบ

Prototype แสดงความสามารถ AI Concierge ทั้ง 6 ด้านในขอบเขตของ Workspace นี้: Remember เก็บบทสนทนาใน Supabase และ local cache ที่แยกตามบัญชี, Understand สรุปเป้าหมายและถามกลับ, Connect รวมคำขอกับคำตอบ/แผน/Feedback, Retrieve ดึงบริบทจากบทสนทนาที่บันทึกไว้, Reason ทำงานตามแผนที่ผู้ใช้อนุมัติ และ Act สร้าง artifact ที่ preview หรือดาวน์โหลดได้ การ Retrieve ตอนนี้ใช้บริบทใน Workspace; ยังไม่ได้ค้นเอกสารหรือเว็บภายนอก

ขอบเขต artifact ปัจจุบันเป็นไฟล์ข้อความที่ Worker สร้างจากคำสั่ง เช่น HTML, CSV, JSON, Markdown, text และ source code; ระบบยังไม่รัน source code และยังไม่รับไฟล์ CSV จากผู้ใช้เพื่อประมวลผล

## เริ่มใช้งาน

ต้องใช้ Node.js 20 ขึ้นไป และตั้งค่า Gemini API key ใน `.env`:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.8-flash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
```

เก็บ Gemini API key ไว้ฝั่ง server เท่านั้น ห้ามเปลี่ยนชื่อตัวแปรเป็น `NEXT_PUBLIC_*` จากนั้นติดตั้ง dependencies และเปิดเว็บ:

```bash
npm install
npm run dev
```

เปิด `http://localhost:3000` แล้วรัน SQL migration ใน `supabase/migrations/202610070001_create_concierge_conversations.sql` ที่ Supabase SQL Editor จากนั้นตั้ง Google OAuth:

1. สร้าง OAuth Client ID ประเภท Web application ใน Google Cloud แล้วตั้ง Authorized JavaScript origins เป็น `http://localhost:3000` และโดเมน Vercel ของแอป
2. ตั้ง Authorized redirect URI เป็น callback URL ที่ Supabase แสดงให้ใน Authentication → Sign In / Providers → Google โดยทั่วไปเป็น `https://<project-ref>.supabase.co/auth/v1/callback`
3. เปิด Google provider ใน Supabase แล้วนำ Client ID และ Client Secret ไปใส่ในช่องของ Google provider นั้น
4. ใน Supabase Authentication → URL Configuration ตั้ง Site URL เป็นโดเมน production และเพิ่ม `http://localhost:3000/**`, โดเมน production และโดเมน Preview ของ Vercel ใน Redirect URLs

ผู้ใช้ต้องเข้าสู่ระบบด้วย Google ก่อนจึงจะเข้าถึง Workspace ได้ เมื่อกำหนด Supabase URL และ publishable key แล้ว Workspace จะซิงก์บทสนทนาของบัญชีนั้นและเปิดงานเก่ากลับมาคุยต่อได้ แคชใน browser แยกตาม user ID หาก Supabase ยังไม่พร้อม ระบบจะแสดงหน้าตั้งค่า/ข้อผิดพลาดและไม่เปิด Workspace

## เทคโนโลยี

- Next.js App Router และ React
- Gemini Flash ผ่าน Gemini `generateContent` API
- HTML preview แสดงใน iframe ที่ใช้ sandbox
- Supabase Auth ผ่าน Google OAuth และตาราง `concierge_conversations` ที่ป้องกันด้วย Row Level Security
- local storage สำหรับ cache และ fallback เมื่อยังเชื่อม Supabase ไม่ได้

ถ้ายังไม่ได้ตั้ง `GEMINI_API_KEY` เว็บจะแสดงข้อความแจ้งเตือนเมื่อลองเรียก AI และไม่เปิดเผย key ไปยัง browser
