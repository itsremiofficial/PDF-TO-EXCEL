import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PDF table → Excel',
  description: 'Extract a table from a PDF and download the columns you pick as an .xlsx.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
