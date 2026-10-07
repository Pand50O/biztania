import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aide — AI Concierge",
  description: "พื้นที่ทำงานร่วมกับ Aide และ Worker พร้อมการอนุมัติจากผู้ใช้",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="th"><body>{children}</body></html>;
}
