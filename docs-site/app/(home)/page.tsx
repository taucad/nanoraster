import Image from 'next/image';
import Link from 'next/link';

import { RenderDemo } from '@/components/render-demo';
import { SizeStrip } from '@/components/size-strip';

import styles from './page.module.css';

const heroExample = `import { renderImage } from 'nanoraster';

const image = await renderImage(glb, {
  format: 'webp',
  quality: 1,
  phi: 60,
  theta: -45,
  margin: 0.1,
  projection: 'perspective',
  up: 'y',
  background: '#101418',
  axes: false,
  scaleBar: false,
});`;

/** Render the nanoraster homepage and its live demo. */
const Page = (): React.JSX.Element => (
  <main className={styles.page}>
    <header className={styles.hero}>
      <div className={styles.heroCopy}>
        <p className={styles.kicker}>GLB → WebP / PNG / JPEG / raw · WebGPU</p>
        <h1>GLB in, image out.</h1>
        <p className={styles.lede}>
          A tiny headless renderer that turns a GLB into PNG, WebP or JPEG bytes, or the raw RGBA frame for a
          diff or a texture. Same request, same pixels, every time. Runs in Node.js and the browser.
        </p>
        <div className={styles.heroActions}>
          <a href="#live-demo">Try the live camera</a>
          <Link href="/docs">Install nanoraster</Link>
        </div>
        <SizeStrip />
      </div>

      <figure className={styles.heroRender}>
        <div className={styles.imageWell}>
          <Image
            alt="Twelve-tooth spur gear with authored edge lines rendered by nanoraster"
            height={1440}
            priority
            src="/demo/helical-gear-pbr.webp"
            unoptimized
            width={1920}
          />
          <span className={styles.fiducialTop} aria-hidden="true" />
          <span className={styles.fiducialBottom} aria-hidden="true" />
        </div>
        <figcaption>
          <span>12-tooth spur gear · metallic 0.72 · roughness 0.22</span>
          <span className={styles.captionFormat}>nanoraster / webp</span>
        </figcaption>
      </figure>
    </header>

    <section aria-labelledby="live-demo-title" className={styles.demoSection} id="live-demo">
      <h2 id="live-demo-title">Try the live camera</h2>
      <p>
        The example below runs in your browser on WebGPU. Move a control and the request re-renders; the same
        call runs unchanged in Node.js.
      </p>
      <RenderDemo code={heroExample} codeBelowControls />
    </section>

    <section className={styles.afterword}>
      <div>
        <p>One render core. Native Metal, Vulkan, and DX12. Browser WebGPU.</p>
        <Link className={styles.afterwordLink} href="/docs">
          Read the docs →
        </Link>
      </div>
    </section>
  </main>
);

export default Page;
