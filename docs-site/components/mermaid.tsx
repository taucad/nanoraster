'use client';

import { useEffect, useId, useRef, useState } from 'react';

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

  useEffect(() => {
    let cancelled = false;

    const draw = async (): Promise<void> => {
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: isDark ? 'dark' : 'default',
        fontFamily: 'inherit',
      });
      const { svg: rendered } = await mermaid.render(`mermaid-${id}`, chart);
      if (!cancelled) setSvg(rendered);
    };

    void draw();
    return () => {
      cancelled = true;
    };
  }, [chart, id, isDark]);

  return (
    <div
      className="my-6 flex justify-center overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
      ref={container}
    />
  );
};
