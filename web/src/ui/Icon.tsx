import { iconVar, type IconName } from "../icons/icons";

export interface IconProps {
  name: IconName;
  /** Tailwind size and colour utilities; the icon takes the text colour. */
  className?: string;
}

/** An interface icon, decorative: label the control that holds it instead. */
export function Icon({ name, className = "size-6" }: IconProps) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 bg-current mask-contain mask-center mask-no-repeat ${className}`}
      style={{ maskImage: iconVar(name) }}
    />
  );
}
