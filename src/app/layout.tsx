import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rental Manager v2",
  description: "Two-account Hygglo bot — READ-ONLY safety rail active.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
