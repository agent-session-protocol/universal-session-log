import './console.css';
import type { Metadata } from 'next';

const consoleUrl = 'https://agent-session-protocol.github.io/universal-session-log/console';
const description =
  'Explore SesDB, the local agent-session database and query engine, with safe interactive session, usage, runtime, storage, and integrity data.';

export const metadata: Metadata = {
  title: 'SesDB Console — Local Agent Session Database',
  description,
  keywords: ['SesDB', 'agent session database', 'coding agent history search', 'SessionQL', 'local agent analytics'],
  alternates: { canonical: consoleUrl },
  openGraph: {
    type: 'website',
    url: consoleUrl,
    title: 'SesDB Console — Local Agent Session Database',
    description,
    images: [{ url: `${consoleUrl.replace('/console', '')}/screenshots/admin/overview-en.png`, alt: 'SesDB Console overview' }],
  },
};

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    '@id': `${consoleUrl}/#software`,
    name: 'SesDB',
    alternateName: 'Session Database',
    description,
    url: consoleUrl,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows',
    isAccessibleForFree: true,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
    codeRepository: 'https://github.com/agent-session-protocol/universal-session-log/tree/main/packages/sesdb',
    isPartOf: { '@id': 'https://agent-session-protocol.github.io/universal-session-log/#software' },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, '\\u003c') }}
      />
      {children}
    </>
  );
}
