import type { Metadata } from "next";
import { Geist, Geist_Mono, Lora } from "next/font/google";
import { auth } from "@/auth";
import { getProviderList } from "@/lib/providers/list";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const storySerif = Lora({
  variable: "--font-story-serif",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Fabula — co-write a story with AI",
  description:
    "Start a short story with a spark of your own, or none at all, and take turns writing it with an AI.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const providers = getProviderList();
  const session = await auth();
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${storySerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers session={session} providers={providers}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
