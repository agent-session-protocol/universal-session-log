import { Inter } from 'next/font/google';
import type { Metadata } from 'next';
import { Provider } from '@/components/provider';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

const siteUrl = 'https://agent-session-protocol.github.io/universal-session-log';
const description =
  'USL is a local-first, append-only, crash-recoverable store for complete AI agent sessions, with evidence-preserving capture, query, and cross-harness migration.';

export const metadata: Metadata = {
  metadataBase: new URL(`${siteUrl}/`),
  applicationName: 'Universal Session Log',
  title: {
    default: 'USL — Durable AI Agent Session Storage',
    template: '%s · USL',
  },
  description,
  keywords: [
    'Universal Session Log',
    'USL',
    'AI coding agent session history',
    'agent session database',
    'cross-harness session migration',
    'agent session replay',
    'local agent observability',
    'SesDB',
  ],
  authors: [{ name: 'Agent Session Protocol maintainers', url: 'https://github.com/agent-session-protocol' }],
  creator: 'Agent Session Protocol maintainers',
  publisher: 'Agent Session Protocol',
  category: 'developer tools',
  alternates: {
    canonical: siteUrl,
    types: {
      'text/plain': `${siteUrl}/llms.txt`,
    },
  },
  openGraph: {
    type: 'website',
    url: siteUrl,
    siteName: 'Universal Session Log',
    title: 'USL — Durable AI Agent Session Storage',
    description,
    images: [{ url: `${siteUrl}/screenshots/admin/overview-en.png`, alt: 'SesDB Console over the USL durable session log' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'USL — Durable AI Agent Session Storage',
    description,
    images: [`${siteUrl}/screenshots/admin/overview-en.png`],
  },
  robots: {
    index: true,
    follow: true,
  },
};

const structuredData = [
  {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${siteUrl}/#website`,
    name: 'Universal Session Log',
    alternateName: 'USL',
    description,
    url: siteUrl,
    publisher: { '@id': 'https://agent-session-protocol.github.io/#organization' },
    inLanguage: ['en', 'zh-CN'],
  },
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareSourceCode',
    '@id': `${siteUrl}/#software`,
    name: 'Universal Session Log',
    alternateName: 'USL',
    description,
    url: siteUrl,
    codeRepository: 'https://github.com/agent-session-protocol/universal-session-log',
    license: 'https://opensource.org/license/mit',
    programmingLanguage: ['Rust', 'TypeScript'],
    runtimePlatform: ['Rust', 'Node.js'],
    isPartOf: { '@id': 'https://agent-session-protocol.github.io/#website' },
  },
];

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, '\\u003c') }}
        />
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
