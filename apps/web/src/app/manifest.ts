import type { MetadataRoute } from 'next';
import { SITE_DESCRIPTION, SITE_NAME } from '../lib/site-metadata';
export default function manifest(): MetadataRoute.Manifest {
  return { name: SITE_NAME, short_name: SITE_NAME, description: SITE_DESCRIPTION, lang: 'en', start_url: '/', display: 'minimal-ui', background_color: '#f7f8f7', theme_color: '#33715b', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] };
}
