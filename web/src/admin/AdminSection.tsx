import type { ReactNode } from "react";

import { LibraryReadOnlyNotice } from "../guarded/LibraryReadOnlyNotice";
import { Card } from "../ui/Card";

export interface AdminSectionProps {
  title: string;
  /**
   * Shows the heading; off where a frame around the section already names
   * it (the Stage's Downloads overlay).
   */
  showTitle?: boolean;
  /**
   * The section holds guarded actions that write the Library, so it shows
   * the read-only Library notice while those are disabled.
   */
  writesLibrary?: boolean;
  /** The section's own notices (USDB credentials, login failed, …). */
  notices?: ReactNode;
  children: ReactNode;
}

/**
 * One Admin area section: its heading, the place for its notices, and its
 * content. The owning areas fill the content; until then it is a placeholder.
 */
export function AdminSection({
  title,
  showTitle = true,
  writesLibrary = false,
  notices,
  children,
}: AdminSectionProps) {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      {showTitle ? <h2 className="text-3xl font-bold">{title}</h2> : null}
      <div className="flex flex-col gap-3" data-section-notices>
        {writesLibrary ? <LibraryReadOnlyNotice /> : null}
        {notices}
      </div>
      <Card radius="small" className="p-5 text-lg text-ink-2">
        {children}
      </Card>
    </section>
  );
}
