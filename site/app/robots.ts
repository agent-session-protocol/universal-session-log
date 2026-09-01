import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/universal-session-log/',
    },
    sitemap: 'https://agent-session-protocol.github.io/universal-session-log/sitemap.xml',
  };
}
