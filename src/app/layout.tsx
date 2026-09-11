import type { Metadata } from "next";
import { Cormorant_Garamond, Lora } from "next/font/google";
import { auth } from "@/auth";
import { getProviderList } from "@/lib/providers/list";
import { Providers } from "./providers";
import "./globals.css";

// Two faces, no sans-serif: Cormorant Garamond for headings and display text,
// Lora for prose and the interface alike. The CSS variables set here are
// consumed by the `--font-heading` / `--font-body` theme keys in globals.css.
// Italic is loaded for both — placeholders and the opening-lines field set in
// Cormorant italic; asides and hints set in Lora italic.
const heading = Cormorant_Garamond({
  variable: "--font-cormorant",
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  subsets: ["latin"],
});

const body = Lora({
  variable: "--font-lora",
  style: ["normal", "italic"],
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
      className={`${heading.variable} ${body.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers session={session} providers={providers}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
