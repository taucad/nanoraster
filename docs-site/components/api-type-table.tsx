import type { ComponentProps } from 'react';
import type { TypeNode } from 'fumadocs-ui/components/type-table';

type ApiTypeTableProps = Omit<ComponentProps<'div'>, 'children'> & {
  readonly caption: string;
  readonly type: Record<string, TypeNode>;
};

export const ApiTypeTable = ({ caption, className, id, type, ...props }: ApiTypeTableProps) => (
  <div
    className={`my-6 overflow-x-auto rounded-xl border bg-fd-card text-fd-card-foreground ${className ?? ''}`}
    {...props}
  >
    <table id={id} className="w-full min-w-[42rem] border-collapse text-left text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="border-b bg-fd-muted/40 text-fd-muted-foreground">
        <tr>
          <th scope="col" className="w-1/5 px-4 py-3 font-medium">
            Property
          </th>
          <th scope="col" className="w-2/5 px-4 py-3 font-medium">
            Type
          </th>
          <th scope="col" className="w-24 px-4 py-3 font-medium">
            Requirement
          </th>
          <th scope="col" className="px-4 py-3 font-medium">
            Description
          </th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {Object.entries(type).map(([name, field]) => {
          const rowId = id ? `${id}-${name}` : undefined;
          const fullType = field.typeDescription ?? field.type;
          return (
            <tr id={rowId} key={name} className="scroll-m-20 align-top">
              <th scope="row" className="px-4 py-3 font-mono font-medium text-fd-primary">
                {rowId ? (
                  <a href={`#${rowId}`} className="no-underline hover:underline">
                    {field.deprecated ? <s>{name}</s> : name}
                  </a>
                ) : (
                  name
                )}
              </th>
              <td className="px-4 py-3 font-mono text-xs leading-5">
                {field.typeDescriptionLink ? (
                  <a href={field.typeDescriptionLink} className="underline">
                    {fullType}
                  </a>
                ) : (
                  fullType
                )}
              </td>
              <td className="px-4 py-3 text-fd-muted-foreground">
                {field.required ? 'Required' : 'Optional'}
              </td>
              <td className="px-4 py-3">
                <div className="prose prose-no-margin text-sm">{field.description}</div>
                {field.default && (
                  <p className="mt-2 text-xs text-fd-muted-foreground">
                    Default: <span className="font-mono text-fd-foreground">{field.default}</span>
                  </p>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);
