// The Admin area's Library problems section (v1 spec #46, "Library
// problems"): every rejected file, every warning and every hidden duplicate,
// with its path and its reason, and the Rescan button. Nothing here is guarded: anyone in the
// Party can see why a Song they copied in does not show up, and rescan.
//
// The list and the scan state refresh only from the server's `library`
// change notice, which a finished scan sends (`QUERIES_BY_TOPIC`); nothing
// polls.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../api/api";
import { libraryProblemsQuery, scanStatusQuery } from "../api/queries";
import type { LibraryProblem } from "../generated/LibraryProblem";
import type { ProblemSeverity } from "../generated/ProblemSeverity";
import type { ScanStatus } from "../generated/ScanStatus";
import { problemReasonText } from "../i18n/serverText";
import { type MessageKey, t } from "../i18n/t";
import { Button } from "../ui/Button";
import { AdminSection } from "./AdminSection";

/**
 * The scan state to keep once the Rescan's answer arrives. The answer is the
 * state when the Rescan started; if the scan's finished notice got here
 * first, the cache already knows a later scan and keeps it.
 */
export function afterRescan(
  cached: ScanStatus | undefined,
  answer: ScanStatus,
): ScanStatus {
  return cached !== undefined && cached.finished > answer.finished
    ? cached
    : answer;
}

export function LibraryProblems() {
  const problems = useQuery(libraryProblemsQuery);
  return (
    <AdminSection title={t("admin.libraryProblems")}>
      <div className="flex flex-col gap-4">
        <p>{t("admin.libraryProblems.intro")}</p>
        <Rescan />
        {problems.data ? (
          <ProblemList problems={problems.data} />
        ) : (
          <p className="py-4 text-center">
            {t(
              problems.isError
                ? "admin.libraryProblems.failed"
                : "admin.libraryProblems.loading",
            )}
          </p>
        )}
      </div>
    </AdminSection>
  );
}

function Rescan() {
  const queryClient = useQueryClient();
  const scan = useQuery(scanStatusQuery);
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const running = starting || scan.data?.running === true;

  const rescan = async () => {
    setStarting(true);
    setFailed(false);
    try {
      const answer = await api("POST /api/library/rescan");
      queryClient.setQueryData(scanStatusQuery.queryKey, (cached) =>
        afterRescan(cached, answer),
      );
    } catch {
      setFailed(true);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Button
        fill="green"
        isDisabled={running}
        onPress={() => {
          void rescan();
        }}
      >
        {t("admin.libraryProblems.rescan")}
      </Button>
      <p role="status" className="font-semibold text-ink">
        {running
          ? t("admin.libraryProblems.scanning")
          : failed
            ? t("admin.libraryProblems.rescanFailed")
            : null}
      </p>
    </div>
  );
}

/** The badge of each severity: a rejection stands out, a hidden duplicate least. */
const SEVERITY_BADGE: Record<
  ProblemSeverity,
  { className: string; label: MessageKey }
> = {
  rejection: {
    className: "bg-warn-bg text-warn-fg",
    label: "admin.libraryProblems.rejection",
  },
  warning: {
    className: "bg-yellow text-on-bright",
    label: "admin.libraryProblems.warning",
  },
  hidden: {
    className: "bg-ledge text-ink",
    label: "admin.libraryProblems.hidden",
  },
};

function ProblemList({ problems }: { problems: LibraryProblem[] }) {
  if (problems.length === 0)
    return (
      <p className="py-4 text-center">{t("admin.libraryProblems.none")}</p>
    );
  return (
    <ul
      aria-label={t("admin.libraryProblems.list")}
      className="flex flex-col divide-y-2 divide-ledge"
    >
      {problems.map((problem, index) => (
        <li
          // A file can have several problems, and the list has no ids.
          key={`${problem.path}#${String(index)}`}
          className="flex min-w-0 flex-col gap-1 py-3 first:pt-0 last:pb-0"
        >
          <div className="flex min-w-0 items-start gap-2">
            <span
              className={`shrink-0 rounded-full px-2.5 py-0.5 text-sm font-semibold ${SEVERITY_BADGE[problem.severity].className}`}
            >
              {t(SEVERITY_BADGE[problem.severity].label)}
            </span>
            <span className="min-w-0 font-semibold text-ink [overflow-wrap:anywhere]">
              {problem.path}
            </span>
          </div>
          <span className="[overflow-wrap:anywhere]">
            {problemReasonText(problem.reason)}
          </span>
        </li>
      ))}
    </ul>
  );
}
