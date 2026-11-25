import { t } from "../i18n/t";
import { tokenVar } from "../theme/tokens";

/** The star in the logo, on a 24-unit grid. */
const STAR =
  "M12 2l3 6.5 7 .9-5.1 4.8 1.3 7L12 17.8 5.8 21.2l1.3-7L2 9.4l7-.9z";

/** The OpenStar logo for the Phone's top bar: a yellow star and the name. */
export function Logo() {
  return (
    <span className="flex items-center gap-1.5 text-2xl font-bold">
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-7">
        <path
          d={STAR}
          strokeWidth="1.6"
          strokeLinejoin="round"
          style={{
            fill: tokenVar("--color-yellow"),
            stroke: tokenVar("--color-ink"),
          }}
        />
      </svg>
      {t("phone.title")}
    </span>
  );
}

/** The top bar every Phone screen starts with. */
export function TopBar({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex items-center gap-3 px-5 pt-4 pb-2">
      <Logo />
      <span className="grow" />
      {children}
    </header>
  );
}
