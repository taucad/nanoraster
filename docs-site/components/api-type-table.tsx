'use client';

import type { ComponentProps, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import Link from 'fumadocs-core/link';
import type { TypeNode } from 'fumadocs-ui/components/type-table';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from 'fumadocs-ui/components/ui/collapsible';

type ApiTypeTableProps = Omit<ComponentProps<'div'>, 'children'> & {
  readonly caption: string;
  readonly type: Record<string, TypeNode>;
};

type DetailProps = {
  readonly children: ReactNode;
  readonly label: string;
};

const cn = (...classes: Array<false | null | string | undefined>): string =>
  classes.filter(Boolean).join(' ');

const Detail = ({ children, label }: DetailProps): React.JSX.Element => (
  <>
    <dt className="text-xs font-medium uppercase tracking-wide text-fd-muted-foreground">{label}</dt>
    <dd className="min-w-0 not-prose">{children}</dd>
  </>
);

export const ApiTypeTable = ({
  caption,
  className,
  id,
  type,
  ...props
}: ApiTypeTableProps): React.JSX.Element => {
  const names = useMemo(() => Object.keys(type), [type]);
  const [openNames, setOpenNames] = useState<ReadonlySet<string>>(() => new Set());
  const allOpen = names.length > 0 && openNames.size === names.length;

  useEffect(() => {
    if (!id) return;

    const openHashTarget = (): void => {
      const name = names.find((entryName) => window.location.hash === `#${id}-${entryName}`);
      if (!name) return;
      setOpenNames((current) => new Set(current).add(name));
    };

    openHashTarget();
    window.addEventListener('hashchange', openHashTarget);
    return () => {
      window.removeEventListener('hashchange', openHashTarget);
    };
  }, [id, names]);

  const setItemOpen = (name: string, open: boolean): void => {
    const rowId = id ? `${id}-${name}` : undefined;
    setOpenNames((current) => {
      const next = new Set(current);
      if (open) next.add(name);
      else next.delete(name);
      return next;
    });

    if (open && rowId) window.history.replaceState(null, '', `#${rowId}`);
    if (!open && rowId && window.location.hash === `#${rowId}`) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  };

  const toggleAll = (): void => {
    setOpenNames(allOpen ? new Set() : new Set(names));
    if (allOpen && id && window.location.hash.startsWith(`#${id}-`)) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  };

  return (
    <div
      id={id}
      role="group"
      aria-label={caption}
      className={cn(
        '@container my-6 overflow-hidden rounded-2xl border bg-fd-card p-1 text-sm text-fd-card-foreground',
        className,
      )}
      {...props}
    >
      <div className="flex min-h-8 items-center gap-3 px-3 text-xs font-medium text-fd-muted-foreground not-prose">
        <div className="hidden min-w-0 flex-1 grid-cols-[minmax(9rem,1fr)_minmax(12rem,2fr)_auto] gap-4 @xl:grid">
          <span>Property</span>
          <span>Type</span>
          <span>Requirement</span>
        </div>
        <button
          type="button"
          onClick={toggleAll}
          className="ms-auto rounded-md px-2 py-0.5 font-medium text-fd-foreground transition-colors hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring motion-reduce:transition-none"
        >
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      {Object.entries(type).map(([name, field]) => {
        const rowId = id ? `${id}-${name}` : undefined;
        const open = openNames.has(name);
        const fullType = field.typeDescription ?? field.type;
        const requirement = field.deprecated ? 'Deprecated' : field.required ? 'Required' : 'Optional';

        return (
          <Collapsible
            id={rowId}
            key={name}
            open={open}
            onOpenChange={(nextOpen) => {
              setItemOpen(name, nextOpen);
            }}
            className={cn(
              'scroll-m-20 overflow-hidden rounded-xl border transition-[background-color,border-color,box-shadow,margin] motion-reduce:transition-none',
              open
                ? 'mb-1 border-fd-border bg-fd-background shadow-sm last:mb-0'
                : 'border-transparent hover:border-fd-border/70',
            )}
          >
            <CollapsibleTrigger className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-xl px-3 py-1.5 text-start not-prose transition-colors hover:bg-fd-accent/70 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fd-ring motion-reduce:transition-none @xl:grid-cols-[minmax(9rem,1fr)_minmax(12rem,2fr)_auto_1.25rem] @xl:gap-4">
              <div className="flex min-w-0 items-center gap-2 @xl:col-start-1 @xl:row-start-1">
                <code
                  className={cn(
                    'truncate font-mono font-semibold leading-4 text-fd-primary',
                    field.deprecated && 'line-through opacity-60',
                  )}
                >
                  {name}
                </code>
                <span
                  className={cn(
                    'shrink-0 rounded-full border px-1.5 py-0.5 text-[0.625rem] font-medium leading-none @xl:hidden',
                    field.required
                      ? 'border-fd-primary/25 bg-fd-primary/10 text-fd-primary'
                      : 'text-fd-muted-foreground',
                  )}
                >
                  {requirement}
                </span>
              </div>

              <div className="col-span-2 min-w-0 overflow-x-auto whitespace-nowrap pb-0.5 font-mono text-xs leading-4 fd-scroll-container @xl:col-span-1 @xl:col-start-2 @xl:row-start-1 @xl:pb-0">
                {fullType}
              </div>

              <span
                className={cn(
                  'hidden w-fit shrink-0 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium leading-none @xl:inline-flex @xl:col-start-3 @xl:row-start-1',
                  field.required
                    ? 'border-fd-primary/25 bg-fd-primary/10 text-fd-primary'
                    : 'text-fd-muted-foreground',
                )}
              >
                {requirement}
              </span>

              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="none"
                className="col-start-2 row-start-1 size-4 text-fd-muted-foreground transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none @xl:col-start-4"
              >
                <path d="m5.5 7.5 4.5 4.5 4.5-4.5" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </CollapsibleTrigger>

            <CollapsibleContent>
              <div className="border-t px-3 py-2.5">
                {field.description && (
                  <div className="prose prose-no-margin mb-2 text-sm empty:hidden">{field.description}</div>
                )}

                {(field.default != null ||
                  field.typeDescriptionLink ||
                  field.parameters?.length ||
                  field.returns) && (
                  <dl className="grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] items-center gap-x-4 gap-y-2 border-t pt-2 not-prose">
                    {field.typeDescriptionLink && (
                      <Detail label="Reference">
                        <Link href={field.typeDescriptionLink} className="font-mono text-xs underline">
                          {fullType}
                        </Link>
                      </Detail>
                    )}
                    {field.default != null && <Detail label="Default">{field.default}</Detail>}
                    {field.parameters && field.parameters.length > 0 && (
                      <Detail label="Parameters">
                        <div className="flex flex-col gap-2">
                          {field.parameters.map((parameter) => (
                            <div key={parameter.name} className="flex flex-wrap items-baseline gap-1">
                              <code className="font-medium">{parameter.name}</code>
                              <span aria-hidden="true" className="text-fd-muted-foreground">
                                —
                              </span>
                              <div className="prose prose-no-margin text-sm">{parameter.description}</div>
                            </div>
                          ))}
                        </div>
                      </Detail>
                    )}
                    {field.returns && (
                      <Detail label="Returns">
                        <div className="prose prose-no-margin text-sm">{field.returns}</div>
                      </Detail>
                    )}
                  </dl>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
};
