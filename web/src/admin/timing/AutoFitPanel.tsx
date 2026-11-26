// The Timing editor's Auto-fit actions (v1 spec #57, "Auto-fit on the
// desktop"): Fit to the singing, the smaller offset only, the fit in plain
// words (`fit/describeFit.ts`, the same words a Phone shows) and the Lines
// still off, each with Go and Apply.

import { Button as AriaButton } from "react-aria-components";

import {
  describeLineSuggestion,
  fitText,
  lineSuggestionText,
  type FitDescription,
} from "../../fit/describeFit";
import type { LineSuggestion } from "../../fit/fit";
import type { ParsedSong } from "../../generated/ParsedSong";
import { t } from "../../i18n/t";

/** What the last fit found: its words and the Lines still off. */
export interface FitOutcome {
  readonly description: FitDescription;
  readonly suggestions: readonly LineSuggestion[];
}

const BIG_BUTTON =
  "rounded-full bg-green px-5 py-2 text-xl font-bold text-ink shadow-ledge-sm outline-none focus-visible:outline-6 focus-visible:outline-yellow disabled:opacity-40";
const SMALL_BUTTON =
  "rounded-full bg-white px-3.5 py-1.5 text-base font-semibold text-ink shadow-ledge-sm outline-none focus-visible:outline-6 focus-visible:outline-yellow disabled:opacity-40";

export function AutoFitPanel({
  ready,
  outcome,
  song,
  onFit,
  onGo,
  onApply,
}: {
  /** Whether the Pitch track is ready: until then both actions are disabled. */
  ready: boolean;
  outcome: FitOutcome | null;
  /** The Song as edited, for the Lines' lyrics. */
  song: Pick<ParsedSong, "voices">;
  onFit: (options: { tempo: boolean }) => void;
  onGo: (suggestion: LineSuggestion) => void;
  onApply: (suggestion: LineSuggestion) => void;
}) {
  return (
    <section aria-label={t("timing.fit.title")} className="flex flex-col gap-3">
      <span className="text-lg font-semibold">{t("timing.fit.title")}</span>
      <div className="flex flex-wrap items-center gap-2">
        <AriaButton
          className={BIG_BUTTON}
          isDisabled={!ready}
          onPress={() => {
            onFit({ tempo: true });
          }}
        >
          {t("timing.fit.run")}
        </AriaButton>
        <AriaButton
          className={SMALL_BUTTON}
          isDisabled={!ready}
          onPress={() => {
            onFit({ tempo: false });
          }}
        >
          {t("timing.fit.offsetOnly")}
        </AriaButton>
      </div>
      {ready ? null : (
        <p className="text-sm text-ink-2">{t("timing.fit.pending")}</p>
      )}
      {outcome ? (
        <>
          <FitWords description={outcome.description} />
          <LinesStillOff
            suggestions={outcome.suggestions}
            song={song}
            onGo={onGo}
            onApply={onApply}
          />
        </>
      ) : null}
    </section>
  );
}

function FitWords({ description }: { description: FitDescription }) {
  const [first, second] = fitText(description);
  return (
    <div role="status" className="flex flex-col gap-1">
      <p className="font-semibold">{first}</p>
      {second === undefined ? null : (
        <p>
          {second} {t("timing.fit.check")}
        </p>
      )}
    </div>
  );
}

function LinesStillOff({
  suggestions,
  song,
  onGo,
  onApply,
}: {
  suggestions: readonly LineSuggestion[];
  song: Pick<ParsedSong, "voices">;
  onGo: (suggestion: LineSuggestion) => void;
  onApply: (suggestion: LineSuggestion) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-lg font-semibold">
        {t("timing.fit.linesStillOff")}
      </span>
      {suggestions.length === 0 ? (
        <p className="text-ink-2">{t("timing.fit.noLineStandsOut")}</p>
      ) : (
        <ul
          aria-label={t("timing.fit.linesStillOff")}
          className="flex max-h-56 flex-col gap-2 overflow-y-auto"
        >
          {suggestions.map((s) => (
            <li
              key={`${String(s.voice)}:${String(s.line)}`}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="min-w-0 grow tabular-nums">
                {lineSuggestionText(describeLineSuggestion(s, song))}
              </span>
              <AriaButton
                className={SMALL_BUTTON}
                onPress={() => {
                  onGo(s);
                }}
              >
                {t("timing.fit.go")}
              </AriaButton>
              <AriaButton
                className={SMALL_BUTTON}
                onPress={() => {
                  onApply(s);
                }}
              >
                {t("timing.fit.apply")}
              </AriaButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
