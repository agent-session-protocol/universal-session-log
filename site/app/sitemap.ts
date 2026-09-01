import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

const origin = 'https://agent-session-protocol.github.io';
const lastModified = new Date('2026-09-01T00:00:00Z');
const paths = [
  '/universal-session-log/',
  '/universal-session-log/console',
  '/universal-session-log/docs',
  '/universal-session-log/docs/getting-started',
  '/universal-session-log/docs/architecture',
  '/universal-session-log/docs/storage-format',
  '/universal-session-log/docs/capture',
  '/universal-session-log/docs/conversion',
  '/universal-session-log/docs/query',
  '/universal-session-log/docs/session-log-memory-trace',
  '/universal-session-log/docs/usl-openmemory-native',
  '/universal-session-log/docs/sesdb-local-search',
  '/universal-session-log/docs/search-and-indexing',
  '/universal-session-log/docs/sessionql',
  '/universal-session-log/docs/insights-and-subscriptions',
];

export default function sitemap(): MetadataRoute.Sitemap {
  return paths.map((path) => ({
    url: new URL(path, origin).toString(),
    lastModified,
    changeFrequency: path.includes('/docs') ? 'monthly' : 'weekly',
    priority: path === '/universal-session-log/' ? 1 : 0.7,
  }));
}
