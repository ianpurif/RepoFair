import { ImageResponse } from 'next/og';

export const alt = 'RepoFair — Map your code. Connect the knowledge.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: '100%', height: '100%', padding: 72, background: '#f7f8f7', color: '#26312e', fontFamily: 'sans-serif' }}>
      <div style={{ display: 'flex', fontSize: 34, letterSpacing: -1 }}>RepoFair</div>
      <div style={{ display: 'flex', flexDirection: 'column', fontSize: 78, lineHeight: 1.08, letterSpacing: -3 }}><span>Map your code.</span><span style={{ color: '#33715b' }}>Connect the knowledge.</span></div>
      <div style={{ display: 'flex', fontSize: 25, color: '#64716b' }}>Immutable codebase maps. Original source evidence.</div>
    </div>, size,
  );
}
