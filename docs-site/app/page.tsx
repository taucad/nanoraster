import Image from 'next/image';
import Link from 'next/link';

import { RenderLab } from '@/components/render-lab';

import styles from './page.module.css';

/** Render the NanoRaster homepage and live capture workbench. */
const Page = (): React.JSX.Element => (
  <main className={styles.page}>
    <nav className={styles.nav} aria-label="Primary navigation">
      <Link className={styles.wordmark} href="/">
        <img alt="" className={styles.mark} src="/logo.svg" />
        nanoraster
      </Link>
      <div>
        <a href="https://github.com/taucad/nanoraster">GitHub</a>
        <Link href="/docs">Documentation</Link>
      </div>
    </nav>

    <header className={styles.hero}>
      <div className={styles.heroCopy}>
        <p className={styles.kicker}>GLB → WebP / PNG / JPEG · WebGPU</p>
        <h1>Render the model. Keep the evidence.</h1>
        <p className={styles.lede}>
          A tiny, headless renderer for agents and CAD pipelines that need a deterministic image of the
          material, edges, and camera they actually submitted.
        </p>
        <div className={styles.heroActions}>
          <a href="#live-demo">Try the live camera</a>
          <Link href="/docs/quick-start">Install nanoraster</Link>
        </div>
        <dl className={styles.specStrip}>
          <div>
            <dt>Material</dt>
            <dd>glTF PBR factors</dd>
          </div>
          <div>
            <dt>Hosts</dt>
            <dd>Browser + Node</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>Owned image bytes</dd>
          </div>
        </dl>
      </div>

      <figure className={styles.heroRender}>
        <div className={styles.imageWell}>
          <Image
            alt="PBR helical gear with authored edge lines rendered by NanoRaster"
            height={720}
            priority
            src="/demo/helical-gear-pbr.webp"
            unoptimized
            width={960}
          />
          <span className={styles.fiducialTop} aria-hidden="true" />
          <span className={styles.fiducialBottom} aria-hidden="true" />
        </div>
        <figcaption>
          <span>Helical gear · metallic 0.50 · roughness 0.25</span>
          <span>NANORASTER / WEBP</span>
        </figcaption>
      </figure>
    </header>

    <section className={styles.demoSection}>
      <RenderLab />
    </section>

    <section className={styles.afterword}>
      <p>One render core. Native Metal, Vulkan, and DX12. Browser WebGPU.</p>
      <Link href="/docs">Read the rendering contract →</Link>
    </section>
  </main>
);

export default Page;
