'use client';

import { useEffect, useId, useRef, useState } from 'react';

import styles from './mermaid.module.css';

/** Track the `dark` class the theme provider puts on the document element. */
const useIsDark = (): boolean => {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const read = (): void => {
      setIsDark(root.classList.contains('dark'));
    };
    read();

    const observer = new MutationObserver(read);
    observer.observe(root, { attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
    };
  }, []);

  return isDark;
};

/**
 * Brand `themeVariables` for mermaid's `base` theme, read off the diagram
 * element so the palette lives in CSS next to the rest of the site's tokens
 * and the `.dark` class picks the variant. Mermaid parses these with khroma,
 * which cannot resolve `var(...)`, hence the computed read.
 */
const themeVariables = (element: HTMLElement): Record<string, string> => {
  const computed = getComputedStyle(element);
  const token = (name: string): string => computed.getPropertyValue(name).trim();
  const ink = token('--mm-ink');
  const inkMuted = token('--mm-ink-muted');
  const accent = token('--mm-accent');

  return {
    fontFamily: 'inherit',
    fontSize: '14px',
    primaryColor: token('--mm-accent-wash'),
    primaryBorderColor: accent,
    primaryTextColor: ink,
    nodeTextColor: ink,
    textColor: ink,
    lineColor: inkMuted,
    clusterBkg: token('--mm-offset'),
    clusterBorder: token('--mm-line'),
    titleColor: inkMuted,
  };
};

/**
 * Render a mermaid diagram from its source.
 *
 * The source stays a ```mermaid fence in the MDX, so the markdown endpoints
 * that agents read keep the diagram verbatim while humans get it drawn. Mermaid
 * is imported lazily, so pages without a diagram never load it.
 */
export const Mermaid = ({ chart }: { readonly chart: string }): React.JSX.Element => {
  const id = useId().replaceAll(':', '');
  const container = useRef<HTMLDivElement>(null);
  const isDark = useIsDark();
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const element = container.current;
    if (!element) return;

    const draw = async (): Promise<void> => {
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: 'inherit',
        themeVariables: themeVariables(element),
        flowchart: { curve: 'basis', nodeSpacing: 28, rankSpacing: 36, padding: 12 },
      });
      const { svg: rendered } = await mermaid.render(`mermaid-${id}`, chart);
      if (!cancelled) setSvg(rendered);
    };

    // A failed import or render falls back to the fence source rather than
    // leaving a blank diagram behind an unhandled rejection.
    draw().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
    // `isDark` is a dependency only: it re-runs the draw so the CSS palette is
    // re-read after a theme switch. The values themselves come from the module.
  }, [chart, id, isDark]);

  if (failed) {
    return <pre className="my-6 overflow-x-auto text-sm">{chart}</pre>;
  }

  return (
    <div
      className={`${styles.diagram} my-6 flex justify-center overflow-x-auto`}
      dangerouslySetInnerHTML={{ __html: svg }}
      ref={container}
    />
  );
};
