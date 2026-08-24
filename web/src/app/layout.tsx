import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FoodBot Test Chat",
  description: "Internal UI for poking the Bangla restaurant AI agent.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}