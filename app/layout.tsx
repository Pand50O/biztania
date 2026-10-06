import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PromptBridge — AI Concierge",
  description: "พื้นที่ทำงานร่วมกับ AI Supervisor และ Worker พร้อมการอนุมัติจากผู้ใช้",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="th"><body>{children}</body></html>;
}
