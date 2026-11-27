import { Fragment } from "react";

import type { TextPart } from "../i18n/t";
import { BOLD_PARAMS } from "./toastContent";

/** A toast's text, with names and Song titles in bold. */
export function ToastText({ parts }: { parts: readonly TextPart[] }) {
  return (
    <span>
      {parts.map((part, index) =>
        part.param !== undefined && BOLD_PARAMS.has(part.param) ? (
          <b key={index} className="font-bold">
            {part.text}
          </b>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </span>
  );
}
