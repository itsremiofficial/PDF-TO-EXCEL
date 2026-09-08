import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Report Formatter · PDF to Excel',
  description: 'Convert installer payment reports into a consistent seven-column Excel workbook.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
