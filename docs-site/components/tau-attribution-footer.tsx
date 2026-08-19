// `order-first` lifts the link above the GitHub/theme row, which fumadocs renders before the footer slot.
export const TauAttributionFooter = (): React.JSX.Element => (
  <a
    className="order-first mb-3 text-xs text-fd-muted-foreground hover:text-fd-foreground"
    href="https://tau.new"
  >
    Part of the Tau ecosystem
  </a>
);
